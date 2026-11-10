import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { NET, type Difficulty } from '@caravan/protocol';
import {
  buildPool,
  DECK_MODES,
  DECK_MODE_IDS,
  DEFAULT_DECK_MODE,
  type DeckModeId,
} from '@caravan/rules';
import { Board } from './Board.js';
import { DeckBuilder } from './DeckBuilder.js';
import { CaravanClient, type Connectivity } from './net.js';
import { warmAssets } from './preload.js';
import { sound } from './sound.js';
import { ambience, music } from './music.js';

/**
 * Landing page, board, and the connection chrome around both. Built for one
 * shape only: a phone held sideways.
 *
 * Everything that is *about* the session rather than the game — title, code,
 * seats, turn counter, errors, the leave button — is packed into one panel. On
 * the start page it heads the screen; during a match it sits behind the board's
 * Menu button, so the table has the whole screen to itself.
 */
/** `client` is for tests, which hand in one wired to an in-memory network. */
export function App({ client: given }: { client?: CaravanClient } = {}) {
  const client = useMemo(() => given ?? new CaravanClient(), [given]);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [code, setCode] = useState('');
  // The table's options are chosen before the room exists, because the deal
  // depends on them — an AI seat has to be filled before the cards go out.
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, [client]);

  // Start fetching art and sound the moment the shell is up, rather than when
  // the board that needs them appears — by then the deal has already been
  // dealt. Deliberately not tied to being seated: a player sitting on the
  // landing page typing a code is exactly the idle moment worth spending.
  useEffect(() => warmAssets(), []);

  const seated = state.seat !== null;
  const connecting = state.connectivity === 'connecting';
  // The final board is the record of how the match went, so it stays up once
  // the room ends rather than being swapped out for a bare message — the result
  // is laid over it. Ending the room only freezes the board; it does not remove
  // it. Note the room reports "ended" on any disconnect after a decided match,
  // not just on abandonment, so this is the common path and not an edge case.
  const showBoard = state.match !== null;
  // A decided match freezes the board on its own, without the room having to
  // end: the table stays up for as long as a rematch is still on offer.
  const frozen = state.status === 'ended' || !!state.match?.result;

  // A deck is submitted once and only once, so this reads it off the server's
  // own bookkeeping rather than local state — a refresh mid-build resumes into
  // the right screen instead of forgetting a deck was already sent.
  const mySubmitted = seated && state.decksReady[state.seat!];
  const buildable = DECK_MODES[state.mode].buildable;
  // Offered as soon as a seat exists, not gated on an opponent — there is no
  // reason to make the host wait for company before trimming their own deck.
  const showDeckBuilder = seated && !showBoard && !mySubmitted && buildable;

  // A mode with no building to do sends its whole pool the moment the seat
  // exists, so the player goes straight from the landing page to the table.
  // Gated on the server's `decksReady` like the builder is, so a refresh
  // mid-deal doesn't try to submit a deck that is already in.
  useEffect(() => {
    if (!seated || buildable || mySubmitted || showBoard) return;
    client.submitDeck(buildPool(state.seat!, state.mode).map((card) => card.id));
  }, [client, seated, buildable, mySubmitted, showBoard, state.seat, state.mode]);

  // Handed to the Board, which shows it behind its Menu button. With no board to
  // host it — the landing page — it stands on its own instead.
  const panel = (
    <section className="panel">
      <h1>vCaravan</h1>

      {seated && (
        <>
          <span className="meta">
            <span className="meta-label">Table</span>
            <strong className="code">{state.code}</strong>
          </span>
          <Seats present={state.present} you={state.seat!} />
          <Status state={state} />
        </>
      )}

      <span className="spacer" />
      {state.connectivity !== 'idle' && (
        <span
          className={`conn conn-${state.connectivity}`}
          title={CONNECTIVITY_HINTS[state.hosting ? 'host' : 'guest'][state.connectivity]}
        >
          {state.connectivity === 'local' ? 'offline' : state.connectivity}
        </span>
      )}
      {seated && <button onClick={() => client.leave()}>Leave</button>}

      <AudioControls />

      {state.error && <p className="error">{state.error}</p>}
    </section>
  );

  return (
    // `playing` pins the table to exactly one screen; the other pages scroll
    // if they have to.
    <main className={showBoard ? 'playing' : undefined}>
      {showBoard ? (
        <Board
          view={state.match!}
          events={state.events}
          onMove={(move) => client.play(move)}
          panel={panel}
          frozen={frozen}
        />
      ) : (
        panel
      )}

      {!seated && creating && (
        <TableOptions
          onStart={(bot, mode) => {
            setCreating(false);
            void client.createRoom(bot, mode);
          }}
          onBack={() => setCreating(false)}
        />
      )}

      {/* Registering on the broker, or dialling a host, can take a few seconds.
          The start page is swapped out for the wait, so there is nothing to
          click twice — and a way back if the other end never answers. */}
      {!seated && connecting && (
        <section className="landing connecting">
          <span className="or">
            {state.hosting ? 'Opening your table…' : 'Connecting to the table…'}
          </span>
          <button className="ghost" onClick={() => client.cancel()}>
            Cancel
          </button>
        </section>
      )}

      {!seated && !creating && !connecting && (
        <section className="landing">
          <button onClick={() => setCreating(true)}>Create a table</button>
          <span className="or">or join one</span>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              client.joinRoom(code);
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="CODE"
              maxLength={NET.ROOM_CODE_LENGTH}
              autoFocus
              aria-label="Room code"
            />
            <button type="submit" disabled={code.trim().length !== NET.ROOM_CODE_LENGTH}>
              Join
            </button>
          </form>
        </section>
      )}

      {showDeckBuilder && (
        <DeckBuilder
          seat={state.seat!}
          mode={state.mode}
          onConfirm={(keep) => client.submitDeck(keep)}
        />
      )}

      {seated && !showBoard && mySubmitted && (
        <section className="deck-waiting">
          <p>Deck locked in — waiting for your opponent.</p>
        </section>
      )}

      {state.match?.result && (
        <Result
          result={state.match.result}
          you={state.match.seat}
          // Once the room has ended there is nothing left to play again with —
          // the server has let the table go.
          onRematch={state.status === 'ended' ? undefined : () => client.rematch()}
          offered={state.rematch[state.match.seat]}
          opponentOffered={state.rematch[state.match.seat === 0 ? 1 : 0]}
        />
      )}
    </main>
  );
}

/** What the connection badge means, which depends on whose tab the table is in. */
const CONNECTIVITY_HINTS: Record<'host' | 'guest', Record<Exclude<Connectivity, 'idle'>, string>> = {
  host: {
    local: 'This table runs entirely in this tab',
    connecting: 'Registering this table so an opponent can reach it',
    open: 'This tab is hosting the table — closing it ends the match',
    closed: 'Lost the PeerJS broker: new players cannot find this table until it is back',
  },
  guest: {
    local: '',
    connecting: "Connecting to the host's tab",
    open: "Connected to the host's tab",
    closed: "Lost the host's tab — trying to reach it again",
  },
};

const DIFFICULTIES: Array<{ value: Difficulty; label: string; blurb: string }> = [
  { value: 'easy', label: 'Easy', blurb: 'Builds its own caravans and leaves yours alone.' },
  { value: 'medium', label: 'Medium', blurb: 'Builds its own, and wrecks yours with face cards.' },
  {
    value: 'hard',
    label: 'Hard',
    blurb: "Plans a move ahead and guesses at your hand — it can't see your cards.",
  },
  {
    value: 'extreme',
    label: 'Extreme',
    blurb: 'Hard, but it knows which cards you kept when you built your deck.',
  },
];

/**
 * What kind of table to open. Single player fills the second seat with the AI
 * before the deal; multiplayer leaves it for whoever you give the code to. The
 * difficulty only exists for the former, so it is only shown for the former.
 *
 * The deck mode applies to both seats and cannot be changed once the table
 * exists, because the deal depends on it — which is the same reason all of this
 * is chosen before the room is created rather than in a lobby afterwards.
 */
function TableOptions({
  onStart,
  onBack,
}: {
  onStart: (bot?: Difficulty, mode?: DeckModeId) => void;
  onBack: () => void;
}) {
  const [solo, setSolo] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [mode, setMode] = useState<DeckModeId>(DEFAULT_DECK_MODE);

  return (
    <section className="options">
      <h2>New table</h2>

      <fieldset className="option-group">
        <legend>Opponent</legend>
        <label>
          <input type="radio" checked={!solo} onChange={() => setSolo(false)} />
          Another player
        </label>
        <label>
          <input type="radio" checked={solo} onChange={() => setSolo(true)} />
          Computer
        </label>
      </fieldset>

      {solo && (
        <fieldset className="option-group">
          <legend>Difficulty</legend>
          {DIFFICULTIES.map(({ value, label, blurb }) => (
            <label key={value} title={blurb}>
              <input
                type="radio"
                checked={difficulty === value}
                onChange={() => setDifficulty(value)}
              />
              {label}
              <small className="dim">{blurb}</small>
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="option-group">
        <legend>Cards</legend>
        {DECK_MODE_IDS.map((id) => {
          const { label, blurb } = DECK_MODES[id];
          return (
            <label key={id} title={blurb}>
              <input type="radio" checked={mode === id} onChange={() => setMode(id)} />
              {label}
              <small className="dim">{blurb}</small>
            </label>
          );
        })}
      </fieldset>

      <div className="option-actions">
        <button className="confirm" onClick={() => onStart(solo ? difficulty : undefined, mode)}>
          Start
        </button>
        <button className="ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}

function Result({
  result,
  you,
  onRematch,
  offered,
  opponentOffered,
}: {
  result: NonNullable<ReturnType<CaravanClient['getSnapshot']>['match']>['result'];
  you: 0 | 1;
  /** Absent when there is no longer a table to play again on. */
  onRematch?: () => void;
  offered: boolean;
  opponentOffered: boolean;
}) {
  if (!result) return null;
  const lost = result.kind === 'winner' && result.seat !== you;
  const why =
    result.kind === 'draw'
      ? 'the turn limit was reached'
      : result.reason === 'tracks'
        ? 'all three tracks are decided'
        : result.reason === 'empty-hand'
          ? 'a player ran out of cards'
          : 'a player ran out of legal moves';
  const headline =
    result.kind === 'draw' ? 'Draw' : result.seat === you ? 'You win' : 'You lose';
  return (
    <section className={`result ${lost ? 'lose' : ''}`}>
      {headline}
      <small className="dim">{why}</small>
      {onRematch && (
        <button className="confirm rematch" onClick={onRematch} disabled={offered}>
          {offered ? 'Waiting for your opponent…' : opponentOffered ? 'Accept rematch' : 'Rematch'}
        </button>
      )}
    </section>
  );
}


/**
 * The audio controls, kept together on a line of their own. There are enough of
 * them now that sharing the panel's top line meant wrapping mid-group, splitting
 * the music mute from its own skip button.
 */
function AudioControls() {
  return (
    <div className="audio">
      <MuteToggle />
      <AmbienceToggle />
      <MusicControls />
    </div>
  );
}

/**
 * Silences the card sounds. Hidden outright when no sound files are bundled, so
 * a build without them shows no control for something that cannot make noise.
 * The setting is remembered across sessions by the store behind it.
 */
function MuteToggle() {
  const enabled = useSyncExternalStore(sound.subscribe, sound.isEnabled);
  if (!sound.available()) return null;
  return (
    <button
      type="button"
      className="mute"
      aria-pressed={!enabled}
      title={enabled ? 'Mute card sounds' : 'Unmute card sounds'}
      onClick={() => sound.setEnabled(!enabled)}
    >
      <span aria-hidden="true">{enabled ? '🔊' : '🔇'}</span>
      <span className="sr-only">{enabled ? 'Mute card sounds' : 'Unmute card sounds'}</span>
    </button>
  );
}

/** Silences the room tone. Hidden when no ambience file is bundled. */
function AmbienceToggle() {
  const enabled = useSyncExternalStore(ambience.subscribe, ambience.isEnabled);
  if (!ambience.available()) return null;
  return (
    <button
      type="button"
      className="mute"
      aria-pressed={!enabled}
      title={enabled ? 'Mute ambience' : 'Unmute ambience'}
      onClick={() => ambience.setEnabled(!enabled)}
    >
      <span aria-hidden="true">{enabled ? '🌬️' : '💤'}</span>
      <span className="sr-only">{enabled ? 'Mute ambience' : 'Unmute ambience'}</span>
    </button>
  );
}

/**
 * The radio: a mute, and a skip that only appears while it is playing — there is
 * nothing to skip to when the music is off. The title carries the track name,
 * which is the only place the playlist is visible at all.
 */
function MusicControls() {
  const enabled = useSyncExternalStore(music.subscribe, music.isEnabled);
  const track = useSyncExternalStore(music.subscribeNowPlaying, music.nowPlaying);
  if (!music.available()) return null;
  return (
    <>
      <button
        type="button"
        className="mute"
        aria-pressed={!enabled}
        title={enabled ? `Mute music${track ? ` — ${track.title}` : ''}` : 'Unmute music'}
        onClick={() => music.setEnabled(!enabled)}
      >
        <span aria-hidden="true">{enabled ? '🎵' : '🔕'}</span>
        <span className="sr-only">{enabled ? 'Mute music' : 'Unmute music'}</span>
      </button>
      {enabled && (
        <button type="button" className="mute" title="Next track" onClick={() => music.next()}>
          <span aria-hidden="true">⏭️</span>
          <span className="sr-only">Next track</span>
        </button>
      )}
    </>
  );
}

function Seats({ present, you }: { present: [boolean, boolean]; you: 0 | 1 }) {
  return (
    <ul className="seats">
      {[0, 1].map((seat) => (
        <li
          key={seat}
          className={present[seat] ? 'here' : 'away'}
          title={present[seat] ? 'Connected' : 'Not connected'}
        >
          {seat === you ? 'you' : 'opponent'}
        </li>
      ))}
    </ul>
  );
}

/**
 * The one line that says where the session is up to. It carries its own label
 * because that label changes with the state it is reporting — "Turn" is wrong
 * for a match that has ended or has not started.
 */
function Status({ state }: { state: ReturnType<CaravanClient['getSnapshot']> }) {
  const countdown = useCountdown(state.reconnectDeadline);

  const [label, body] = ((): [string, ReactElement] => {
    if (state.status === 'ended') {
      return [
        'Ended',
        <span className="status warn">{endedText(state.endedReason, state.hosting)}</span>,
      ];
    }
    if (state.status === 'waiting') {
      return ['Waiting', <span className="status">Share the code for an opponent</span>];
    }
    if (state.status === 'building') {
      const ready = state.decksReady.filter(Boolean).length;
      return ['Waiting', <span className="status">{ready}/2 decks ready</span>];
    }
    if (!state.hosting && state.connectivity === 'closed') {
      return ['Waiting', <span className="status warn">Reconnecting to the host…</span>];
    }
    if (countdown !== null) {
      return ['Waiting', <span className="status warn">Reconnecting… {countdown}s</span>];
    }
    if (state.match) {
      return [
        'Turn',
        <span className="status">
          {state.match.phase === 'opening' ? 'opening round' : `turn ${state.match.ply + 1}`}
        </span>,
      ];
    }
    return ['Turn', <span className="status">seated</span>];
  })();

  return (
    <span className="meta">
      <span className="meta-label">{label}</span>
      {body}
    </span>
  );
}

/**
 * Why the table ended, in words. The wire carries a short code, and what it
 * means depends on whose tab it is: a guest only ever hears `opponent-left`
 * because the host left, and `abandoned` because the host never came back.
 */
export function endedText(reason: string | null, hosting: boolean): string {
  switch (reason) {
    case 'opponent-left':
      return hosting ? 'Your opponent left' : 'The host left the table';
    case 'abandoned':
      return hosting ? "Your opponent didn't come back" : "The host didn't come back";
    case 'idle':
      return `Closed after ${NET.IDLE_SWEEP_MS / 60_000} minutes with no moves`;
    case 'finished':
      return 'Match over';
    default:
      return 'The table has closed';
  }
}

/** Seconds remaining until a deadline, or null when there is none. */
function useCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
