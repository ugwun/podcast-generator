import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppStatus, Brief, Episode, Script, Speaker, Voice } from '../shared/types.ts';
import { LANGUAGES, MAX_MINUTES, MIN_MINUTES, SCRIPT_MODELS } from '../shared/types.ts';
import { config } from './config.ts';
import { elevenLabsStatus, listVoices } from './elevenlabs.ts';
import { extractSourceText, sourceKind, UnsupportedFileError } from './extract.ts';
import { buildPlan, startRender } from './render.ts';
import { generateScript, reviseScript } from './script.ts';
import { audioPath, createEpisode, deleteEpisode, getEpisode, listEpisodes, sourcesDir, updateEpisode } from './store.ts';
import { t3Status } from './t3.ts';

type Env = { Variables: { episode: Episode } };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const VOICE_CACHE_MS = 10 * 60_000;

let voiceCache: { at: number; voices: Voice[] } | null = null;

// The API can spend money, so only this machine's own pages may call it. This blocks DNS rebinding and cross-site POSTs.
async function localOnly(c: Context, next: Next) {
  const allowed = [`localhost:${config.port}`, `127.0.0.1:${config.port}`, 'localhost:5173', '127.0.0.1:5173'];
  if (!allowed.includes(c.req.header('host') ?? '')) return c.text('Forbidden', 403);
  const origin = c.req.header('origin');
  if (origin && !allowed.includes(origin.replace(/^https?:\/\//, ''))) return c.text('Forbidden', 403);
  await next();
}

function clean(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function mergeBrief(current: Brief, patch: Partial<Brief>): Brief {
  const minutes = Number(patch.targetMinutes ?? current.targetMinutes);
  const hosts = { ...current.hosts };
  for (const speaker of ['A', 'B'] as Speaker[]) {
    const next = patch.hosts?.[speaker];
    if (!next) continue;
    hosts[speaker] = {
      name: clean(next.name, hosts[speaker].name, 60),
      persona: clean(next.persona, hosts[speaker].persona, 400),
      voiceId: clean(next.voiceId, hosts[speaker].voiceId, 80),
      voiceName: clean(next.voiceName, hosts[speaker].voiceName, 120),
    };
  }
  return {
    topic: clean(patch.topic, current.topic, 2000),
    language: LANGUAGES.some((item) => item.code === patch.language) ? patch.language! : current.language,
    targetMinutes: Number.isFinite(minutes) ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(minutes))) : current.targetMinutes,
    tone: clean(patch.tone, current.tone, 40),
    model: SCRIPT_MODELS.some((item) => item.id === patch.model) ? patch.model! : current.model,
    hosts,
  };
}

function parseScriptBody(body: Partial<Script>): Script | null {
  if (!Array.isArray(body.turns)) return null;
  const turns = body.turns.map((turn) => ({
    id: typeof turn?.id === 'string' && turn.id ? turn.id : randomUUID(),
    speaker: turn?.speaker === 'B' ? ('B' as const) : ('A' as const),
    text: clean(turn?.text, '', 4000),
  }));
  return { title: clean(body.title, '', 200), summary: clean(body.summary, '', 1000), turns };
}

const busy = (episode: Episode) => episode.scriptJob.state === 'running' || episode.render.state === 'running';

export function createApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', localOnly);

  app.get('/api/status', async (c) => {
    const [t3, elevenlabs] = await Promise.all([t3Status(), elevenLabsStatus()]);
    return c.json<AppStatus>({ t3, elevenlabs });
  });

  app.get('/api/voices', async (c) => {
    if (!voiceCache || Date.now() - voiceCache.at > VOICE_CACHE_MS) {
      try {
        voiceCache = { at: Date.now(), voices: await listVoices() };
      } catch (error) {
        return c.json({ error: (error as Error).message }, 502);
      }
    }
    return c.json(voiceCache.voices);
  });

  app.get('/api/episodes', (c) => c.json(listEpisodes()));
  app.post('/api/episodes', async (c) => c.json(await createEpisode(), 201));

  app.use('/api/episodes/:id/*', loadEpisode);
  app.use('/api/episodes/:id', loadEpisode);

  app.get('/api/episodes/:id', (c) => c.json(c.get('episode')));

  app.patch('/api/episodes/:id', async (c) => {
    const patch = await c.req.json<Partial<Brief>>();
    if (busy(c.get('episode'))) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    return c.json(await updateEpisode(c.get('episode').id, (e) => (e.brief = mergeBrief(e.brief, patch))));
  });

  app.delete('/api/episodes/:id', async (c) => {
    if (busy(c.get('episode'))) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    await deleteEpisode(c.get('episode').id);
    return c.body(null, 204);
  });

  app.post('/api/episodes/:id/sources', async (c) => {
    const episode = c.get('episode');
    const body = await c.req.parseBody();
    if (busy(episode)) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'Chyba subor.' }, 400);
    if (file.size > config.maxUploadBytes) return c.json({ error: 'Subor je vacsi ako 50 MB.' }, 413);
    try {
      const kind = sourceKind(file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await extractSourceText(file.name, bytes);
      const id = randomUUID();
      await writeFile(join(sourcesDir(episode.id), `${id}.txt`), text);
      await writeFile(join(sourcesDir(episode.id), `${id}${extname(file.name).toLowerCase()}`), bytes);
      return c.json(
        await updateEpisode(episode.id, (e) => {
          e.sources.push({ id, name: file.name.slice(0, 200), kind, bytes: file.size, chars: text.length });
        }),
        201,
      );
    } catch (error) {
      if (error instanceof UnsupportedFileError) return c.json({ error: error.message }, 422);
      return c.json({ error: `Subor ${file.name} sa nepodarilo precitat.` }, 422);
    }
  });

  app.delete('/api/episodes/:id/sources/:source', async (c) => {
    const episode = c.get('episode');
    if (busy(episode)) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    const source = episode.sources.find((item) => item.id === c.req.param('source'));
    if (!source) return c.json({ error: 'Zdroj neexistuje.' }, 404);
    await rm(join(sourcesDir(episode.id), `${source.id}.txt`), { force: true });
    await rm(join(sourcesDir(episode.id), `${source.id}${extname(source.name).toLowerCase()}`), { force: true });
    return c.json(await updateEpisode(episode.id, (e) => (e.sources = e.sources.filter((item) => item.id !== source.id))));
  });

  app.post('/api/episodes/:id/script', (c) => {
    const episode = c.get('episode');
    if (busy(episode)) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    if (!episode.brief.topic.trim() && !episode.sources.length) return c.json({ error: 'Zadaj temu alebo nahraj zdroj.' }, 400);
    generateScript(episode.id);
    return c.json({ started: true }, 202);
  });

  app.post('/api/episodes/:id/script/revise', async (c) => {
    const episode = c.get('episode');
    const { instruction } = await c.req.json<{ instruction?: string }>();
    if (busy(episode)) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    if (!instruction?.trim()) return c.json({ error: 'Napis, co sa ma zmenit.' }, 400);
    reviseScript(episode.id, instruction.slice(0, 4000));
    return c.json({ started: true }, 202);
  });

  app.put('/api/episodes/:id/script', async (c) => {
    const episode = c.get('episode');
    const script = parseScriptBody(await c.req.json<Partial<Script>>());
    if (busy(episode)) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    if (!script) return c.json({ error: 'Neplatny skript.' }, 400);
    return c.json(await updateEpisode(episode.id, (e) => (e.script = script)));
  });

  app.get('/api/episodes/:id/render/plan', async (c) => c.json(await buildPlan(c.get('episode'))));

  app.post('/api/episodes/:id/render', async (c) => {
    const episode = c.get('episode');
    const { approvedChars, retryHashes } = await c.req.json<{ approvedChars?: number; retryHashes?: string[] }>();
    const plan = await buildPlan(episode);
    // Checked after every await: a second request may have started in the meantime.
    if (busy(episode)) return c.json({ error: 'Epizoda sa prave spracuva.' }, 409);
    if (plan.blockers.length) return c.json({ error: plan.blockers.join(' ') }, 409);
    if (typeof approvedChars !== 'number' || approvedChars < plan.newChars) {
      return c.json({ error: `Skript sa zmenil, treba schvalit ${plan.newChars} znakov.` }, 409);
    }
    startRender(episode.id, approvedChars, Array.isArray(retryHashes) ? retryHashes : []);
    return c.json({ started: true }, 202);
  });

  app.get('/api/episodes/:id/audio', async (c) => {
    const episode = c.get('episode');
    if (!episode.audio) return c.json({ error: 'Audio este neexistuje.' }, 404);
    return streamFile(c, audioPath(episode.id), episode.brief.topic || episode.script?.title || 'podcast');
  });

  app.get('*', serveWeb);
  return app;
}

async function loadEpisode(c: Context<Env>, next: Next) {
  const episode = getEpisode(c.req.param('id') ?? '');
  if (!episode) return c.json({ error: 'Epizoda neexistuje.' }, 404);
  c.set('episode', episode);
  await next();
}

// Browsers need Range support to seek in an <audio> element.
async function streamFile(c: Context, path: string, name: string) {
  const { size } = await stat(path);
  const headers: Record<string, string> = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' };
  if (c.req.query('download') !== undefined) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.mp3`)}`;
  }
  const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range || (!range[1] && !range[2])) {
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, { ...headers, 'content-length': String(size) });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return c.body(null, 416, { 'content-range': `bytes */${size}` });
  return c.body(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, 206, {
    ...headers,
    'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${size}`,
  });
}

async function serveWeb(c: Context) {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Neznama cesta.' }, 404);
  const relative = normalize(decodeURIComponent(c.req.path)).replace(/^[/\\]+/, '');
  const path = join(config.webDir, relative || 'index.html');
  if (path !== config.webDir && !path.startsWith(config.webDir + sep)) return c.text('Forbidden', 403);
  for (const candidate of [path, join(config.webDir, 'index.html')]) {
    try {
      return c.body(await readFile(candidate), 200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
    } catch {
      // Unknown paths fall through to the single-page app.
    }
  }
  return c.text('Web este nie je zostaveny. Spusti npm run build.', 503);
}
