import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { dataDir } from './helpers.ts';
import type { Episode } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { audioPath, loadEpisodes, updateEpisode } from '../server/store.ts';

const app = createApp();
const host = `localhost:${config.port}`;
const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { host, ...(init.headers as Record<string, string>) } });

before(loadEpisodes);
after(() => rmSync(dataDir, { recursive: true, force: true }));

async function newEpisode(): Promise<Episode> {
  return (await call('/api/episodes', { method: 'POST' })).json() as Promise<Episode>;
}

test('foreign hosts and origins cannot reach the API', async () => {
  assert.equal((await app.request('/api/episodes', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await call('/api/episodes', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/episodes', { headers: { origin: `http://${host}` } })).status, 200);
});

test('brief updates are clamped to the 15 minute limit and known values', async () => {
  const episode = await newEpisode();
  const patch = (body: object) => call(`/api/episodes/${episode.id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const updated = (await (await patch({ targetMinutes: 90, language: 'xx', model: 'gpt-6-astra', topic: 'Sopky' })).json()) as Episode;
  assert.equal(updated.brief.targetMinutes, 15);
  assert.equal(updated.brief.language, 'sk');
  assert.equal(updated.brief.model, 'claude-opus-5-5');
  assert.equal(updated.brief.topic, 'Sopky');
});

test('markdown upload extracts text, unsupported files are refused', async () => {
  const episode = await newEpisode();
  const upload = (name: string, content: string) => {
    const form = new FormData();
    form.append('file', new File([content], name));
    return call(`/api/episodes/${episode.id}/sources`, { method: 'POST', body: form });
  };
  const ok = await upload('../../poznamky.md', '﻿# Nadpis\r\n\r\n\r\n\r\nText so znakmi ľščťžýáíé');
  assert.equal(ok.status, 201);
  const [source] = ((await ok.json()) as Episode).sources;
  assert.equal(source.kind, 'markdown');
  assert.ok(source.chars > 10);
  assert.equal((await upload('virus.exe', 'x')).status, 422);
  assert.equal((await upload('prazdny.md', '   \n')).status, 422);
});

test('PDF upload extracts its text layer, a broken PDF is refused', async () => {
  const episode = await newEpisode();
  const send = (bytes: Uint8Array, name: string) => {
    const form = new FormData();
    form.append('file', new File([bytes as BlobPart], name));
    return call(`/api/episodes/${episode.id}/sources`, { method: 'POST', body: form });
  };
  assert.equal((await send(minimalPdf('Sopky su fascinujuce'), 'a.pdf')).status, 201);
  assert.equal((await send(new TextEncoder().encode('not a pdf'), 'b.pdf')).status, 422);
});

test('an unknown episode id is a 404 and cannot traverse the filesystem', async () => {
  assert.equal((await call('/api/episodes/nope')).status, 404);
  assert.equal((await call('/api/episodes/..%2F..%2Fetc/audio')).status, 404);
});

test('rendering is refused until the producer approves the current cost', async () => {
  const episode = await newEpisode();
  await updateEpisode(episode.id, (e) => {
    e.brief.hosts.A.voiceId = 'a';
    e.brief.hosts.B.voiceId = 'b';
    e.script = { title: 'T', summary: '', turns: [{ id: '1', speaker: 'A', text: 'Ahoj' }, { id: '2', speaker: 'B', text: 'Cau' }] };
  });
  const post = (body: object) => call(`/api/episodes/${episode.id}/render`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert.equal((await post({})).status, 409);
  assert.equal((await post({ approvedChars: 1 })).status, 409);
});

test('audio supports the range requests that seeking needs', async () => {
  const episode = await newEpisode();
  writeFileSync(audioPath(episode.id), Buffer.from('0123456789'));
  await updateEpisode(episode.id, (e) => {
    e.audio = { scriptHash: '', bytes: 10, sha256: 'x', seconds: 1, integratedLufs: null, truePeakDb: null, tempo: 1, createdAt: '' };
  });
  const url = `/api/episodes/${episode.id}/audio`;
  const full = await call(url);
  assert.equal(full.status, 200);
  const partial = await call(url, { headers: { range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  assert.equal((await call(url, { headers: { range: 'bytes=20-' } })).status, 416);
});

test('the writer project denies every tool, for all agents and all matchers', () => {
  const settings = JSON.parse(readFileSync(`${config.writerWorkspace}/.claude/settings.json`, 'utf8'));
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'mcp__*']) {
    assert.ok(settings.permissions.deny.includes(tool), tool);
  }
  const [hook] = settings.hooks.PreToolUse;
  assert.equal(hook.matcher, '*');
  assert.match(hook.hooks[0].command, /exit 2/);
});

function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
