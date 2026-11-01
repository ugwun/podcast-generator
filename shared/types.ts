export const MAX_MINUTES = 15;
export const MIN_MINUTES = 3;
export const MAX_SECONDS = MAX_MINUTES * 60;

// Measured on a real eleven_v4 render in Slovak: 9276 characters took 11:34, about 800 per minute.
export const CHARS_PER_MINUTE = 800;
export const MAX_SCRIPT_CHARS = MAX_MINUTES * CHARS_PER_MINUTE;

// ElevenLabs asks to keep one dialogue request at or below 2000 characters.
export const MAX_SEGMENT_CHARS = 1900;
export const MAX_TURN_CHARS = 1800;

export const LANGUAGES = [
  { code: 'sk', label: 'Slovencina' },
  { code: 'cs', label: 'Cestina' },
  { code: 'en', label: 'Anglictina' },
  { code: 'de', label: 'Nemcina' },
  { code: 'pl', label: 'Polstina' },
  { code: 'hu', label: 'Madarcina' },
  { code: 'es', label: 'Spanielcina' },
  { code: 'fr', label: 'Francuzstina' },
] as const;

// Claude only: the tool lock in writer-workspace/.claude/settings.json does not apply to other providers.
export const SCRIPT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
] as const;

export const TONES = [
  { id: 'friendly', label: 'Priatelsky rozhovor' },
  { id: 'curious', label: 'Zvedavy a vysvetlujuci' },
  { id: 'debate', label: 'Vecna debata' },
  { id: 'story', label: 'Pribeh a napatie' },
] as const;

export type Speaker = 'A' | 'B';

export interface Host {
  name: string;
  persona: string;
  voiceId: string;
  voiceName: string;
}

export interface Brief {
  topic: string;
  language: string;
  targetMinutes: number;
  tone: string;
  model: string;
  hosts: Record<Speaker, Host>;
}

export interface SourceDoc {
  id: string;
  name: string;
  kind: 'pdf' | 'markdown' | 'text' | 'docx';
  bytes: number;
  chars: number;
}

export interface Turn {
  id: string;
  speaker: Speaker;
  text: string;
}

export interface Script {
  title: string;
  summary: string;
  turns: Turn[];
}

export interface ScriptJob {
  state: 'idle' | 'running' | 'failed';
  stage?: string;
  error?: string;
  warning?: string;
  threadId?: string;
  startedAt?: string;
}

export type SegmentStatus = 'queued' | 'pending' | 'complete' | 'failed' | 'unresolved';

export interface SegmentState {
  hash: string;
  chars: number;
  status: SegmentStatus;
  cached?: boolean;
  seconds?: number;
  error?: string;
}

export interface RenderJob {
  state: 'idle' | 'running' | 'blocked' | 'failed' | 'complete';
  stage?: string;
  error?: string;
  approvedChars: number;
  segments: SegmentState[];
}

export interface AudioResult {
  scriptHash: string;
  bytes: number;
  sha256: string;
  seconds: number;
  integratedLufs: number | null;
  truePeakDb: number | null;
  tempo: number;
  createdAt: string;
}

export interface Episode {
  id: string;
  createdAt: string;
  updatedAt: string;
  brief: Brief;
  sources: SourceDoc[];
  script: Script | null;
  scriptJob: ScriptJob;
  render: RenderJob;
  audio: AudioResult | null;
}

export interface RenderPlan {
  scriptHash: string;
  totalChars: number;
  newChars: number;
  segments: SegmentState[];
  blockers: string[];
  quotaRemaining: number | null;
  spentCredits: number;
}

export interface Voice {
  id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  previewUrl: string | null;
}

export interface AppStatus {
  t3: { ok: boolean; detail: string };
  elevenlabs: { ok: boolean; detail: string; quotaRemaining: number | null };
}

export function scriptChars(script: Pick<Script, 'turns'>): number {
  return script.turns.reduce((sum, turn) => sum + turn.text.length, 0);
}

export function estimateSeconds(chars: number): number {
  return Math.round((chars / CHARS_PER_MINUTE) * 60);
}
