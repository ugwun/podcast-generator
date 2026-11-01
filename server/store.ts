import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Episode } from '../shared/types.ts';
import { MAX_MINUTES, SCRIPT_MODELS } from '../shared/types.ts';
import { config } from './config.ts';

const episodes = new Map<string, Episode>();
const writes = new Map<string, Promise<void>>();

export const episodeDir = (id: string) => join(config.dataDir, 'episodes', id);
export const sourcesDir = (id: string) => join(episodeDir(id), 'sources');
export const segmentsDir = (id: string) => join(episodeDir(id), 'segments');
export const audioPath = (id: string) => join(episodeDir(id), 'podcast.mp3');
export const ledgerPath = () => join(config.dataDir, 'ledger.jsonl');

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'w', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
}

export async function loadEpisodes(): Promise<void> {
  const root = join(config.dataDir, 'episodes');
  await mkdir(root, { recursive: true });
  episodes.clear();
  for (const id of await readdir(root)) {
    try {
      episodes.set(id, JSON.parse(await readFile(join(root, id, 'episode.json'), 'utf8')));
    } catch {
      console.warn(`Preskakujem epizodu ${id}: chyba episode.json`);
    }
  }
  // Jobs live in this process, so anything still "running" did not survive the restart.
  for (const episode of episodes.values()) {
    if (episode.scriptJob.state === 'running') {
      await updateEpisode(episode.id, (e) => {
        e.scriptJob = { state: 'failed', error: 'Generovanie prerusil restart servera.', threadId: e.scriptJob.threadId };
      });
    }
    if (episode.render.state === 'running') {
      await updateEpisode(episode.id, (e) => {
        e.render.state = 'blocked';
        e.render.stage = undefined;
        e.render.error = 'Audio prerusil restart servera. Skontroluj segmenty a spusti ho znova.';
        for (const segment of e.render.segments) {
          if (segment.status === 'pending') segment.status = 'unresolved';
        }
      });
    }
  }
}

export function listEpisodes(): Episode[] {
  return [...episodes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getEpisode(id: string): Episode | undefined {
  return episodes.get(id);
}

export async function createEpisode(): Promise<Episode> {
  const now = new Date().toISOString();
  const episode: Episode = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    brief: {
      topic: '',
      language: 'sk',
      targetMinutes: Math.min(10, MAX_MINUTES),
      tone: 'friendly',
      model: SCRIPT_MODELS[0].id,
      hosts: {
        A: { name: 'Hana', persona: 'Moderatorka, ktora sa pyta za poslucaca a zrozumitelne zhrna.', voiceId: '', voiceName: '' },
        B: { name: 'Marek', persona: 'Odbornik, ktory vysvetluje na prikladoch a nebal sa nesuhlasit.', voiceId: '', voiceName: '' },
      },
    },
    sources: [],
    script: null,
    scriptJob: { state: 'idle' },
    render: { state: 'idle', approvedChars: 0, segments: [] },
    audio: null,
  };
  await mkdir(sourcesDir(episode.id), { recursive: true });
  await mkdir(segmentsDir(episode.id), { recursive: true });
  episodes.set(episode.id, episode);
  await persist(episode);
  return episode;
}

export async function updateEpisode(id: string, change: (episode: Episode) => void): Promise<Episode> {
  const episode = episodes.get(id);
  if (!episode) throw new Error(`Neznama epizoda ${id}`);
  change(episode);
  episode.updatedAt = new Date().toISOString();
  await persist(episode);
  return episode;
}

export async function deleteEpisode(id: string): Promise<void> {
  episodes.delete(id);
  await writes.get(id);
  writes.delete(id);
  await rm(episodeDir(id), { recursive: true, force: true });
}

// Writes for one episode are chained so an older snapshot can never land after a newer one.
function persist(episode: Episode): Promise<void> {
  const previous = writes.get(episode.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    if (!episodes.has(episode.id)) return;
    return atomicWrite(join(episodeDir(episode.id), 'episode.json'), JSON.stringify(episode, null, 2));
  });
  writes.set(episode.id, next);
  return next;
}
