import { useEffect, useRef, useState } from 'react';
import type { Episode, Script, Speaker, Turn } from '../../shared/types.ts';
import { estimateSeconds, MAX_SCRIPT_CHARS, MAX_SECONDS, MAX_TURN_CHARS, scriptChars } from '../../shared/types.ts';
import { api } from './api.ts';
import { formatTime } from './format.ts';
import { createSaveQueue } from './saveQueue.ts';

interface Props {
  episode: Episode;
  onChange: (episode: Episode) => void;
  onError: (message: string) => void;
  onNext: () => void;
}

const SAVE_DELAY_MS = 600;

export function ScriptStep({ episode, onChange, onError, onNext }: Props) {
  const [draft, setDraft] = useState<Script>(episode.script!);
  const [instruction, setInstruction] = useState('');
  const saved = useRef(JSON.stringify(episode.script));
  const running = episode.scriptJob.state === 'running';
  const busy = running || episode.render.state === 'running';
  const [saves] = useState(() =>
    createSaveQueue<Script, Episode>({
      save: (next) => api.saveScript(episode.id, next),
      onSaved: onChange,
      onError: (reason) => onError(reason.message),
      delayMs: SAVE_DELAY_MS,
    }),
  );
  const { hosts } = episode.brief;

  // Pick up a new script from the agent, but ignore the echo of our own saves.
  useEffect(() => {
    const incoming = JSON.stringify(episode.script);
    if (incoming !== saved.current && !saves.dirty()) {
      saved.current = incoming;
      setDraft(episode.script!);
    }
  }, [episode.script]);

  useEffect(() => () => void saves.flush().catch((reason) => onError(reason.message)), []);

  const update = (next: Script) => {
    setDraft(next);
    saved.current = JSON.stringify(next);
    saves.schedule(next);
  };

  const updateTurn = (id: string, patch: Partial<Turn>) => {
    update({ ...draft, turns: draft.turns.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)) });
  };

  const removeTurn = (id: string) => update({ ...draft, turns: draft.turns.filter((turn) => turn.id !== id) });

  const insertAfter = (index: number) => {
    const speaker: Speaker = draft.turns[index]?.speaker === 'A' ? 'B' : 'A';
    const turns = [...draft.turns];
    turns.splice(index + 1, 0, { id: crypto.randomUUID(), speaker, text: '' });
    update({ ...draft, turns });
  };

  const revise = async () => {
    try {
      await saves.flush();
      await api.reviseScript(episode.id, instruction);
      setInstruction('');
      onChange(await api.episode(episode.id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  };

  const chars = scriptChars(draft);
  const seconds = estimateSeconds(chars);
  const overLimit = chars > MAX_SCRIPT_CHARS;
  const emptyTurn = draft.turns.some((turn) => !turn.text.trim());
  const longTurn = draft.turns.some((turn) => turn.text.length > MAX_TURN_CHARS);

  return (
    <div className="step-body">
      <section className="panel script-head">
        <label className="field">
          <span>Nazov</span>
          <input value={draft.title} disabled={busy} onChange={(event) => update({ ...draft, title: event.target.value })} />
        </label>
        <label className="field">
          <span>Popis</span>
          <textarea rows={2} value={draft.summary} disabled={busy} onChange={(event) => update({ ...draft, summary: event.target.value })} />
        </label>
        <div className="meter" role="img" aria-label={`Odhadovana dlzka ${formatTime(seconds)} z limitu 15 minut`}>
          <div className="meter-top">
            <strong>{formatTime(seconds)}</strong>
            <span className="muted">odhad z {chars.toLocaleString('sk')} znakov, limit 15:00</span>
          </div>
          <div className="meter-track">
            <span className={overLimit ? 'over' : ''} style={{ width: `${Math.min(100, (seconds / MAX_SECONDS) * 100)}%` }} />
          </div>
        </div>
        {episode.scriptJob.warning && <p className="banner warn">{episode.scriptJob.warning}</p>}
        {overLimit && <p className="banner error">Skript je prilis dlhy. Skrat ho, inak z neho audio nevznikne.</p>}
      </section>

      <section className={busy ? 'turns locked' : 'turns'}>
        {draft.turns.map((turn, index) => (
          <article key={turn.id} className={`turn turn-${turn.speaker}`}>
            <button className="speaker" disabled={busy} onClick={() => updateTurn(turn.id, { speaker: turn.speaker === 'A' ? 'B' : 'A' })} title="Prepnut moderatora">
              {hosts[turn.speaker].name}
            </button>
            <textarea
              aria-label={`Replika ${index + 1}`}
              rows={Math.max(2, Math.ceil(turn.text.length / 70))}
              value={turn.text}
              disabled={busy}
              onChange={(event) => updateTurn(turn.id, { text: event.target.value })}
            />
            <div className="turn-tools">
              <button className="ghost icon" disabled={busy} onClick={() => insertAfter(index)} aria-label="Pridat repliku za touto" title="Pridat repliku">+</button>
              <button className="ghost icon" disabled={busy} onClick={() => removeTurn(turn.id)} aria-label="Zmazat repliku" title="Zmazat">×</button>
            </div>
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Upravit cez agenta</h2>
        <label className="field">
          <span>Co ma agent zmenit</span>
          <textarea rows={2} value={instruction} disabled={busy} placeholder="Napriklad: viac konkretnych prikladov v strede, Marek nech viac oponuje" onChange={(event) => setInstruction(event.target.value)} />
        </label>
        <button className="secondary" disabled={busy || !instruction.trim() || !episode.scriptJob.threadId} onClick={revise}>
          Poslat agentovi
        </button>
      </section>

      <div className="action-bar">
        {running && <p className="working">{episode.scriptJob.stage}</p>}
        {episode.scriptJob.state === 'failed' && <p className="banner error">{episode.scriptJob.error}</p>}
        {emptyTurn && <p className="banner warn">Niektora replika je prazdna.</p>}
        {longTurn && <p className="banner warn">Niektora replika ma viac ako {MAX_TURN_CHARS} znakov.</p>}
        <button className="primary" disabled={running || overLimit || emptyTurn || longTurn} onClick={() => saves.flush().then(onNext).catch((reason) => onError(reason.message))}>
          Pokracovat na audio
        </button>
      </div>
    </div>
  );
}
