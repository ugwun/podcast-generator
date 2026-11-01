import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus, Episode } from '../../shared/types.ts';
import { api } from './api.ts';
import { AudioStep } from './AudioStep.tsx';
import { BriefStep } from './BriefStep.tsx';
import { ScriptStep } from './ScriptStep.tsx';

type Step = 'brief' | 'script' | 'audio';

const STEPS: { id: Step; label: string }[] = [
  { id: 'brief', label: 'Zadanie' },
  { id: 'script', label: 'Skript' },
  { id: 'audio', label: 'Podcast' },
];

const isBusy = (episode: Episode) => episode.scriptJob.state === 'running' || episode.render.state === 'running';
const episodeName = (episode: Episode) => episode.script?.title || episode.brief.topic.trim() || episode.sources[0]?.name || 'Nova epizoda';
const initialStep = (episode: Episode): Step => (episode.audio ? 'audio' : episode.script ? 'script' : 'brief');
const hashId = () => window.location.hash.replace(/^#\/?/, '') || null;

function episodeState(episode: Episode): string {
  if (episode.render.state === 'running') return 'Generuje sa audio';
  if (episode.scriptJob.state === 'running') return 'Pise sa skript';
  if (episode.audio) return 'Hotovo';
  if (episode.script) return 'Skript';
  return 'Koncept';
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(hashId);
  const [step, setStep] = useState<Step>('brief');
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const selected = episodes.find((episode) => episode.id === selectedId) ?? null;
  const selectedRunning = selected ? isBusy(selected) : false;
  const previousJob = useRef<string | undefined>(undefined);

  const applyEpisode = useCallback((episode: Episode) => {
    setEpisodes((list) => (list.some((item) => item.id === episode.id) ? list.map((item) => (item.id === episode.id ? episode : item)) : [episode, ...list]));
  }, []);

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
    api
      .episodes()
      .then((list) => {
        setEpisodes(list);
        const fromHash = list.find((item) => item.id === hashId());
        if (fromHash) setStep(initialStep(fromHash));
      })
      .catch((reason) => setError(reason.message));
    const onHash = () => setSelectedId(hashId());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!selectedId || !selectedRunning) return;
    const timer = setInterval(() => {
      api.episode(selectedId).then(applyEpisode).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [selectedId, selectedRunning, applyEpisode]);

  // A freshly written script is the next thing to read, so move there as soon as the job ends.
  useEffect(() => {
    const job = selected?.scriptJob.state;
    if (previousJob.current === 'running' && job === 'idle') setStep('script');
    previousJob.current = job;
  }, [selected?.scriptJob.state]);

  const select = (episode: Episode) => {
    window.location.hash = `/${episode.id}`;
    setSelectedId(episode.id);
    setStep(initialStep(episode));
    setMenuOpen(false);
  };

  const create = async () => {
    try {
      const episode = await api.createEpisode();
      applyEpisode(episode);
      select(episode);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const remove = async (episode: Episode) => {
    if (!window.confirm(`Naozaj zmazat "${episodeName(episode)}" aj s audiom?`)) return;
    try {
      await api.deleteEpisode(episode.id);
      setEpisodes((list) => list.filter((item) => item.id !== episode.id));
      if (selectedId === episode.id) {
        window.location.hash = '';
        setSelectedId(null);
      }
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <div className="shell">
      <aside className={menuOpen ? 'rail open' : 'rail'}>
        <div className="rail-head">
          <a className="brand" href="#/" onClick={() => setSelectedId(null)}>
            <span className="brand-mark" aria-hidden="true" />
            Podcast Generator
          </a>
          <button className="ghost menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>
            {menuOpen ? 'Zavriet' : 'Epizody'}
          </button>
        </div>
        <div className="rail-body">
          <button className="primary wide" onClick={create}>
            Nova epizoda
          </button>
          <nav aria-label="Epizody">
            {episodes.map((episode) => (
              <div key={episode.id} className={episode.id === selectedId ? 'episode-link active' : 'episode-link'}>
                <button onClick={() => select(episode)}>
                  <strong>{episodeName(episode)}</strong>
                  <span>{episodeState(episode)}</span>
                </button>
                <button className="ghost icon" onClick={() => remove(episode)} aria-label={`Zmazat ${episodeName(episode)}`} title="Zmazat">
                  ×
                </button>
              </div>
            ))}
          </nav>
          <div className="status-box">
            <StatusLine label="T3 Code" state={status?.t3} />
            <StatusLine label="ElevenLabs" state={status?.elevenlabs} />
            {status?.elevenlabs.quotaRemaining != null && <p>Zostava {status.elevenlabs.quotaRemaining.toLocaleString('sk')} kreditov</p>}
          </div>
        </div>
      </aside>

      <main>
        {error && (
          <p className="banner error" role="alert">
            {error} <button className="ghost" onClick={() => setError('')}>Zavriet</button>
          </p>
        )}
        {selected ? (
          <>
            <header className="episode-head">
              <p className="eyebrow">{episodeState(selected)}</p>
              <h1>{episodeName(selected)}</h1>
              <ol className="steps">
                {STEPS.map((item, index) => {
                  const available = item.id === 'brief' || Boolean(selected.script);
                  return (
                    <li key={item.id}>
                      <button className={item.id === step ? 'active' : ''} disabled={!available} onClick={() => setStep(item.id)} aria-current={item.id === step ? 'step' : undefined}>
                        <span>{index + 1}</span> {item.label}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </header>
            {step === 'brief' && <BriefStep key={selected.id} episode={selected} status={status} onChange={applyEpisode} onError={setError} />}
            {step === 'script' && selected.script && <ScriptStep key={selected.id} episode={selected} onChange={applyEpisode} onError={setError} onNext={() => setStep('audio')} />}
            {step === 'audio' && selected.script && <AudioStep key={selected.id} episode={selected} onChange={applyEpisode} onError={setError} onEditScript={() => setStep('script')} />}
          </>
        ) : (
          <section className="welcome">
            <p className="eyebrow">Studio pre dvoch</p>
            <h1>Z dokumentov rozhovor, ktory si vypocujes.</h1>
            <p>Nahraj PDF, Markdown alebo DOCX. T3 agent napise skript pre dvoch moderatorov, ty ho upravis a ElevenLabs z neho spravi podcast do 15 minut.</p>
            <button className="primary" onClick={create}>
              Vytvorit prvu epizodu
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

function StatusLine({ label, state }: { label: string; state?: { ok: boolean; detail: string } }) {
  return (
    <p title={state?.detail}>
      <span className={state ? (state.ok ? 'dot ok' : 'dot bad') : 'dot'} aria-hidden="true" />
      {label}: {state?.detail ?? 'overujem'}
    </p>
  );
}
