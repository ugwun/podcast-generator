import { useEffect, useRef, useState } from 'react';
import type { Episode, RenderPlan, SegmentStatus } from '../../shared/types.ts';
import { api } from './api.ts';
import { formatTime } from './format.ts';

interface Props {
  episode: Episode;
  onChange: (episode: Episode) => void;
  onError: (message: string) => void;
  onEditScript: () => void;
}

const SEGMENT_LABEL: Record<SegmentStatus, string> = {
  queued: 'caka',
  pending: 'generuje sa',
  complete: 'hotovo',
  failed: 'zlyhalo',
  unresolved: 'neisty stav',
};

export function AudioStep({ episode, onChange, onError, onEditScript }: Props) {
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const running = episode.render.state === 'running';

  useEffect(() => {
    if (running) return;
    api.renderPlan(episode.id).then(setPlan).catch((reason) => onError(reason.message));
  }, [episode.id, episode.updatedAt, running]);

  const unresolved = plan?.segments.filter((segment) => segment.status === 'unresolved') ?? [];
  const stale = episode.audio && plan && episode.audio.scriptHash !== plan.scriptHash;
  const canStart = plan && !plan.blockers.length && !running && (!unresolved.length || retryConfirmed);
  const fromCache = plan ? plan.totalChars - plan.newChars : 0;
  const upToDate = Boolean(episode.audio && plan && !stale && !plan.newChars);

  const start = async () => {
    if (!plan) return;
    try {
      await api.render(episode.id, plan.newChars, unresolved.map((segment) => segment.hash));
      setRetryConfirmed(false);
      onChange(await api.episode(episode.id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  };

  const segments = running || episode.render.segments.length ? episode.render.segments : [];
  const done = segments.filter((segment) => segment.status === 'complete').length;

  return (
    <div className="step-body">
      {episode.audio && (
        <section className="panel player-panel">
          {stale && <p className="banner warn">Skript alebo hlasy sa odvtedy zmenili. Toto audio patri starsej verzii.</p>}
          <Player episode={episode} />
        </section>
      )}

      <section className="panel">
        <h2>{upToDate ? 'Audio zodpoveda skriptu' : episode.audio ? 'Nova verzia audia' : 'Vytvorenie audia'}</h2>
        <dl className="facts">
          <div>
            <dt>Moderatori</dt>
            <dd>{episode.brief.hosts.A.voiceName || 'bez hlasu'}, {episode.brief.hosts.B.voiceName || 'bez hlasu'}</dd>
          </div>
          <div>
            <dt>Znakov na generovanie</dt>
            <dd>{plan ? `${plan.newChars.toLocaleString('sk')} znakov` : '...'}</dd>
          </div>
          {fromCache > 0 && (
            <div>
              <dt>Pouzite z hotovych segmentov</dt>
              <dd>{fromCache.toLocaleString('sk')} znakov</dd>
            </div>
          )}
          {plan?.quotaRemaining != null && (
            <div>
              <dt>Zostatok na ucte</dt>
              <dd>{plan.quotaRemaining.toLocaleString('sk')} kreditov</dd>
            </div>
          )}
          {plan != null && plan.spentCredits > 0 && (
            <div>
              <dt>Doteraz minute kredity</dt>
              <dd>{plan.spentCredits.toLocaleString('sk')}</dd>
            </div>
          )}
        </dl>

        {plan?.blockers.map((blocker) => (
          <p className="banner error" key={blocker}>{blocker}</p>
        ))}
        {episode.render.state === 'blocked' && <p className="banner warn">{episode.render.error}</p>}
        {episode.render.state === 'failed' && <p className="banner error">{episode.render.error}</p>}

        {unresolved.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={retryConfirmed} onChange={(event) => setRetryConfirmed(event.target.checked)} />
            <span>V historii ElevenLabs som overil {unresolved.length === 1 ? 'neisty segment' : `neiste segmenty (${unresolved.length})`} a suhlasim s opakovanim, aj keby sa uctovali znova.</span>
          </label>
        )}

        {segments.length > 0 && (
          <div className="progress">
            <p className="muted">{running ? episode.render.stage : 'Posledne spustenie'}: {done} z {segments.length} segmentov</p>
            <ol className="segments">
              {segments.map((segment, index) => (
                <li key={segment.hash} className={`segment ${segment.status}`} title={`Segment ${index + 1}: ${SEGMENT_LABEL[segment.status]}${segment.error ? ` (${segment.error})` : ''}`} />
              ))}
            </ol>
          </div>
        )}

        <div className="button-row">
          {!upToDate && (
            <button className="primary" disabled={!canStart} onClick={start}>
              {running ? 'Generujem...' : plan?.newChars ? `Vytvorit audio (${plan.newChars.toLocaleString('sk')} znakov)` : 'Zlozit audio z hotovych segmentov'}
            </button>
          )}
          <button className="ghost" onClick={onEditScript}>Spat na skript</button>
        </div>
      </section>
    </div>
  );
}

function Player({ episode }: { episode: Episode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const result = episode.audio!;
  const source = `/api/episodes/${episode.id}/audio?v=${result.sha256.slice(0, 8)}`;

  const toggle = () => {
    if (!audio.current) return;
    if (audio.current.paused) void audio.current.play();
    else audio.current.pause();
  };

  const cycleRate = () => {
    const next = rate >= 1.5 ? 1 : rate + 0.25;
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  return (
    <div className="player">
      <audio ref={audio} src={source} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />
      <button className={playing ? 'play playing' : 'play'} onClick={toggle} aria-label={playing ? 'Pozastavit' : 'Prehrat'} />
      <div className="player-main">
        <h2>{episode.script?.title}</h2>
        {episode.script?.summary && <p className="muted">{episode.script.summary}</p>}
        <input
          type="range"
          aria-label="Pozicia v podcaste"
          min={0}
          max={result.seconds}
          step={1}
          value={time}
          onChange={(event) => {
            const next = Number(event.target.value);
            setTime(next);
            if (audio.current) audio.current.currentTime = next;
          }}
        />
        <div className="player-meta">
          <span>{formatTime(time)} / {formatTime(result.seconds)}</span>
          <button className="ghost" onClick={cycleRate}>{rate}×</button>
          <a className="ghost" href={`/api/episodes/${episode.id}/audio?download`}>Stiahnut MP3</a>
          {result.integratedLufs !== null && <span className="muted">{result.integratedLufs.toFixed(1)} LUFS</span>}
        </div>
      </div>
    </div>
  );
}
