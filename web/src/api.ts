import type { AppStatus, Brief, Episode, RenderPlan, Script, Voice } from '../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Server vratil chybu ${response.status}.`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  status: () => request<AppStatus>('/status'),
  voices: () => request<Voice[]>('/voices'),
  episodes: () => request<Episode[]>('/episodes'),
  episode: (id: string) => request<Episode>(`/episodes/${id}`),
  createEpisode: () => request<Episode>('/episodes', { method: 'POST' }),
  deleteEpisode: (id: string) => request<void>(`/episodes/${id}`, { method: 'DELETE' }),
  saveBrief: (id: string, brief: Partial<Brief>) => request<Episode>(`/episodes/${id}`, json('PATCH', brief)),
  uploadSource: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Episode>(`/episodes/${id}/sources`, { method: 'POST', body: form });
  },
  deleteSource: (id: string, source: string) => request<Episode>(`/episodes/${id}/sources/${source}`, { method: 'DELETE' }),
  generateScript: (id: string) => request<unknown>(`/episodes/${id}/script`, { method: 'POST' }),
  reviseScript: (id: string, instruction: string) => request<unknown>(`/episodes/${id}/script/revise`, json('POST', { instruction })),
  saveScript: (id: string, script: Script) => request<Episode>(`/episodes/${id}/script`, json('PUT', script)),
  renderPlan: (id: string) => request<RenderPlan>(`/episodes/${id}/render/plan`),
  render: (id: string, approvedChars: number, retryHashes: string[]) =>
    request<unknown>(`/episodes/${id}/render`, json('POST', { approvedChars, retryHashes })),
};
