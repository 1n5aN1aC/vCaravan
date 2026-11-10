import {
  buildPool,
  DECK_MODES,
  FACE_RANKS,
  NUMBER_RANKS,
  SUITS,
  type Card,
  type DeckModeId,
  type Seat,
} from '@caravan/rules';
import { useEffect, useMemo, useState } from 'react';
import { PlayingCard } from './PlayingCard.js';
import { playCue } from './sound.js';

const STORAGE_KEY = 'caravan:deck-removed';

/**
 * A card's identity stripped of the owner prefix `buildPool` stamps on (e.g.
 * `p0:AS` and `p1:AS` are the same card to a human choosing what to remove).
 * Remembering deck choices by this key rather than the raw id is what lets a
 * deck built as seat 0 restore correctly when this seat happens to be 1.
 *
 * The `#n` copy tag deliberately survives, so `AS` and `AS#2` are remembered
 * separately — keeping exactly one of a pair is a real choice in a doubled
 * deck. It also means a key from another mode's pool simply isn't in this one,
 * which the `validKeys` filter below already discards.
 */
function cardKey(card: Card): string {
  return card.id.replace(/^p\d+:/, '');
}

function loadRemembered(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const keys: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(keys)) return new Set();
    return new Set(keys.filter((k): k is string => typeof k === 'string'));
  } catch {
    // Private browsing, corrupted JSON, whatever — a fresh deck is a fine
    // fallback, not a reason to fail loading the page.
    return new Set();
  }
}

/**
 * `buildPool` hands back cards suit by suit (all Spades, then Hearts, …), and
 * in a multi-copy mode all of copy one before any of copy two, which is right
 * for dealing but not for browsing — a removal decision is almost always
 * "which rank", so the grid is sorted rank-first instead, suit only breaking
 * ties, Jokers trailing at the end. Copies of the same card land side by side,
 * which is the only way "keep one 7♥, not two" is a legible choice.
 */
const RANK_ORDER = new Map<string, number>(
  [...NUMBER_RANKS, ...FACE_RANKS].map((rank, i) => [rank, i]),
);
const SUIT_ORDER = new Map<string, number>(SUITS.map((suit, i) => [suit, i]));

/** Which copy of a card this is; untagged ids are the first. */
function copyIndex(card: Card): number {
  const tag = /#(\d+)$/.exec(card.id);
  return tag ? Number(tag[1]) : 1;
}

function byRankThenSuit(a: Card, b: Card): number {
  const rankDiff = (RANK_ORDER.get(a.rank) ?? Infinity) - (RANK_ORDER.get(b.rank) ?? Infinity);
  if (rankDiff !== 0) return rankDiff;
  const suitDiff = (SUIT_ORDER.get(a.suit ?? '') ?? 0) - (SUIT_ORDER.get(b.suit ?? '') ?? 0);
  if (suitDiff !== 0) return suitDiff;
  // Jokers share a rank and have no suit, so their ids are the only thing left
  // to order them by — and it keeps each Joker's copies adjacent too.
  const idDiff = a.id.replace(/#\d+$/, '').localeCompare(b.id.replace(/#\d+$/, ''));
  if (idDiff !== 0) return idDiff;
  return copyIndex(a) - copyIndex(b);
}

/**
 * Deck building, before the deal. The table's whole pool is laid out and the
 * player clicks cards *out* — removal, not selection, because the default deck
 * is the whole thing and most decks are the whole thing minus a grudge. The
 * floor is the mode's `minSize`; at the floor, further removals simply stop
 * working rather than burying the button in a disabled state to explain.
 *
 * Only shown for a `buildable` mode — `classic` submits its pool untouched, so
 * this screen never appears there.
 *
 * The pool comes from the same `buildPool` the engine resolves deals from, so
 * the ids submitted are exactly the ids the table will keep — there is no
 * mapping layer to drift.
 */
export function DeckBuilder({
  seat,
  mode,
  onConfirm,
}: {
  seat: Seat;
  mode: DeckModeId;
  onConfirm: (keep: string[]) => void;
}) {
  const all = useMemo(() => buildPool(seat, mode).sort(byRankThenSuit), [seat, mode]);
  const minSize = DECK_MODES[mode].minSize;

  // Restored from whatever was last confirmed, floor permitting — a deck kept
  // below the current minimum (a rule change, or a mode with a smaller pool,
  // since it was saved) isn't one that could ever be submitted, so it falls
  // back to the whole pool rather than opening on a deck the player would have
  // to fix before doing anything.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => {
    const validKeys = new Set(all.map(cardKey));
    const remembered = new Set([...loadRemembered()].filter((key) => validKeys.has(key)));
    if (all.length - remembered.size < minSize) return new Set();
    return remembered;
  });
  const [submitted, setSubmitted] = useState(false);

  const kept = all.length - removed.size;
  const atFloor = kept <= minSize;

  // Every change is the player's latest word on what they want to play, so it
  // is what the next table opens with — including "took everything back".
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...removed]));
    } catch {
      // Nothing this screen can do about a full or disabled localStorage.
    }
  }, [removed]);

  const toggle = (key: string) => {
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
        playCue('addtodeck');
      } else {
        // Recounted against `next`, not the render's `kept`, so a burst of
        // clicks cannot race past the floor.
        if (all.length - next.size <= minSize) return current;
        next.add(key);
        playCue('addtodeck');
      }
      return next;
    });
  };

  const confirm = () => {
    setSubmitted(true);
    onConfirm(all.filter((card) => !removed.has(cardKey(card))).map((card) => card.id));
  };

  return (
    <section className="deckbuilder">
      <header className="deck-bar">
        <h2>Build your deck</h2>
        <span className="deck-count">
          <strong>{kept}</strong> of {all.length} kept
          <small className="dim"> · minimum {minSize}</small>
        </span>
        <span className="spacer" />
        {removed.size > 0 && (
          <button type="button" onClick={() => setRemoved(new Set())} disabled={submitted}>
            Keep all
          </button>
        )}
        <button type="button" className="confirm" onClick={confirm} disabled={submitted}>
          {submitted ? 'Deck sent' : 'Play this deck'}
        </button>
      </header>

      <p className="deck-hint">
        {atFloor
          ? 'At the minimum — put a card back to remove a different one.'
          : 'Click a card to leave it out; click it again to take it back.'}
      </p>

      <div className="deck-grid">
        {all.map((card) => {
          const out = removed.has(cardKey(card));
          return (
            <button
              key={card.id}
              type="button"
              className={`deck-card ${out ? 'out' : ''}`}
              aria-pressed={out}
              title={out ? 'Take it back' : 'Leave it out'}
              onClick={() => toggle(cardKey(card))}
              disabled={submitted}
            >
              <PlayingCard card={card} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
