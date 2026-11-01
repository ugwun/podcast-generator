import { readFile } from 'node:fs/promises';
import type { Voice } from '../shared/types.ts';
import { config } from './config.ts';

export const DIALOGUE_ENDPOINT = '/v1/text-to-dialogue';

export interface DialoguePayload {
  inputs: { text: string; voice_id: string }[];
  model_id: string;
  language_code: string;
  seed: number;
}

export interface DialogueResult {
  audio: Uint8Array;
  contentType: string;
  characterCost: number | null;
  requestId: string | null;
  historyItemId: string | null;
}

// `definite` means ElevenLabs refused the request, so nothing was billed. Everything else may have been.
export class ElevenLabsError extends Error {
  definite: boolean;
  constructor(message: string, definite: boolean) {
    super(message);
    this.definite = definite;
  }
}

async function apiKey(): Promise<string | null> {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    const file = await readFile(config.elevenLabsKeyFile, 'utf8');
    return file.match(/^\s*ELEVENLABS_API_KEY=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function requireKey(): Promise<string> {
  const key = await apiKey();
  if (!key) throw new ElevenLabsError('Chyba ElevenLabs API kluc.', true);
  return key;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${config.elevenLabsBaseUrl}${path}`, {
    headers: { 'xi-api-key': await requireKey() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const missing = (await response.text().catch(() => '')).match(/missing the permission (\w+)/)?.[1];
    throw new ElevenLabsError(missing ? `Klucu chyba pravo ${missing}` : `ElevenLabs vratil ${response.status} pre ${path.split('?')[0]}`, true);
  }
  return response.json() as Promise<T>;
}

export async function quotaRemaining(): Promise<number | null> {
  try {
    const usage = await getJson<{ character_count: number; character_limit: number }>('/v1/user/subscription');
    return usage.character_limit - usage.character_count;
  } catch {
    return null;
  }
}

export async function elevenLabsStatus(): Promise<{ ok: boolean; detail: string; quotaRemaining: number | null }> {
  if (!(await apiKey())) return { ok: false, detail: 'Chyba API kluc', quotaRemaining: null };
  try {
    await getJson('/v2/voices?page_size=1');
    return { ok: true, detail: 'Pripojene', quotaRemaining: await quotaRemaining() };
  } catch (error) {
    return { ok: false, detail: (error as Error).message, quotaRemaining: null };
  }
}

export async function listVoices(): Promise<Voice[]> {
  const voices: Voice[] = [];
  let token = '';
  do {
    const page = await getJson<{
      voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string>; preview_url?: string | null }[];
      has_more: boolean;
      next_page_token?: string | null;
    }>(`/v2/voices?page_size=100&sort=name&sort_direction=asc${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`);
    for (const voice of page.voices) {
      voices.push({
        id: voice.voice_id,
        name: voice.name,
        category: voice.category ?? '',
        labels: voice.labels ?? {},
        previewUrl: voice.preview_url ?? null,
      });
    }
    token = page.has_more ? (page.next_page_token ?? '') : '';
  } while (token);
  return voices;
}

export async function createDialogue(payload: DialoguePayload): Promise<DialogueResult> {
  const key = await requireKey();
  let response: Response;
  try {
    response = await fetch(`${config.elevenLabsBaseUrl}${DIALOGUE_ENDPOINT}?output_format=${config.outputFormat}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.elevenLabsTimeoutMs),
    });
  } catch (error) {
    throw new ElevenLabsError(`Poziadavka nedobehla: ${(error as Error).message}`, false);
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300);
    throw new ElevenLabsError(`ElevenLabs vratil ${response.status}: ${body}`, response.status < 500);
  }
  let audio: Uint8Array;
  try {
    audio = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new ElevenLabsError(`Audio sa nepodarilo stiahnut: ${(error as Error).message}`, false);
  }
  const cost = response.headers.get('character-cost');
  return {
    audio,
    contentType: response.headers.get('content-type') ?? '',
    characterCost: cost === null || !Number.isFinite(Number(cost)) ? null : Number(cost),
    requestId: response.headers.get('request-id'),
    historyItemId: response.headers.get('history-item-id'),
  };
}
