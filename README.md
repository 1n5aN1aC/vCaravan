# vCaravan

A rules-correct, self-hosted, browser-based 1v1 implementation of Caravan, the
card game from *Fallout: New Vegas*.

The game's rules are notoriously badly explained — the wikis, guides and the
shipped game itself disagree on several points. This project resolves every
conflict deliberately and encodes the result as a tested engine, so there is
something concrete to point at and say "that's how it actually works". The
authoritative ruleset, and the reasoning behind each resolution, lives in
[`plan.txt`](plan.txt).

## Running it

There is no server. The whole game is a static site: the player who creates a
table runs it in their own browser tab, and the other player's tab connects to
it directly over WebRTC, found through [PeerJS](https://peerjs.com/)'s free
public broker.

```bash
pnpm install
pnpm dev        # http://localhost:5173, with hot reload
```

Open the page, click **Create a table**, and share the six-letter code. The
second player enters it on the same page, from anywhere — not just the LAN.

To build and serve it as it would be deployed:

```bash
pnpm build      # writes apps/web/dist
pnpm start      # serves that build on http://localhost:8787
```

`apps/web/dist` is self-contained and uses relative URLs, so it can be dropped
onto any static host — GitHub Pages, Netlify, an S3 bucket — at any path.

A seat is held per browser tab, so two tabs of the same browser can play each
other.

### What "no server" still depends on

- **The PeerJS broker** (`0.peerjs.com`), only to introduce the two tabs. Once
  they are connected it carries nothing. It is a free service with no uptime
  promise; if it is down, new tables cannot be found, though a match already
  under way carries on. `peerJsNetwork()` in `apps/web/src/peer.ts` takes
  PeerJS options to point at a self-hosted `peerjs-server` instead.
- **PeerJS's free STUN and TURN servers.** PeerJS's default ICE config uses
  Google's public STUN server, which connects most home networks directly, and
  PeerJS's own TURN relays (`eu-0` and `us-0.turn.peerjs.com`). The relays are
  the fallback when both players are behind strict NATs (some corporate and
  mobile networks); traffic then goes through the relay instead of peer to
  peer. They are free, shared and carry no uptime promise either, so a pair
  that needs one can fail to connect when they are busy or down. Your own TURN
  servers go in `config.iceServers` in the same options; setting it replaces
  the defaults rather than adding to them.
- **Finding a game means sharing a code.** There is no lobby or random
  matchmaking: listing who is online needs something shared to list it, and
  the public broker deliberately does not offer that.

## Layout

| Package | What it is |
|---|---|
| `packages/rules` | The engine. Pure, no I/O, no framework, injected seeded PRNG. |
| `packages/protocol` | Wire message types, Zod schemas, and the redaction choke-point. |
| `packages/host` | The table: rooms, seats, tokens and the AI. Pure TypeScript, run in the host's tab. |
| `apps/web` | React + Vite. The board, plus the host's table and the PeerJS links between tabs. |

`packages/rules` is the centrepiece. The host imports it as the authority; both
tabs import the *same* code to highlight legal moves without a round-trip. The
rules are written and tested exactly once.

`packages/host` is what used to be the server, minus the HTTP and WebSocket
code. Its `Hub` never knew what a socket was — it talks to seats through a
two-method `Connection` — so it moved into the browser unchanged in substance.
In the web app, `HostTable` (`table.ts`) runs it and owns the PeerJS
registration; `CaravanClient` (`net.ts`) is one tab's seat, talking to its own
tab's table over a local link or to the host's tab over a PeerJS channel.

### Authority and secrecy

The host's table owns deck order, both hands and all state. Seats send intents
and receive only what they may see. Client-side rules are advisory UI only —
every move is independently re-validated by the table, and a rejected intent
triggers a resync. The host's own seat goes through exactly the same path as
the guest's, over a local link instead of a PeerJS channel.

**The host can cheat.** The table runs in the host's tab, so the guest's hand,
both deck orders and the seed are all in that tab's memory for anyone who opens
the dev tools. Redaction still keeps them off the wire, so the guest learns
nothing it shouldn't; it is the host that is trusted. Removing that trust needs
a cryptographic shuffle (mental poker), which is a project of its own. Play
with people you would play cards with in person.

`redactFor(seat, state)` is the single function by which state reaches the wire;
`hydrateForClient` is its exact mirror. A test asserts that the legal-move list
computed from *redacted* state is identical to the one computed from
*authoritative* state at every ply — if those ever diverge, the UI would
highlight moves the host rejects.

## The table

The board is built for one shape: a phone held sideways. Held upright — with
rotation lock on, say — the table is drawn sideways and turned, so the
player turns the phone to play. The start page and deck builder stay upright. It is laid out as
cards on a table rather than as rows of form controls, and the whole match fits
one screen without scrolling. Each of the three tracks is a column, and both players build **outward from a
shared centre line**: the first card of a caravan sits against the middle, and
the newest — the one that decides what may legally follow — is the fully visible
card at the far end. The two totals face each other across the track they are
contesting. Beside the tracks is a rail: the opponent's pile, showing their deck
and how many cards they hold, then your hand lying flat, then a discard pile and
your own deck. The session controls sit behind a Menu button. Face cards played
onto a number card lie over it, offset far enough to leave the number readable.

A card is played either by tapping it and then tapping its destination, or by
dragging it there. Discarding is the same: drop the card on the discard pile, or
tap it with the card selected. Both routes ask `listLegalMoves` for that card's destinations
and light exactly those, so the highlighting *is* the rules — which makes the UI
the clearest available explanation of Caravan's placement rules.

All theming lives in `apps/web/src/styles.css`; the components carry no styling
decisions, so the look can be replaced without touching a `.tsx`. One number has
to be shared with the components because it depends on how many cards are
actually on the table, which CSS cannot work out: how tightly a caravan packs as
it grows. It lives in [`apps/web/src/layout.ts`](apps/web/src/layout.ts).

[`apps/web/UI.md`](apps/web/UI.md) is the orientation guide for changing any of
this: what each file owns, and the traps worth knowing before editing.

## Development

```bash
pnpm test        # every suite
pnpm typecheck   # every package
```

Two debugging tools live in the engine:

```bash
pnpm demo -- --seed=hello --plies=40                    # play a match, print the board each turn
pnpm --filter @caravan/rules stats -- --matches=300     # how random matches end
```

### Card artwork

A full deck ships with the repository, so a clone comes with the cards already
installed — the *Fallout: New Vegas* casino art, cut out so each card sits on the
felt with its own silhouette rather than as a rectangle.

To use a different pack, replace the images in `apps/web/src/assets/cards/`. They
are matched to cards by folder and filename — `faces/AS.png`, `jokers/joker1.png`,
`backs/tops.png` — and bundled automatically. Any card without an image falls
back to a face drawn in CSS, so a partial set works and an empty folder still
gives a playable deck. See [that folder's README](apps/web/src/assets/cards/README.md)
for the naming rules, the import and downscaling scripts, and the licensing note:
the shipped art is Bethesda's and carries no redistribution licence, which is
worth weighing before forking.

### Sound

Cards are audible: a card landing on a caravan, a Jack or Joker forcing one off,
a discard or disband given up on purpose, and single stings for the table
opening and for the match being won or lost. The card cues hold several takes
each and pick between them at random, so a long game does not turn into the same
click over and over.

Your own move sounds the instant you make it — it does not wait on a round trip
to the server, so it is not held hostage by your own connection the way it would
be if it only fired on the server's reply. The opponent's moves still come from
watching the board change, since there is nothing else to go on for a move you
did not make. The speaker button in the session panel mutes all of it for good.

To use different sounds, replace the folders in `apps/web/src/assets/sounds/` —
one folder per cue, any filenames, any number of takes. An empty folder is silent
and hides the mute button. See [that folder's README](apps/web/src/assets/sounds/README.md)
for the layout, the encoding one-liner, and the same licensing note as the art:
the shipped audio is Bethesda's.

### Terminology

A caravan is **sold** only when it is in the sell range *and* strictly beating
the caravan facing it. The distinction matters, so the names do too:

| Term | Meaning |
|---|---|
| `canSell` | value is within 21–26 — a property of one caravan alone |
| `sold` | in range **and** beating the caravan opposite; has taken the track |
| `outbid` | in range but losing to a higher caravan opposite |
| `tied` | level with the caravan opposite, so the track stays undecided |
| `overburdened` | over 26; still playable, but cannot sell |
| `building` | under 21 |

### Determinism

The engine's only source of randomness is an injected seeded PRNG —
`Math.random()` never appears in `packages/rules`. Every room records its seed
and ordered move list, so `replay({ seed, moves })` reproduces any match exactly.
That is the debugging tool: "it did something weird" converts directly into a
fixture.

## Not in v1

Accounts, matchmaking, ranking, chat, spectators and a move log. The structure
accommodates each without rework — see "Designed-for extensions" in
[`plan.txt`](plan.txt).

The host's tab saves its table to session storage after every change, so a
reload — of either tab — puts the match back where it was: the host's tab
reclaims its code on the broker, and the guest, which has been redialling all
along, resumes its seat by token. Closing the host's tab ends the match once
the guest's 90s grace window runs out.

Cards are animated — dealt, slid off the table when destroyed, and dragged — so
that entry has left this list. The table still sends a per-move event stream
alongside each snapshot; nothing reads it today, and it is what a move log or a
replay viewer would be built on.

Deck building has left the list too, in its simplest possible form: no
curation, no rarity, no swapping in cards you don't already own — trimming down
from the full 54. See "Deck building" below.

So has the AI opponent, in the same spirit — deliberately not clever. See
"Single player" below.

### Single player

"Create a table" now asks what kind of table before opening one, because the
deal depends on the answer: an opponent seat filled by the AI has to be filled
before the cards go out. Choose the computer and you also choose a difficulty;
choose another player and nothing about the room differs from before.

The AI is a `Connection` occupying seat 1, so presence, room status, redaction
and "that room is full" all keep working with no special cases, and its moves go
in through the same `move` path a guest's do — re-validated by the engine and
recorded in `room.moves`, so a solo match replays from `{ seed, decks, moves }`
like any other. It plays the table's whole pool and submits that deck at create
time — the deck a player who trimmed nothing would bring — which
leaves the deal waiting only on the host. It answers after a fixed delay
(`BOT_DELAY_MS`) so the table does not snap.

`chooseMove` (`packages/host/src/bot.ts`) never disbands a caravan that wasn't
already unsellable, and never returns anything `listLegalMoves` didn't already
call legal. Past that, the first three difficulties are different tiers of
effort, not the same algorithm with a knob turned — and the fourth is the third
told something it is not otherwise allowed to know:

- **easy** — one ply, no search: scores each legal move by applying it and
  asking how much closer its own board is to the 21–26 band, and takes the
  best. Ignores the opponent entirely.
- **medium** — the same one-ply scorer with the opponent's board subtracted,
  which is the whole of its offense. Destroying a 24 with a Jack and Kinging a
  13 into an unsellable 27 both fall out of that one sign flip — and so does
  the restraint, since Kinging their 12 into a tidy 24 scores as the gift it is.
- **hard** — a fixed evaluation function, searched two plies deep. Each
  caravan is scored by the actual `caravanStatus` the engine would resolve it
  to (`sold`/`tied`/`outbid`/`overburdened`/`building`), not just its value, so
  it knows a 24 that only ties is worth less than a 24 that wins — something
  `medium`'s plain sum can't see, since two moves that leave its own board at
  the same total score identically to it. A sale is also priced by how much of
  itself sits in one slot, since a 24 standing on a King-doubled 10 dies to a
  single Jack where a 24 spread over five cards does not; and holding two of
  the three tracks earns a bonus of its own, because two of three is the match
  once the third resolves and a per-lane sum is linear in how many are sold.
  Both of those are reasoned rather than measured — see `laneScore`. For each
  candidate move, `hard`
  looks one reply ahead: the opponent's best response, scored by the same
  evaluation *and the same `spendCost`* the bot judges itself by — an opponent
  model cheaper than that is a worse player than the bot, and every candidate
  would be judged against a softer reply than the one actually coming.
  It does not know the opponent's actual hand or either deck's real draw
  order — even though both are sitting right there in `MatchState` — so
  that reply is judged against several sampled hands dealt from whatever
  cards the opponent could still plausibly be holding, and the scores are
  averaged. Every candidate is judged against the *same* sampled hands, so
  two close moves are separated by the position rather than by whose sample
  happened to be kinder. What it believes those cards to be is only what a
  player in that seat could work out: the table's deck mode is public, so it
  assumes the whole of that mode's pool — the deck an opponent who trimmed
  nothing would bring. That assumption is wrong about every card a trimmed
  deck no longer holds, and it stays wrong all game. Weighting the worse half
  of the sampled worlds to hedge against exactly that was tried and measured
  as a loss — see `hardScore` for the numbers, and don't re-derive it. See
  `hiddenPool` and `sampleWorlds` in `bot.ts` for what "plausibly" means.
- **extreme** — `hard`, told which cards you actually kept when you built your
  deck, and searching a ply deeper. It samples your hand from what you are
  really holding cards from rather than from a 54 you may have cut half of; it
  still never sees your hand itself, or the order of either deck. That
  knowledge is something no human opponent could have, since deck composition
  is private on the wire (a seat is told `decksReady`, never the cards), which
  is why it is its own difficulty rather than something `hard` quietly does.

  The third ply is there because the knowledge is worth nothing without it.
  Measured against `hard` with everything else equal, deck-aware sampling alone
  came out level — it reaches the search through the sampled hand, and at two
  plies that hand decides exactly one greedy reply, far too small a lever to
  spend it on. With the extra ply — the bot's own best answer to that reply, in
  the same sampled world — `extreme` beats `hard` 35-13 over 48 paired matches
  and the two-ply version of itself 40-8. Depth is the lever in this bot, which
  is worth knowing before reaching for a cleverer evaluation. It costs roughly
  twice `hard` per move.

Two things every difficulty knows, because a scorer without them produces
moves that are legal and pointless. A caravan past 26 is scored flatly, however
far past: the ways back — a disband, or a Jack — are the same at 27 as at 40,
so piling more onto a dead caravan is not progress, and doubling a card on one
is not sabotage. And a card played is a card gone (`spendCost`), priced small
enough to matter only between moves the evaluation cannot otherwise tell apart
— so when nothing on the table can be improved, the bot pitches its least
useful card instead of burning a Jack on nothing.

Randomness — both the sampling and the tie-breaks — comes from the engine's
seeded PRNG, so the same position always yields the same choice at every
difficulty.

Strategy lives in `packages/host`, not in `packages/rules`, which stays a statement
of how the rules work and holds no opinions about how to win.

### Deck building

Both players see their own full 54 before the deal and trim it down to
whatever they don't want, with a floor of `RULES.MIN_DECK_SIZE` (30) cards. The
whole interaction is removal, not selection — a room enters `building` the
moment both seats are claimed, each side submits once, and the deal fires the
instant the second deck is in. A seat can start trimming immediately after
creating or joining a room; there is no reason to make the host wait on an
opponent before deciding what to cut.

The rules engine owns validity (`checkDeckSelection`) and dealing from a
built deck (`createMatch(seed, decks)`) exactly the way it already owns move
legality — the host re-validates independently, so the client's floor
enforcement is advisory UI, same as everywhere else in this project. A deck
thin enough on number cards to make the ordinary auto-mulligan loop struggle
falls back to a stacked deal rather than failing outright; both paths are
seeded, so a match started from any pair of decks still replays exactly from
`{ seed, decks, moves }`.
