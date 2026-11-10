import { redactFor, type RedactedState } from '@caravan/protocol';
import { applyMove, scenario, type GameEvent, type MatchState, type Move, type Seat } from '@caravan/rules';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cue } from '../src/sound.js';

// The cue player is stubbed: what matters here is which cues a sequence of
// snapshots fires, not that jsdom can decode an MP3.
const played: Cue[] = [];
vi.mock('../src/sound.js', () => ({
  playCue: (cue: Cue) => played.push(cue),
  primeSounds: () => {},
}));

const { useSoundCues } = await import('../src/useSoundCues.js');

function Probe({ view, events }: { view: RedactedState; events: readonly GameEvent[] }) {
  useSoundCues(view, events);
  return null;
}

/**
 * Mounts the board on `before`, then delivers the snapshot after `move` the way
 * the table does — the new state together with the events that made it — and
 * returns only what that move sounded like.
 */
function hear(before: MatchState, seat: Seat, move: Move, viewer: Seat = 0): Cue[] {
  const { rerender } = render(<Probe view={redactFor(viewer, before)} events={[]} />);
  played.length = 0;
  const { state, events } = applyMove(before, seat, move);
  rerender(<Probe view={redactFor(viewer, state)} events={events} />);
  return [...played];
}

// Every fixture gives seat 1 a hand and a deck — with neither, the engine ends
// the match the moment seat 0 moves, which is not what these are testing.

describe('useSoundCues', () => {
  beforeEach(() => {
    played.length = 0;
  });

  it('sounds the board arriving, and nothing about what came before', () => {
    const state = scenario({ p0: { caravans: ['7H', '', ''], hand: '5D' } });
    const events: GameEvent[] = [{ type: 'play', seat: 0, cardId: 'x', target: { seat: 0, caravan: 0 } }];
    render(<Probe view={redactFor(0, state)} events={events} />);
    expect(played).toEqual(['startgame']);
  });

  it('stays quiet on a re-render that brings no new events', () => {
    const state = scenario({ p0: { caravans: ['7H', '', ''], hand: '5D' } });
    const events: GameEvent[] = [];
    const { rerender } = render(<Probe view={redactFor(0, state)} events={events} />);
    played.length = 0;
    rerender(<Probe view={redactFor(0, state)} events={events} />);
    expect(played).toEqual([]);
  });

  it('sounds a card landing on a caravan', () => {
    const before = scenario({
      p0: { caravans: ['7H', '', ''], hand: '8D', deckSize: 5 },
      p1: { caravans: ['4S', '', ''], hand: '6S 7D', deckSize: 5 },
    });
    const card = before.players[0].hand[0]!;
    expect(hear(before, 0, { type: 'play', cardId: card.id, target: { seat: 0, caravan: 0 } })).toEqual([
      'addtotrack',
    ]);
  });

  it('sounds a face card attaching to a card already down', () => {
    const before = scenario({
      p0: { caravans: ['7H', '', ''], hand: 'KD', deckSize: 5 },
      p1: { caravans: ['4S', '', ''], hand: '6S 7D', deckSize: 5 },
    });
    const king = before.players[0].hand[0]!;
    expect(
      hear(before, 0, { type: 'play', cardId: king.id, target: { seat: 0, caravan: 0, slot: 0 } }),
    ).toEqual(['addtotrack']);
  });

  it('sounds a Jack as a removal only — it lands nowhere', () => {
    const before = scenario({
      p0: { caravans: ['3H,7S', '', ''], hand: 'JD', deckSize: 5 },
      p1: { caravans: ['4S', '', ''], hand: '6S 7D', deckSize: 5 },
    });
    const jack = before.players[0].hand[0]!;
    expect(
      hear(before, 0, { type: 'play', cardId: jack.id, target: { seat: 0, caravan: 0, slot: 1 } }),
    ).toEqual(['removecard']);
  });

  it('sounds a Joker as one arrival and one removal, however many cards it clears', () => {
    const before = scenario({
      p0: { caravans: ['7H,9D', '7S,10C', ''], hand: 'JKR', deckSize: 5 },
      p1: { caravans: ['7C,8D', '', ''], hand: '6S', deckSize: 5 },
    });
    const joker = before.players[0].hand[0]!;
    expect(
      hear(before, 0, { type: 'play', cardId: joker.id, target: { seat: 0, caravan: 0, slot: 0 } }),
    ).toEqual(['addtotrack', 'removecard']);
  });

  it('sounds a discard as addremove', () => {
    const before = scenario({
      p0: { caravans: ['7H', '', ''], hand: '8D', deckSize: 5 },
      p1: { caravans: ['4S', '', ''], hand: '6S', deckSize: 5 },
    });
    const card = before.players[0].hand[0]!;
    expect(hear(before, 0, { type: 'discard', cardId: card.id })).toEqual(['addremove']);
  });

  it('sounds a disband as addremove, not removecard', () => {
    const before = scenario({
      p0: { caravans: ['7H,9D', '', ''], hand: '2C', deckSize: 5 },
      p1: { caravans: ['4S', '', ''], hand: '6S', deckSize: 5 },
    });
    expect(hear(before, 0, { type: 'disband', caravan: 0 })).toEqual(['addremove']);
  });

  it('sounds the opponent moving, from the other seat', () => {
    const before = scenario({
      turn: 1,
      p0: { caravans: ['7H', '', ''], hand: '5D', deckSize: 5 },
      p1: { caravans: ['4S', '', ''], hand: '6S', deckSize: 5 },
    });
    const card = before.players[1].hand[0]!;
    expect(hear(before, 1, { type: 'play', cardId: card.id, target: { seat: 1, caravan: 0 } })).toEqual([
      'addtotrack',
    ]);
  });

  it.each([
    [0 as const, 'win'],
    [1 as const, 'lose'],
  ])('sounds the deciding move, then the sting, seen from seat %i', (viewer, sting) => {
    const before = scenario({
      p0: { caravans: ['10H,9H,2H', '10H,9H,2H', '10H,5H'], hand: '6H', deckSize: 5 },
      p1: { caravans: ['', '', ''], hand: '', deckSize: 0 },
    });
    const card = before.players[0].hand[0]!;
    expect(
      hear(before, 0, { type: 'play', cardId: card.id, target: { seat: 0, caravan: 2 } }, viewer),
    ).toEqual(['addtotrack', sting]);
  });
});
