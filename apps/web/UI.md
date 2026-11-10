# UI notes

Orientation for changing the board. Read this instead of reading the CSS.

**There is one layout: a phone held sideways.** There is no desktop or upright
version. A bigger screen gets the same layout with bigger cards, because card
size comes from the screen's height. An upright phone — rotation lock on, or
just not turned yet — gets the same table drawn sideways and turned a quarter,
so the player turns the phone to play. The pages outside a match stay upright.

The one rule that shapes everything: **all theming lives in `src/styles.css`**,
and components carry no styling decisions. Anything that looks like a design
choice belongs there. The exception is the handful of numbers that depend on how
many cards are actually on the table, which CSS cannot compute — those live in
`src/layout.ts` and are handed to CSS as custom properties.

## Where things are

| File | Owns |
|---|---|
| `src/App.tsx` | Landing page, new-table options, the session panel, the result overlay, connection state |
| `src/DeckBuilder.tsx` | Trimming the table's card pool down before the deal |
| `src/Board.tsx` | The table: columns, caravans, centre line, and the rail (piles, hand, discard, Menu) |
| `src/PlayingCard.tsx` | One card face — supplied art, or a face drawn in CSS |
| `src/cardArt.ts` | Matching image files to cards at build time |
| `src/layout.ts` | The numbers CSS cannot work out for itself |
| `src/rotation.ts` | Placing the dragged card when the page is turned |
| `src/useCardDrag.ts` | Drag-to-play, on pointer events |
| `src/useDepartures.ts` | Keeping destroyed cards alive long enough to animate out |
| `src/sound.ts` | Loading sound files, the random take, the mute setting |
| `src/useSoundCues.ts` | Deciding which sound a snapshot means |
| `src/styles.css` | Everything else |

## The layout

`main.playing` (set while a match is on screen) pins the page to exactly one
screen with no scrolling. `.board` is two columns, both the full height: the
three tracks, and a rail.

```
tracks                 rail
[ ] [ ] [ ]            [opponent pile]        [Menu]
theirs / yours ×3
[ ] [ ] [ ]            turn line
                       [hand, flat, overlapping]
                       [Discard]              [your pile]
```

The rail is exactly as wide as a full eight-card hand at its loosest spacing
(`card-lw × 5.1`), and the pair is spread with `space-evenly`, so spare width
collects round the pair rather than as a gap inside the rail.

Inside the table, each of the three tracks is a `.column`, holding an opponent
`.caravan`, a `.gauge`, and your `.caravan`. A caravan is a fixed-height box
(`--rows` card-heights) with absolutely positioned `.slot`s. Both sides build
**outward from the centre line**: `.side-you .slot` offsets from `top`,
`.side-opponent .slot` from `bottom`. So the first card played sits against the
middle and the newest — the one that decides what may legally follow — is fully
visible at the far end.

The `.gauge` between them is two lines, their total over yours, with the ✕ that
disbands yours. A decided track tints the gauge (`.track-won`, `.track-lost`).
Caravans have no header of their own.

The opponent's hand is redacted (the snapshot carries only `handCount`), so it
is shown as a count — the `+N` on their pile — not as cards. The session panel
(code, seats, connection, Leave, audio) sits behind the Menu button, in
`.menu-sheet`; on the start page it stands on its own instead.

**Height is the limit.** At about 390px tall, both halves and the centre line
have to fit, so `--card-h` is worked out from the screen height on `:root`, and
caravans pack into `STACK_ROWS` (1.9) card-heights each — a long caravan shows
little more than each card's corner index. The start page, table options and
deck builder are tightened for a short screen too, and scroll if they still do
not fit.

## Upright phones: the table is turned

Safari gives a web page no way to lock orientation, even one added to the Home
Screen. So under `@media (orientation: portrait)` the table (`main.playing`,
with its Menu and result banner) is drawn at the screen's height × width and
turned 90° clockwise. Its top faces the screen's right edge; the player turns
the phone to their left.

The start page, table options and deck builder are **not** turned. They were
once, but the on-screen keyboard is drawn upright by the phone whatever the
page does, so typing a room code into a turned page was a mess. Upright, the
deck builder's cards are sized from the width instead (about six to a row).

- **`main` is the page.** It is `position: fixed`, exactly one screen, and
  scrolls inside itself when its content does not fit (the deck builder). The
  document never scrolls.
- **`--app-w` / `--app-h` swap** on `main.playing` when upright, and the card
  variables are declared on `main` (not `:root`) so they follow the swap.
- **A transformed element is the containing block for `position: fixed`
  inside it.** The Menu sheet and result banner turn with the table for free.
  The dragged card needs the finger's screen position mapped into the turned
  frame (`toPageFrame` in `rotation.ts`). Hit testing needs no mapping:
  `elementFromPoint` works on what is drawn.
- **Safe areas turn too.** The screen's top (the notch) becomes the page's
  left, so `main` swaps its four `env(safe-area-inset-*)` values round.
- **System UI does not turn**, which is why only the table is turned: it has
  no text fields.

`ROTATED_QUERY` in `rotation.ts` and the `@media` query in `styles.css` must
match.

## Interaction

Two routes, one source of truth. `Board` asks `listLegalMoves` for every legal
play and groups them by card into `targetsByCard`. The active card is the
dragged one if a drag is running, otherwise the selected one.

Destinations are identified by a **drop key** in a `data-drop` attribute:

- `c:<seat>:<caravan>` — append to a caravan (number cards)
- `s:<seat>:<caravan>:<slot>` — attach to one card (face cards)
- `discard` — the discard pile

The discard pile is kept out of `targetsByCard`, in a set of its own: nearly
every card can be discarded, so folding it in would mark every card playable.

Both a caravan and the cards inside it carry keys, so they nest. The hit test in
`useCardDrag.ts` walks **outward** from the deepest one and takes the first key
that is a legal destination for the held card. That is what lets a face card
land on the exact card under the pointer while a number card dropped on the same
spot falls through to "append to this caravan". The dragged card is drawn above
the finger rather than under it, so the finger does not hide it.

Dragging is built on pointer events, not HTML5 drag-and-drop — the only way to
get mouse and touch on one path, and it keeps the dragged card an ordinary
element we can style. A press becomes a drag past `DRAG_THRESHOLD` (6px);
shorter presses are clicks, so selecting and dragging are the same gesture until
they visibly differ.

## Tuning knobs

In `:root` (`styles.css`):

| Property | Meaning |
|---|---|
| `--card-h` | Card height, from the screen height (and capped by its width) |
| `--card-w` | Card width, from `--card-h` |
| `--card-lw` / `--card-lh` | Cards in hand (5% larger) |
| `--caravan-w` | Column width, currently `card-w × 1.6` |
| `--slide` | The deal animation |
| `--restack` | A caravan closing the gap after a destroyed card has gone |

In `layout.ts`:

| Constant | Meaning |
|---|---|
| `STACK_ROWS` | Height of one player's half, in card heights. Fed to CSS as `--rows`. |
| `MAX_OVERLAP` | Loosest spacing between cards in a caravan |
| `overlapStep(n)` | Tightens spacing as a caravan grows so a long one cannot run off the table. Fed to CSS as `--step`. |

Per-element custom properties: `--i` (slot index, or hand position), `--ai`
(attachment index), `--gaps` (spaces between hand cards).

## Traps

These are all things that have already gone wrong here.

**1. `.slot` transforms belong to the deal animation.** `.slot` runs
`animation: deal … both`, and the animation's final `transform: none` overrides
anything you set in a normal rule. So slots are centred with `left`, not
`translateX`, and hover effects go on the child `.slot-card` button. This has
bitten three separate changes — check it first when a transform "does nothing".
The result overlay has its own `result-in` keyframes for exactly this reason:
reusing `deal` would have thrown away its centring translate.

**2. `.slot` sets `z-index: var(--i)`, creating a stacking context per slot.**
Nothing inside a slot can paint above a *neighbouring* slot. To lift a card
clear of the ones overlapping it, raise the `.slot`, not the button.

**3. `STRIKE_MS` and `DEPARTURE_MS` must equal the CSS `struck` and `depart`
durations.** `useDepartures.ts` decides how long a destroyed card stays in the
DOM; the CSS decides how long each of its two beats takes. Change one without
the other and cards vanish mid-flight, or sit still after the animation ends.

**3b. A departing slot mounts fresh, so it runs `deal` unless something else
claims the animation.** That is why `.slot.struck` has keyframes at all despite
barely moving: without them a card would fly *in* from off-screen purely to be
destroyed. Same reason `.attached-card.settled` exists.

**4. The height budget is shared.** `--card-h` reserves 4.4rem for the gauge
and the page edges, and divides the rest by 3.9 (two halves of `STACK_ROWS` plus
a little slack). Make the gauge taller, raise `STACK_ROWS`, or add padding, and
the table runs off the bottom of a phone. Change them together and measure at
about 844×390.

**5. Disabled buttons swallow clicks entirely.** A card that is not itself a
destination must not intercept the gesture, or clicking the pile to extend it
does nothing. Hence `.slot-card:disabled { pointer-events: none }`. Attachments
are inert for the same reason — they sit over the number card, which *is* a drop
target.

**6. Overlap means highlights hide.** Cards overlap by up to three quarters, so a
ring drawn around a card mid-caravan is mostly behind its neighbour. Feedback has
to move the card, not just outline it.

## Removals happen in two beats

A snapshot that takes a card off the table is the same snapshot that plays the
card doing the taking. Animating both at once means the cause and its effect
land in the same instant and neither reads — which is exactly how this used to
look: cards simply flew away and the Jack was never seen at all.

So a removal is staged. `useDepartures` holds the departed cards in place for
`STRIKE_MS` (`.slot.struck` — a small flinch, nothing more) and only then lets
them go (`.slot.departing`). The delay applies when a played card is known to be
responsible; a disband has no such card, so its cards leave immediately.

**The caravan keeps its old shape for the whole removal.** Slot positions come
from `--i`, and the snapshot's indices shift the instant a card is taken out —
so the cards under a struck one would close the gap while it is still visibly
sitting in it, and the *survivor* sliding upward reads as the card being
removed. `CaravanView.layout` fixes the positions instead: it splices the
departed cards back in at the index they held and positions every card, living
or leaving, by that. Only when the departures are dropped does the caravan close
up, and `--restack` (a `top`/`bottom` transition on `.slot`) makes that a glide
rather than a jump.

Knowing *which* card is responsible is the one thing the board reads from the
event feed rather than the snapshot. **A Jack is in no snapshot** — it destroys
itself along with its target, in the same instant it attaches — so there is
nothing on the table to animate it from. The `play` event names it by id and
`cardFromId` (in `@caravan/rules`) rebuilds the face from that id, since ids are
written as `p<owner>:<rank><suit>`. `Board.readStrike` pairs a `destroy` event
with the `play` in the same batch; `net.ts` patches `events` and `match`
together and never separately, so they cannot drift apart. *Which* cards left is
still found by diffing snapshots, as before — the events only say why.

A Joker is different: it survives, attached to its host, so it is already in the
snapshot and is drawn the ordinary way. Its strike is still reported, and there
its only job is the pause — the cards it destroys are in other caravans, and
they wait for it to land.

**Face cards land rather than appear.** `.attached-card` animates in over 1s —
the same second `--slide` gives a number card being dealt onto the table — and
`STRIKE_MS` is that second plus a short beat, so a Jack has finished arriving
before its victim starts to leave. This covers Queens and Kings too, which previously popped into
place with no animation whatsoever. It replays only on a fresh element, and
attachments are keyed by card id, so a landed face card stays landed across
snapshots. The exception is a departing slot: that is a *new* node rebuilt from
the destroyed card, so the attachments it already had carry `settled` (which
kills the animation) and only the Jack animates.

## Card art

`cardArt.ts` globs `src/assets/cards/**` at build time and matches files to cards
by folder and filename. A card with no image falls back to the CSS-drawn face in
`PlayingCard.tsx`, so a partial set works.

When art is present the wrapper draws nothing of its own — no background, border
or box-shadow — because the image carries the card's shape, and cut-out art has
transparent corners. Depth comes from a `drop-shadow`, which follows the alpha.
That is why highlight rings on art cards are `drop-shadow` filters rather than
`box-shadow`: a box-shadow would trace the element box, not the card.

See `src/assets/cards/README.md` for naming and the import scripts.

## Deck modes

A table is created with one of the modes in `DECK_MODES` (`packages/rules/src/decks.ts`),
chosen on the options screen and applied to both seats:

| Mode | Pool | Builder? |
| --- | --- | --- |
| `classic` | the standard 54 | no |
| `build` (default) | the standard 54 | yes |
| `double` | 108 — two of every card, four Jokers | yes |

The mode is a declarative row, not a branch: `copies`, `include`, `buildable`
and `minSize`. A new mode ("no face cards", "numbers only") is one entry and no
change here, in `App.tsx`, or in the host's table.

The second copy of a card carries a `#2` tag on its id (`p0:AS#2`); copy one
keeps the bare id it always had. That is what lets duplicates exist at all —
every id stays globally unique, so React keys, `targetsByCard`, the
`useDepartures` diff and the `useSoundCues` diff all keep working with no notion
of multiplicity. `cardFromId` already stripped a `#n` tag, so nothing in the
notation layer needed teaching.

Two consequences worth knowing:

- **`fullPool` opens with the classic deck in its original order.** A
  single-copy keep list therefore deals exactly what it dealt before modes
  existed, which is what keeps recorded replays reproducing. Do not reorder it.
- **A replay records no mode.** Ids say what the deck is, so `{seat, decks,
  moves}` is still the whole record. `checkDeckSelection` is the mode-aware
  check the hub applies; `checkDeckPlayable` is the mode-agnostic one
  `createMatch` uses, because a replay has no table attached.

The mode reaches the client only on the `room` frame, never from whatever was
picked on the options screen — a seat that joined by code, or reconnected, never
saw that screen.

## Deck building

`DeckBuilder.tsx` lays out `buildPool(seat, mode)` — the same cards the engine
deals from — as a grid of ordinary `.card`s wrapped in buttons. Clicking one
toggles it out; there is no separate "selected" state to reconcile, because
"kept" is just "not in the removed set". The floor (the mode's `minSize`) is
enforced by refusing the click that would cross it rather than disabling cards
in advance — with 54 (or 108) buttons on screen, precomputing which ones are
still legal to remove would mean recomputing every button state on every click
for a fact (`kept > floor`) that is one number.

The grid sorts rank-first, and copies of a card land adjacent, so "keep one 7♥,
not two" is a legible choice rather than a hunt.

`App.tsx` decides whether to show it: as soon as a seat exists and the match
hasn't been dealt, gated on `!decksReady[seat]` rather than local component
state, so a refresh mid-build resumes into the right screen — the host's
bookkeeping is the source of truth for "have I already sent mine", the same way
`RedactedState` is the source of truth for everything else here. It appears the
moment a seat is granted, not once an opponent joins; there is no reason to make
the host wait to start trimming.

A mode that isn't `buildable` never shows the screen: `App.tsx` submits the
whole pool itself, gated on that same `decksReady`, so the player goes straight
to the table and a refresh doesn't resend a deck the host already has.

Removals are remembered in `localStorage` by card key with the owner prefix
stripped but the `#n` tag kept, so the two copies are remembered separately, and
a key belonging to another mode's pool is simply filtered out on load.

Validity is the rules engine's call (`checkDeckSelection`), applied identically
on both ends — the client's floor enforcement is advisory UI, exactly like
legality highlighting, and the host's table re-checks a submitted deck independently
before ever dealing from it.

## Rematch

The offer sits on the result overlay, which is otherwise inert (`pointer-events:
none`, so the final board still reads through it) — the button takes the pointer
back for itself and nothing else does.

It is an offer, not a command: the host's table holds `rematch[seat]` per side and only
redeals once both are set, so the button's own label is the whole state machine
("Rematch" → "Waiting for your opponent…", or "Accept rematch" when theirs
landed first). A solo table redeals on the host's click alone; the AI is always
willing.

A rematch keeps the room — same code, same seats, same tokens — and throws away
only the match: fresh seed, no moves, both decks cleared, so it lands back in the
deck builder rather than skipping it. The client notices by the `room` frame
alone: status back to `building` with a match still on screen means the finished
board is cleared. Note that a room whose match is decided is **not** reported as
`ended` — rooms report `ended` only when the host's table has actually let them go, and
`frozen` for a decided match comes from `match.result` instead.

## Sound

`sound.ts` globs `src/assets/sounds/**` the same way, but groups by **folder**
rather than filename: one folder per cue, however many interchangeable takes
inside, picked at random and never twice running. Empty folders are silent, and
the mute button in the panel hides itself when nothing is bundled.

`useSoundCues.ts` has two triggers, not one, because one source cannot serve
both seats:

- **The mover hears `predict`.** `Board`'s `fire` calls it synchronously, before
  `onMove` even reaches the link to the table. It runs the move through the same shared
  engine used for legality (`applyMove` on `hydrateForClient(view)`) and plays
  off *that* result. On a laggy connection this is the difference between the
  sound landing with your click and it landing hundreds of milliseconds later
  with the host's echo — which is what it replaced. (A host's own moves come back
  almost instantly over its local link; a guest's cross the network both ways.)
- **Everyone hears the snapshot diff.** The effect that watches `view` still
  diffs consecutive snapshots, and it is the only source for the opponent's
  moves — there is nothing to predict from for a move nobody here has chosen.
  For the mover, it is also the fallback: `predict` advances the same
  `previous` ref its diff reads from, so a correctly predicted move's echo
  diffs to nothing and is not replayed, while a move that lands differently
  than predicted (a desync — not expected, but the ref is only ever advisory)
  is still caught and heard for real.

One cue per direction, not one per card: a Joker clearing three cards is one
`removecard`, and a move that both attaches and destroys fires both. The
bookends ride the same two paths — `startgame` on the first snapshot (nothing to
predict a board arriving from); `win`/`lose` from whichever trigger notices the
result first, `predict` if the deciding move was this seat's own, the diff
otherwise, always after that move's own cue rather than in place of it.

`removecard` means a Jack or a Joker took the card — against its owner's will.
A voluntary discard or disband is `addremove` instead, and `predict` is the only
place that can tell them apart: it branches on `move.type` directly rather than
diffing the table, since a discard never touches the table (nothing to diff)
and a disband's removal would otherwise look identical to a Jack's. This is also
why an opponent's disband still plays as `removecard` — the diff has no move to
read, only card ids that disappeared — and an opponent's discard stays
inaudible, matching how little the client is told about the other side's hand.

Four things worth knowing before editing it. The **first snapshot sounds only
`startgame`** — joining or reconnecting to a match in progress would otherwise
replay every card on the board at once, and a match that has already ended would
replay its own outcome. **A draw is silent**, having no side to congratulate.
**`predict` never throws** — a rejected `applyMove` is swallowed, since a
prediction is advisory and the board only ever fires moves it already asked
`listLegalMoves` for. And `play()` returns a promise in browsers but nothing
under jsdom, so the rejection handler is attached defensively; browsers also
refuse to play before the page has been interacted with, which is swallowed
rather than reported — `startgame` gets away with it because clicking **Create a
table** is that interaction.

See `src/assets/sounds/README.md` for the folder layout and the encoding
one-liner.

## Known loose ends

- **Unverified in a browser:** the attached-face-card overlap, the drag-over
  lift, and the result overlay. Written and type-checked, never looked at.
- **`plan.txt` still describes the move log** (lines 274, 358, 450), which no
  longer exists.
- **The turned table on a real iPhone is unverified** — safe areas in
  particular. It is right in the browser's phone emulation.
