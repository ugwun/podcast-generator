import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { dataDir } from './helpers.ts';
import type { Episode, Turn } from '../shared/types.ts';
import { MAX_SECONDS, MAX_SEGMENT_CHARS } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { buildPlan, planSegments, spentCredits, startRender } from '../server/render.ts';
import { audioPath, createEpisode, getEpisode, ledgerPath, loadEpisodes, segmentsDir, updateEpisode } from '../server/store.ts';

let server: Server;
let requests: { body: { inputs: { text: string; voice_id: string }[]; language_code: string }; key: string | undefined }[] = [];
let respond: (index: number) => { status?: number; hangup?: boolean; contentType?: string; body?: Buffer } = () => ({});

function tone(seconds: number): Buffer {
  const path = join(dataDir, `tone-${randomUUID()}.mp3`);
  execFileSync(ffmpegPath as unknown as string, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '128k', path]);
  const bytes = readFileSync(path);
  rmSync(path);
  return bytes;
}

const clip = tone(2);

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/user/subscription')) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ character_count: 1000, character_limit: 100000 }));
      }
      if (req.method !== 'POST') {
        res.statusCode = 404;
        return res.end();
      }
      const index = requests.length;
      requests.push({ body: JSON.parse(raw), key: req.headers['xi-api-key'] as string });
      const reply = respond(index);
      if (reply.hangup) return req.socket.destroy();
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', reply.contentType ?? 'audio/mpeg');
      res.setHeader('character-cost', String(JSON.parse(raw).inputs.reduce((sum: number, input: { text: string }) => sum + input.text.length, 0)));
      res.setHeader('request-id', `req-${index}`);
      res.end(reply.body ?? clip);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.elevenLabsBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  requests = [];
  respond = () => ({});
  rmSync(ledgerPath(), { force: true });
  await loadEpisodes();
});

function makeTurns(count: number, length = 300): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    speaker: index % 2 ? 'B' : 'A',
    text: `${index} `.padEnd(length, 'slovo '),
  }));
}

async function readyEpisode(turns: Turn[]): Promise<Episode> {
  const episode = await createEpisode();
  return updateEpisode(episode.id, (e) => {
    e.brief.hosts.A.voiceId = 'voice-a';
    e.brief.hosts.B.voiceId = 'voice-b';
    e.script = { title: 'T', summary: 'S', turns };
  });
}

async function render(id: string, approved: number, retry: string[] = []) {
  startRender(id, approved, retry);
  for (let i = 0; i < 12_000; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The state flips in memory first; an empty update waits for that write to reach disk.
    if (getEpisode(id)?.render.state !== 'running') return updateEpisode(id, () => {});
  }
  throw new Error('render did not finish');
}

test('segments stay under the request limit and keep every turn in order', async () => {
  const turns = makeTurns(30);
  const episode = await readyEpisode(turns);
  const segments = planSegments(episode);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => segment.chars <= MAX_SEGMENT_CHARS));
  assert.deepEqual(segments.flatMap((segment) => segment.payload.inputs.map((input) => input.text)), turns.map((turn) => turn.text));
  assert.deepEqual(segments[0].payload.inputs.slice(0, 2).map((input) => input.voice_id), ['voice-a', 'voice-b']);
});

test('editing one turn invalidates only the segment that contains it', async () => {
  const turns = makeTurns(60);
  const episode = await readyEpisode(turns);
  const before = planSegments(episode).map((segment) => segment.hash);
  await updateEpisode(episode.id, (e) => (e.script!.turns[2].text += ' a este par slov navyse, ktore predlzia repliku.'));
  const after = planSegments(getEpisode(episode.id)!).map((segment) => segment.hash);
  assert.equal(before.length, after.length);
  assert.equal(before.filter((hash, index) => hash !== after[index]).length, 1);
});

test('full render writes a validated podcast, and a repeat run spends nothing', async () => {
  const episode = await readyEpisode(makeTurns(12));
  const plan = await buildPlan(episode);
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'complete', done.render.error ?? '');
  assert.equal(requests.length, plan.segments.length);
  assert.equal(requests[0].key, 'test-key');
  assert.equal(requests[0].body.language_code, 'sk');
  assert.ok(done.audio!.seconds > 1.5 * plan.segments.length * 0.9);
  assert.ok(done.audio!.seconds < MAX_SECONDS);
  assert.ok(done.audio!.integratedLufs !== null);
  assert.equal(await spentCredits(episode.id), plan.newChars);

  const again = await buildPlan(done);
  assert.equal(again.newChars, 0);
  await render(episode.id, 0);
  assert.equal(requests.length, plan.segments.length);
});

test('a dropped connection is never retried automatically', async () => {
  const episode = await readyEpisode(makeTurns(12));
  const plan = await buildPlan(episode);
  respond = (index) => (index === 1 ? { hangup: true } : {});
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'blocked');
  assert.equal(requests.length, 2);
  assert.equal(done.render.segments[1].status, 'unresolved');
  assert.equal(done.audio, null);

  const replan = await buildPlan(done);
  assert.equal(replan.segments[1].status, 'unresolved');
  respond = () => ({});
  const stillBlocked = await render(episode.id, replan.newChars);
  assert.equal(stillBlocked.render.state, 'blocked');
  assert.equal(requests.length, 2);

  const finished = await render(episode.id, replan.newChars, [replan.segments[1].hash]);
  assert.equal(finished.render.state, 'complete', finished.render.error ?? '');
  assert.equal(requests.length, 1 + plan.segments.length);
  assert.ok((await spentCredits(episode.id)) > plan.newChars, 'the uncertain attempt stays in the ledger');
});

test('a server crash mid-request surfaces as unresolved, not as a free retry', async () => {
  const episode = await readyEpisode(makeTurns(4));
  const [segment] = planSegments(episode);
  writeFileSync(join(segmentsDir(episode.id), `${segment.hash}.json`), JSON.stringify({ hash: segment.hash, status: 'pending', createdAt: 'x' }));
  const plan = await buildPlan(episode);
  assert.equal(plan.segments[0].status, 'unresolved');
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'blocked');
  assert.equal(requests.length, 0);
});

test('a refused request is safe to retry and is not counted as spending', async () => {
  const episode = await readyEpisode(makeTurns(4));
  const plan = await buildPlan(episode);
  respond = () => ({ status: 422, contentType: 'application/json', body: Buffer.from('{"detail":"bad"}') });
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'blocked');
  assert.equal(done.render.segments[0].status, 'failed');
  assert.equal(await spentCredits(episode.id), 0);
  assert.equal((await buildPlan(done)).segments[0].status, 'queued');
});

test('undecodable audio is billed once and stops the run', async () => {
  const episode = await readyEpisode(makeTurns(12));
  const plan = await buildPlan(episode);
  respond = () => ({ body: Buffer.from('this is not an mp3 file at all') });
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'blocked');
  assert.equal(requests.length, 1);
  assert.equal(await spentCredits(episode.id), plan.segments[0].chars);

  respond = () => ({});
  const replan = await buildPlan(done);
  assert.equal(replan.segments[0].status, 'unresolved', 'a billed bad clip must not look like a free retry');
  const stopped = await render(episode.id, replan.newChars);
  assert.equal(stopped.render.state, 'blocked');
  assert.equal(requests.length, 1);
});

test('the attempt is in the ledger before the request leaves, so a crash cannot hide it', async () => {
  const episode = await readyEpisode(makeTurns(4));
  const plan = await buildPlan(episode);
  let seen = '';
  respond = () => {
    seen = readFileSync(ledgerPath(), 'utf8');
    return { hangup: true };
  };
  await render(episode.id, plan.newChars);
  assert.match(seen, /"outcome":"pending"/);
});

test('a pending attempt counts in full, and one attempt is never counted twice', async () => {
  const { id } = await readyEpisode(makeTurns(1));
  const entry = { episodeId: id, hash: 'h', chars: 1000 };
  writeFileSync(
    ledgerPath(),
    [
      { ...entry, outcome: 'generated', characterCost: 400 },
      { ...entry, attemptId: 'a', outcome: 'pending' },
      { ...entry, attemptId: 'b', outcome: 'pending' },
      { ...entry, attemptId: 'b', outcome: 'generated', characterCost: 300 },
      { ...entry, attemptId: 'c', outcome: 'pending' },
      { ...entry, attemptId: 'c', outcome: 'rejected' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  assert.equal(await spentCredits(id), 400 + 1000 + 300);
});

test('audio is labeled with the script it was rendered from, not a later edit', async () => {
  const episode = await readyEpisode(makeTurns(4));
  const plan = await buildPlan(episode);
  respond = (index) => {
    if (index === 0) getEpisode(episode.id)!.script!.turns[0].text = 'Zmenene pocas generovania';
    return {};
  };
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.audio?.scriptHash, plan.scriptHash);
  assert.notEqual((await buildPlan(done)).scriptHash, plan.scriptHash);
});

test('a save whose body arrives after a render started is refused', async () => {
  const episode = await readyEpisode(makeTurns(4));
  const plan = await buildPlan(episode);
  const app = createApp();
  let finishBody = () => {};
  const body = new ReadableStream({
    start(controller) {
      finishBody = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ title: 'x', summary: '', turns: [] })));
        controller.close();
      };
    },
  });
  const save = app.request(`/api/episodes/${episode.id}/script`, { method: 'PUT', body, headers: { host: `localhost:${config.port}`, 'content-type': 'application/json' }, duplex: 'half' } as RequestInit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  startRender(episode.id, plan.newChars, []);
  finishBody();
  assert.equal((await save).status, 409);
  for (let i = 0; i < 400 && getEpisode(episode.id)?.render.state === 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await updateEpisode(episode.id, () => {});
});
test('spending stops at the approved amount', async () => {
  const episode = await readyEpisode(makeTurns(12));
  const plan = await buildPlan(episode);
  const done = await render(episode.id, plan.segments[0].chars);
  assert.equal(done.render.state, 'blocked');
  assert.equal(requests.length, 1);
});

test('generation stops early when measured audio is heading past the ceiling', async () => {
  const episode = await readyEpisode(makeTurns(30));
  const plan = await buildPlan(episode);
  const long = tone(240);
  respond = () => ({ body: long });
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'blocked');
  assert.match(done.render.error ?? '', /Skrat skript/);
  assert.ok(requests.length < plan.segments.length);
  assert.equal(done.audio, null);
});

test('a small overrun is tempo-fitted under 15 minutes', async () => {
  const episode = await readyEpisode(makeTurns(3));
  const plan = await buildPlan(episode);
  assert.equal(plan.segments.length, 1);
  respond = () => ({ body: tone(MAX_SECONDS + 12) });
  const done = await render(episode.id, plan.newChars);
  assert.equal(done.render.state, 'complete', done.render.error ?? '');
  assert.ok(done.audio!.tempo > 1);
  assert.ok(done.audio!.seconds <= MAX_SECONDS);
  assert.ok(readFileSync(audioPath(episode.id)).length === done.audio!.bytes);
});

test('two simultaneous start requests render only once', async () => {
  const episode = await readyEpisode(makeTurns(4));
  const plan = await buildPlan(episode);
  const app = createApp();
  const post = () =>
    app.request(`/api/episodes/${episode.id}/render`, {
      method: 'POST',
      headers: { host: `localhost:${config.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approvedChars: plan.newChars }),
    });
  const statuses = (await Promise.all([post(), post(), post()])).map((response) => response.status).sort();
  assert.deepEqual(statuses, [202, 409, 409]);
  for (let i = 0; i < 400 && getEpisode(episode.id)?.render.state === 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await updateEpisode(episode.id, () => {});
  assert.equal(requests.length, plan.segments.length);
});
