import { useEffect, useRef, useState } from 'react';
import type { AppStatus, Brief, Episode, Speaker, Voice } from '../../shared/types.ts';
import { LANGUAGES, MAX_MINUTES, MIN_MINUTES, SCRIPT_MODELS, TONES } from '../../shared/types.ts';
import { api } from './api.ts';
import { createSaveQueue } from './saveQueue.ts';

interface Props {
  episode: Episode;
  status: AppStatus | null;
  onChange: (episode: Episode) => void;
  onError: (message: string) => void;
}

const ACCEPT = '.pdf,.md,.markdown,.txt,.docx';
const SAVE_DELAY_MS = 400;

export function BriefStep({ episode, status, onChange, onError }: Props) {
  const [brief, setBrief] = useState<Brief>(episode.brief);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceError, setVoiceError] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const running = episode.scriptJob.state === 'running';
  const busy = running || episode.render.state === 'running';
  const [saves] = useState(() =>
    createSaveQueue<Brief, Episode>({
      save: (next) => api.saveBrief(episode.id, next),
      onSaved: onChange,
      onError: (reason) => onError(reason.message),
      delayMs: SAVE_DELAY_MS,
    }),
  );

  useEffect(() => {
    api.voices().then(setVoices).catch((reason) => setVoiceError(reason.message));
  }, []);

  useEffect(() => () => void saves.flush().catch((reason) => onError(reason.message)), []);

  const update = (next: Brief) => {
    setBrief(next);
    saves.schedule(next);
  };

  const updateHost = (speaker: Speaker, patch: Partial<Brief['hosts'][Speaker]>) => {
    update({ ...brief, hosts: { ...brief.hosts, [speaker]: { ...brief.hosts[speaker], ...patch } } });
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(files.length);
    for (const file of Array.from(files)) {
      try {
        onChange(await api.uploadSource(episode.id, file));
      } catch (reason) {
        onError((reason as Error).message);
      }
      setUploading((count) => count - 1);
    }
  };

  const removeSource = async (id: string) => {
    try {
      onChange(await api.deleteSource(episode.id, id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  };

  const generate = async () => {
    try {
      await saves.flush();
      await api.generateScript(episode.id);
      onChange(await api.episode(episode.id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  };

  const canGenerate = Boolean(brief.topic.trim() || episode.sources.length) && !busy && status?.t3.ok !== false;

  return (
    <div className="step-body">
      <fieldset className="form-group" disabled={busy}>
      <section className="panel">
        <h2>Zdroje</h2>
        <label
          className={dragging ? 'dropzone dragging' : 'dropzone'}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!busy) void upload(event.dataTransfer.files);
          }}
        >
          <input type="file" multiple accept={ACCEPT} onChange={(event) => { void upload(event.target.files); event.target.value = ''; }} />
          <strong>{uploading ? `Spracuvam ${uploading}...` : 'Pretiahni subory alebo klikni'}</strong>
          <span>PDF, Markdown, TXT, DOCX do 50 MB</span>
        </label>
        {episode.sources.length > 0 && (
          <ul className="sources">
            {episode.sources.map((source) => (
              <li key={source.id}>
                <span className="kind">{source.kind}</span>
                <span className="name">{source.name}</span>
                <span className="muted">{source.chars.toLocaleString('sk')} znakov</span>
                <button className="ghost icon" onClick={() => removeSource(source.id)} aria-label={`Odobrat ${source.name}`} title="Odobrat">×</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Zadanie</h2>
        <label className="field">
          <span>O com ma byt epizoda</span>
          <textarea rows={3} value={brief.topic} placeholder="Tema, uhol pohladu alebo otazka, na ktoru ma rozhovor odpovedat" onChange={(event) => update({ ...brief, topic: event.target.value })} />
        </label>
        <label className="field">
          <span>
            Dlzka <output>{brief.targetMinutes} min</output>
          </span>
          <input type="range" min={MIN_MINUTES} max={MAX_MINUTES} value={brief.targetMinutes} onChange={(event) => update({ ...brief, targetMinutes: Number(event.target.value) })} />
        </label>
        <div className="field-row">
          <Select label="Jazyk" value={brief.language} options={LANGUAGES.map((item) => [item.code, item.label])} onChange={(language) => update({ ...brief, language })} />
          <Select label="Styl" value={brief.tone} options={TONES.map((item) => [item.id, item.label])} onChange={(tone) => update({ ...brief, tone })} />
          <Select label="Model v T3" value={brief.model} options={SCRIPT_MODELS.map((item) => [item.id, item.label])} onChange={(model) => update({ ...brief, model })} />
        </div>
      </section>

      <section className="panel">
        <h2>Moderatori</h2>
        {voiceError && <p className="banner warn">{voiceError} Hlasy mozes vybrat neskor, skript sa napise aj bez nich.</p>}
        <div className="hosts">
          {(['A', 'B'] as Speaker[]).map((speaker) => (
            <HostCard key={speaker} speaker={speaker} host={brief.hosts[speaker]} voices={voices} onChange={(patch) => updateHost(speaker, patch)} />
          ))}
        </div>
      </section>
      </fieldset>

      <div className="action-bar">
        {running && <p className="working">{episode.scriptJob.stage}</p>}
        {episode.scriptJob.state === 'failed' && <p className="banner error">{episode.scriptJob.error}</p>}
        {status?.t3.ok === false && <p className="banner error">{status.t3.detail}</p>}
        <button className="primary" disabled={!canGenerate} onClick={generate}>
          {running ? 'Agent pise...' : episode.script ? 'Napisat skript nanovo' : 'Napisat skript'}
        </button>
      </div>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: (readonly [string, string])[]; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, text]) => (
          <option key={id} value={id}>{text}</option>
        ))}
      </select>
    </label>
  );
}

function HostCard({ speaker, host, voices, onChange }: { speaker: Speaker; host: Brief['hosts'][Speaker]; voices: Voice[]; onChange: (patch: Partial<Brief['hosts'][Speaker]>) => void }) {
  const voice = voices.find((item) => item.id === host.voiceId);
  const preview = useRef<HTMLAudioElement | null>(null);

  const play = () => {
    preview.current?.pause();
    if (!voice?.previewUrl) return;
    preview.current = new Audio(voice.previewUrl);
    void preview.current.play();
  };

  return (
    <article className={`host host-${speaker}`}>
      <label className="field">
        <span>Meno</span>
        <input value={host.name} onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <label className="field">
        <span>Rola v rozhovore</span>
        <textarea rows={3} value={host.persona} onChange={(event) => onChange({ persona: event.target.value })} />
      </label>
      <label className="field">
        <span>Hlas ElevenLabs</span>
        <select
          value={host.voiceId}
          onChange={(event) => {
            const chosen = voices.find((item) => item.id === event.target.value);
            onChange({ voiceId: event.target.value, voiceName: chosen?.name ?? '' });
          }}
        >
          <option value="">{voices.length ? 'Vyber hlas' : host.voiceName || 'Hlasy nie su dostupne'}</option>
          {voices.map((item) => (
            <option key={item.id} value={item.id}>
              {[item.name, item.labels.accent, item.labels.description].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </label>
      {voice?.previewUrl && (
        <button className="ghost" onClick={play}>
          Vypocut ukazku
        </button>
      )}
    </article>
  );
}
