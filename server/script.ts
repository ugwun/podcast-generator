import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Brief, Episode, Script, Speaker, Turn } from '../shared/types.ts';
import { MAX_SCRIPT_CHARS, MAX_TURN_CHARS, scriptChars } from '../shared/types.ts';
import { config } from './config.ts';
import type { PromptSource } from './prompts.ts';
import { buildCondensePrompt, buildFormatFix, buildLengthFix, buildRevision, buildScriptPrompt, targetChars } from './prompts.ts';
import { getEpisode, sourcesDir, updateEpisode } from './store.ts';
import type { ThreadReply } from './t3.ts';
import { continueThread, startThread } from './t3.ts';

export class ScriptParseError extends Error {}

interface SettledScript {
  script: Script;
  threadId: string;
  warning?: string;
}

const MAX_CORRECTIONS = 2;
const CONDENSE_CONCURRENCY = 3;

export function parseScript(reply: string): Script {
  const text = reply.replace(/^\s*```[a-z]*\n/i, '').replace(/\n```\s*$/, '').trim();
  const lines = text.split('\n');
  const divider = lines.findIndex((line) => line.trim() === '---');
  if (divider < 0) throw new ScriptParseError('missing the --- line after the header');

  const header = lines.slice(0, divider).join('\n');
  const title = header.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim();
  const summary = header.match(/^SUMMARY:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!title) throw new ScriptParseError('missing the TITLE line');

  const turns: Turn[] = [];
  for (const line of lines.slice(divider + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\*{0,2}([AB])\*{0,2}:\*{0,2}\s*(.*)$/);
    if (match) {
      turns.push({ id: randomUUID(), speaker: match[1] as Speaker, text: match[2].trim() });
    } else if (turns.length) {
      turns[turns.length - 1].text += ` ${trimmed}`;
    } else {
      throw new ScriptParseError(`unexpected line before the first turn: ${trimmed.slice(0, 80)}`);
    }
  }
  const spoken = turns.filter((turn) => turn.text);
  if (spoken.length < 2) throw new ScriptParseError('fewer than two spoken turns');
  if (new Set(spoken.map((turn) => turn.speaker)).size < 2) throw new ScriptParseError('only one host speaks');
  return { title, summary, turns: spoken };
}

export function validateScript(script: Script): string[] {
  const problems: string[] = [];
  const longest = Math.max(0, ...script.turns.map((turn) => turn.text.length));
  if (longest > MAX_TURN_CHARS) problems.push(`Najdlhsia replika ma ${longest} znakov, limit je ${MAX_TURN_CHARS}.`);
  if (script.turns.some((turn) => !turn.text.trim())) problems.push('Skript obsahuje prazdnu repliku.');
  if (scriptChars(script) > MAX_SCRIPT_CHARS) problems.push(`Skript ma viac ako ${MAX_SCRIPT_CHARS} znakov, co by presiahlo 15 minut.`);
  return problems;
}

export function lengthIsAcceptable(script: Script, brief: Brief): boolean {
  const chars = scriptChars(script);
  const target = targetChars(brief);
  return chars >= target * 0.85 && chars <= Math.min(target * 1.1, MAX_SCRIPT_CHARS);
}

async function loadSources(episode: Episode): Promise<PromptSource[]> {
  return Promise.all(
    episode.sources.map(async (source) => ({
      name: source.name,
      text: await readFile(join(sourcesDir(episode.id), `${source.id}.txt`), 'utf8'),
    })),
  );
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size) chunks.push(text.slice(start, start + size));
  return chunks;
}

// Sources beyond T3's message limit are condensed in separate threads, so no document is silently cut off.
async function fitSources(episode: Episode, sources: PromptSource[], onStage: (stage: string) => Promise<void>): Promise<PromptSource[]> {
  const total = sources.reduce((sum, source) => sum + source.text.length, 0);
  if (total <= config.promptSourceChars) return sources;
  if (total > config.maxSourceChars) {
    throw new Error(`Zdroje maju ${total} znakov, limit je ${config.maxSourceChars}. Odober cast dokumentov.`);
  }

  const jobs = sources.flatMap((source) => {
    const chunks = chunkText(source.text, config.condenseChunkChars);
    return chunks.map((text, index) => ({ source, text, part: index + 1, parts: chunks.length }));
  });
  const notes: string[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  await onStage(`Skracujem zdroje (0/${jobs.length})`);
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      const { reply } = await startThread({
        title: `Podcast: poznamky ${job.source.name}`,
        model: episode.brief.model,
        message: buildCondensePrompt({ name: job.source.name, text: job.text }, job.part, job.parts, episode.brief),
      });
      notes[index] = reply;
      done += 1;
      await onStage(`Skracujem zdroje (${done}/${jobs.length})`);
    }
  };
  await Promise.all(Array.from({ length: CONDENSE_CONCURRENCY }, worker));

  const condensed = sources.map((source) => ({
    name: `${source.name} (poznamky)`,
    text: jobs.flatMap((job, index) => (job.source === source ? [notes[index]] : [])).join('\n\n'),
  }));
  if (condensed.reduce((sum, source) => sum + source.text.length, 0) > config.promptSourceChars) {
    throw new Error('Zdroje su prilis dlhe aj po skrateni. Odober cast dokumentov.');
  }
  return condensed;
}

// Asks the same thread to repair a bad format or length, so the agent keeps the documents in context.
async function settleScript(first: ThreadReply, brief: Brief, onStage: (stage: string) => Promise<void>): Promise<SettledScript> {
  const { threadId } = first;
  let reply = first.reply;
  let best: Script | null = null;
  let parseError = '';

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt += 1) {
    let fix: string;
    try {
      const script = parseScript(reply);
      if (lengthIsAcceptable(script, brief)) return { script, threadId };
      best = script;
      fix = buildLengthFix(script, brief);
      await onStage('Upravujem dlzku skriptu');
    } catch (error) {
      if (!(error instanceof ScriptParseError)) throw error;
      parseError = error.message;
      fix = buildFormatFix(error.message);
      await onStage('Opravujem format skriptu');
    }
    if (attempt === MAX_CORRECTIONS) break;
    try {
      reply = (await continueThread(threadId, fix)).reply;
    } catch (error) {
      if (!best) throw error;
      break;
    }
  }

  if (!best) throw new Error(`Agent nevratil pouzitelny skript: ${parseError}`);
  return { script: best, threadId, warning: 'Agent sa netrafil do cielovej dlzky. Skontroluj odhad a skript pripadne uprav.' };
}

export function generateScript(id: string): void {
  void run(id, async (episode, onStage) => {
    await onStage('Pripravujem zdroje');
    const sources = await fitSources(episode, await loadSources(episode), onStage);
    await onStage('Agent pise skript');
    const first = await startThread({
      title: `Podcast: ${episode.brief.topic.trim() || episode.sources[0]?.name || 'novy skript'}`,
      model: episode.brief.model,
      message: buildScriptPrompt(episode.brief, sources),
    });
    await updateEpisode(id, (e) => (e.scriptJob.threadId = first.threadId));
    return settleScript(first, episode.brief, onStage);
  });
}

export function reviseScript(id: string, instruction: string): void {
  void run(id, async (episode, onStage) => {
    const { script, scriptJob } = episode;
    if (!script || !scriptJob.threadId) throw new Error('Skript este nema vlakno v T3.');
    await onStage('Agent upravuje skript');
    const reply = await continueThread(scriptJob.threadId, buildRevision(script, episode.brief, instruction));
    return settleScript(reply, episode.brief, onStage);
  });
}

async function run(
  id: string,
  work: (episode: Episode, onStage: (stage: string) => Promise<void>) => Promise<SettledScript>,
): Promise<void> {
  const episode = getEpisode(id);
  if (!episode) return;
  const threadId = episode.scriptJob.threadId;
  const onStage = async (stage: string) => {
    await updateEpisode(id, (e) => (e.scriptJob.stage = stage));
  };
  try {
    await updateEpisode(id, (e) => {
      e.scriptJob = { state: 'running', stage: 'Zacinam', startedAt: new Date().toISOString(), threadId };
    });
    const result = await work(episode, onStage);
    await updateEpisode(id, (e) => {
      e.script = result.script;
      e.scriptJob = { state: 'idle', threadId: result.threadId, warning: result.warning };
    });
  } catch (error) {
    if (!getEpisode(id)) return;
    await updateEpisode(id, (e) => {
      e.scriptJob = { state: 'failed', error: (error as Error).message, threadId: e.scriptJob.threadId };
    });
  }
}
