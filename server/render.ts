import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Episode, RenderPlan, SegmentState } from '../shared/types.ts';
import { MAX_SECONDS, MAX_SEGMENT_CHARS, scriptChars } from '../shared/types.ts';
import { joinSegments, measureDuration, measureLoudness } from './audio.ts';
import { config } from './config.ts';
import type { DialoguePayload, DialogueResult } from './elevenlabs.ts';
import { createDialogue, DIALOGUE_ENDPOINT, ElevenLabsError, quotaRemaining } from './elevenlabs.ts';
import { validateScript } from './script.ts';
import { atomicWrite, audioPath, getEpisode, ledgerPath, segmentsDir, updateEpisode } from './store.ts';

export const MAX_TEMPO = 1.05;
const MIN_SEGMENT_CHARS = 900;

export interface PlannedSegment {
  hash: string;
  chars: number;
  payload: DialoguePayload;
}

interface SegmentRecord {
  hash: string;
  endpoint: string;
  outputFormat: string;
  payload: DialoguePayload;
  status: 'pending' | 'complete' | 'failed' | 'unresolved';
  createdAt: string;
  updatedAt: string;
  error?: string;
  requestId?: string | null;
  historyItemId?: string | null;
  characterCost?: number | null;
  contentType?: string;
  bytes?: number;
  sha256?: string;
  seconds?: number;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const recordPath = (id: string, hash: string) => join(segmentsDir(id), `${hash}.json`);
const clipPath = (id: string, hash: string) => join(segmentsDir(id), `${hash}.mp3`);

export function scriptHash(episode: Episode): string {
  const { script, brief } = episode;
  return sha256(JSON.stringify([script?.turns.map((t) => [t.speaker, t.text]), brief.language, brief.hosts.A.voiceId, brief.hosts.B.voiceId, config.elevenLabsModel]));
}

// Boundaries depend on the turn id, not on running totals, so editing one turn keeps later segments (and their paid audio) intact.
export function planSegments(episode: Episode): PlannedSegment[] {
  const { script, brief } = episode;
  if (!script) return [];
  const seed = Number.parseInt(episode.id.slice(0, 8), 16);
  const groups: typeof script.turns[] = [];
  let current: typeof script.turns = [];
  let chars = 0;
  for (const turn of script.turns) {
    if (current.length && chars + turn.text.length > MAX_SEGMENT_CHARS) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(turn);
    chars += turn.text.length;
    if (chars >= MIN_SEGMENT_CHARS && Number.parseInt(sha256(turn.id).slice(0, 4), 16) % 3 === 0) {
      groups.push(current);
      current = [];
      chars = 0;
    }
  }
  if (current.length) groups.push(current);

  return groups.map((turns) => {
    const payload: DialoguePayload = {
      inputs: turns.map((turn) => ({ text: turn.text, voice_id: brief.hosts[turn.speaker].voiceId })),
      model_id: config.elevenLabsModel,
      language_code: brief.language,
      seed,
    };
    return {
      payload,
      chars: turns.reduce((sum, turn) => sum + turn.text.length, 0),
      hash: sha256(JSON.stringify({ endpoint: DIALOGUE_ENDPOINT, outputFormat: config.outputFormat, payload })),
    };
  });
}

async function readRecord(id: string, hash: string): Promise<SegmentRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(id, hash), 'utf8'));
  } catch {
    return null;
  }
}

const writeRecord = (id: string, record: SegmentRecord) =>
  atomicWrite(recordPath(id, record.hash), JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2));

// File existence alone is not a cache hit: the bytes must match what was validated.
async function isValidClip(id: string, record: SegmentRecord | null): Promise<boolean> {
  if (record?.status !== 'complete' || !record.sha256) return false;
  try {
    return sha256(await readFile(clipPath(id, record.hash))) === record.sha256;
  } catch {
    return false;
  }
}

interface LedgerEntry {
  attemptId?: string;
  episodeId: string;
  hash: string;
  chars: number;
  outcome: 'pending' | 'generated' | 'rejected' | 'unresolved';
  characterCost?: number | null;
  requestId?: string | null;
}

async function appendLedger(entry: LedgerEntry) {
  await mkdir(dirname(ledgerPath()), { recursive: true });
  await appendFile(ledgerPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// Credits spent on one episode. An attempt with no known cost counts in full, because it may have been billed.
export async function spentCredits(episodeId: string): Promise<number> {
  let text = '';
  try {
    text = await readFile(ledgerPath(), 'utf8');
  } catch {
    return 0;
  }
  // Entries are append-only, so the last one for an attempt is its outcome.
  const attempts = new Map<string, LedgerEntry>();
  text.split('\n').filter(Boolean).forEach((line, index) => {
    const entry: LedgerEntry = JSON.parse(line);
    if (entry.episodeId === episodeId) attempts.set(entry.attemptId ?? `line-${index}`, entry);
  });
  return [...attempts.values()]
    .filter((entry) => entry.outcome !== 'rejected')
    .reduce((sum, entry) => sum + (entry.characterCost ?? entry.chars), 0);
}

export async function buildPlan(episode: Episode): Promise<RenderPlan> {
  const planned = planSegments(episode);
  const segments: SegmentState[] = [];
  let newChars = 0;
  for (const segment of planned) {
    const record = await readRecord(episode.id, segment.hash);
    if (await isValidClip(episode.id, record)) {
      segments.push({ hash: segment.hash, chars: segment.chars, status: 'complete', cached: true, seconds: record?.seconds });
      continue;
    }
    newChars += segment.chars;
    const uncertain = record?.status === 'pending' || record?.status === 'unresolved';
    segments.push({ hash: segment.hash, chars: segment.chars, status: uncertain ? 'unresolved' : 'queued', error: record?.error });
  }

  const blockers: string[] = [];
  const { brief, script } = episode;
  if (!script) blockers.push('Epizoda este nema skript.');
  else blockers.push(...validateScript(script));
  if (!brief.hosts.A.voiceId || !brief.hosts.B.voiceId) blockers.push('Vyber hlas pre oboch moderatorov.');

  return {
    scriptHash: scriptHash(episode),
    totalChars: script ? scriptChars(script) : 0,
    newChars,
    segments,
    blockers,
    quotaRemaining: newChars ? await quotaRemaining() : null,
    spentCredits: await spentCredits(episode.id),
  };
}

class RenderStop extends Error {}

export function startRender(id: string, approvedChars: number, retryHashes: string[]): void {
  void renderEpisode(id, approvedChars, new Set(retryHashes)).catch(async (error) => {
    if (!getEpisode(id)) return;
    const blocked = error instanceof RenderStop;
    await updateEpisode(id, (e) => {
      e.render.state = blocked ? 'blocked' : 'failed';
      e.render.stage = undefined;
      e.render.error = (error as Error).message;
    });
  });
}

async function renderEpisode(id: string, approvedChars: number, retry: Set<string>): Promise<void> {
  const current = getEpisode(id);
  if (!current) return;
  // Everything below works from this copy, so the finished audio is labeled with what was actually rendered.
  const snapshot = structuredClone(current);
  const planned = planSegments(snapshot);
  const renderedHash = scriptHash(snapshot);
  const setSegment = (index: number, patch: Partial<SegmentState>) =>
    updateEpisode(id, (e) => Object.assign(e.render.segments[index], patch));

  await updateEpisode(id, (e) => {
    e.render = {
      state: 'running',
      stage: 'Generujem hlasy',
      approvedChars,
      segments: planned.map((segment) => ({ hash: segment.hash, chars: segment.chars, status: 'queued' })),
    };
  });

  let spent = 0;
  let seconds = 0;
  let measuredChars = 0;
  const totalChars = planned.reduce((sum, segment) => sum + segment.chars, 0);

  for (const [index, segment] of planned.entries()) {
    if (!getEpisode(id)) return;
    const { hash, chars, payload } = segment;
    const existing = await readRecord(id, hash);
    if (existing && (await isValidClip(id, existing))) {
      await setSegment(index, { status: 'complete', cached: true, seconds: existing.seconds });
      seconds += existing.seconds ?? 0;
      measuredChars += chars;
      continue;
    }

    const uncertain = existing?.status === 'pending' || existing?.status === 'unresolved';
    if (uncertain && !retry.has(hash)) {
      await setSegment(index, { status: 'unresolved', error: existing?.error });
      throw new RenderStop(`Stav segmentu ${index + 1} je neisty a mohol byt uctovany. Over ho v historii ElevenLabs a az potom ho povol znova.`);
    }
    if (spent + chars > approvedChars) throw new RenderStop(`Segment ${index + 1} by presiahol schvalenych ${approvedChars} znakov.`);

    if (measuredChars) {
      const projected = seconds + ((totalChars - measuredChars) * seconds) / measuredChars;
      if (projected > MAX_SECONDS * MAX_TEMPO) {
        throw new RenderStop(`Podla doterajsieho audia by mal podcast ${Math.round(projected / 60)} minut. Skrat skript, hotove segmenty sa znova pouziju.`);
      }
    }

    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const record: SegmentRecord = { hash, endpoint: DIALOGUE_ENDPOINT, outputFormat: config.outputFormat, payload, status: 'pending', createdAt, updatedAt: createdAt };
    const attempt = { attemptId: randomUUID(), episodeId: id, hash, chars };
    await writeRecord(id, record);
    await appendLedger({ ...attempt, outcome: 'pending' });
    await setSegment(index, { status: 'pending', error: undefined });

    let result: DialogueResult;
    try {
      result = await createDialogue(payload);
    } catch (error) {
      const definite = error instanceof ElevenLabsError && error.definite;
      const message = (error as Error).message;
      await appendLedger({ ...attempt, outcome: definite ? 'rejected' : 'unresolved' });
      await writeRecord(id, { ...record, status: definite ? 'failed' : 'unresolved', error: message });
      await setSegment(index, { status: definite ? 'failed' : 'unresolved', error: message });
      throw new RenderStop(`Segment ${index + 1}: ${message}`);
    }

    await appendLedger({ ...attempt, outcome: 'generated', characterCost: result.characterCost, requestId: result.requestId });
    spent += result.characterCost ?? chars;
    const evidence = { requestId: result.requestId, historyItemId: result.historyItemId, characterCost: result.characterCost, contentType: result.contentType, bytes: result.audio.length };

    try {
      if (!result.contentType.startsWith('audio/')) throw new Error(`odpoved nie je audio (${result.contentType || 'bez typu'})`);
      const tmp = `${clipPath(id, hash)}.part`;
      await writeFile(tmp, result.audio);
      const clipSeconds = await measureDuration(tmp);
      await rename(tmp, clipPath(id, hash));
      await writeRecord(id, { ...record, ...evidence, status: 'complete', sha256: sha256(result.audio), seconds: clipSeconds });
      await setSegment(index, { status: 'complete', cached: false, seconds: clipSeconds });
      seconds += clipSeconds;
      measuredChars += chars;
    } catch (error) {
      // This request was billed, so repeating it needs the same explicit consent as any uncertain one.
      const message = `Uctovane audio sa nedalo overit: ${(error as Error).message}`;
      await writeRecord(id, { ...record, ...evidence, status: 'unresolved', error: message });
      await setSegment(index, { status: 'unresolved', error: message });
      throw new RenderStop(`Segment ${index + 1}: ${message}`);
    }
  }

  await finalize(id, planned, seconds, renderedHash);
}

async function finalize(id: string, planned: PlannedSegment[], seconds: number, renderedHash: string): Promise<void> {
  const tempo = seconds > MAX_SECONDS ? seconds / (MAX_SECONDS - 3) : 1;
  if (tempo > MAX_TEMPO) throw new RenderStop(`Audio ma ${Math.round(seconds)} sekund a skratenie by bolo pocut. Skrat skript.`);

  await updateEpisode(id, (e) => (e.render.stage = 'Skladam a normalizujem podcast'));
  const output = audioPath(id);
  const tmp = `${output}.part`;
  await joinSegments(planned.map((segment) => clipPath(id, segment.hash)), tmp, tempo);
  const finalSeconds = await measureDuration(tmp);
  if (finalSeconds > MAX_SECONDS) {
    await rm(tmp, { force: true });
    throw new RenderStop(`Hotovy podcast ma ${Math.round(finalSeconds)} sekund, co je nad limitom 15 minut. Skrat skript.`);
  }
  const loudness = await measureLoudness(tmp);
  const bytes = await readFile(tmp);
  await rename(tmp, output);
  await rm(`${tmp}.txt`, { force: true });
  await updateEpisode(id, (e) => {
    e.audio = {
      scriptHash: renderedHash,
      bytes: bytes.length,
      sha256: sha256(bytes),
      seconds: finalSeconds,
      tempo,
      createdAt: new Date().toISOString(),
      ...loudness,
    };
    e.render.state = 'complete';
    e.render.stage = undefined;
    e.render.error = undefined;
  });
}
