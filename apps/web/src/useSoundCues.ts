import type { RedactedState } from '@caravan/protocol';
import type { GameEvent } from '@caravan/rules';
import { useEffect, useRef } from 'react';
import { playCue, primeSounds, type Cue } from './sound.js';

/**
 * Sounds the cards. Every snapshot of the match arrives together with the
 * events that produced it, and this plays whatever those events say happened —
 * for either player's move, as it arrives. No guessing ahead of the table:
 * the table runs in the browser, so the snapshot is never far behind.
 *
 * The first snapshot the board sees is the board arriving (`startgame`), not a
 * move, so its events are not sounded — joining or reconnecting to a match in
 * progress must not replay what already happened.
 */
export function useSoundCues(view: RedactedState, events: readonly GameEvent[]): void {
  // The events the board arrived with. Remembered, rather than a plain "has
  // mounted" flag, so React's development double-run of effects does not
  // mistake them for a move.
  const arrival = useRef<readonly GameEvent[] | null>(null);

  useEffect(() => {
    if (arrival.current === null) {
      arrival.current = events;
      // Fetched only once a match is actually on screen.
      primeSounds();
      playCue('startgame');
      return;
    }
    if (events === arrival.current) return;
    for (const cue of cuesFor(events, view.seat)) playCue(cue);
    // Keyed on `events` alone: a new array arrives with every snapshot, and
    // only with a snapshot, so a re-render for any other reason is silent.
  }, [events]);
}

/**
 * What one batch of events sounds like, in order: the move first, then any
 * win or lose sting over it. At most one of each cue — a Joker clearing three
 * cards is one `removecard`, not three.
 *
 * - `addtotrack`: a card landing on a caravan.
 * - `removecard`: a card forced off one, by a Jack or a Joker.
 * - `addremove`: a card given up on purpose — a discard, or a disband.
 *
 * A Jack is played and then destroys itself along with its target, so a play
 * whose own card is destroyed in the same batch landed nowhere, and is heard
 * only as the removal.
 */
export function cuesFor(events: readonly GameEvent[], you: number): Cue[] {
  const cues = new Set<Cue>();
  const destroyed = new Set<string>();
  for (const e of events) {
    if (e.type === 'destroy' && e.cause !== 'disband') for (const id of e.cardIds) destroyed.add(id);
  }

  for (const e of events) {
    switch (e.type) {
      case 'play':
        if (!destroyed.has(e.cardId)) cues.add('addtotrack');
        break;
      case 'discard':
      case 'disband':
        cues.add('addremove');
        break;
      case 'destroy':
        if (e.cause !== 'disband' && e.cardIds.length > 0) cues.add('removecard');
        break;
      case 'gameOver':
        // A draw is nobody's win, so neither sting fits one.
        if (e.result.kind === 'winner') cues.add(e.result.seat === you ? 'win' : 'lose');
        break;
    }
  }

  const order: Cue[] = ['addtotrack', 'removecard', 'addremove', 'win', 'lose'];
  return order.filter((cue) => cues.has(cue));
}
