# Card sounds

Audio in this folder is picked up automatically at build time — bundled,
content-hashed, and grouped into cues by **the folder it sits in**. Nothing else
needs changing.

```
addtotrack/   a card landing on a caravan
removecard/   a card forced off one — Jack or Joker
addremove/    a card given up on purpose — discard, or a whole caravan disbanded
addtodeck/    a card selected or deselected while building a deck
startgame/    the board appearing
win/          the match decided, your way
lose/         the match decided, theirs
```

A folder name is the cue name; anything else in `assets/sounds/` is ignored.
`CUES` in `src/sound.ts` is the list, and adding to it is what makes a new folder
mean something.

A cue plays a file chosen at random from its folder, so the same move does not
sound identical twice running; with two or more takes it never repeats back to
back. A folder with one file is fine, and an **empty folder is silent**, so a
build with no audio behaves exactly as it did before sounds existed (the mute
button hides itself too).

Filenames inside a folder do not matter. Accepted formats: `.mp3`, `.ogg`,
`.m4a`, `.wav`, `.webm` — MP3 because it is the one format every browser decodes.

In dev the console reports how many takes each cue found, so a misplaced file is
easy to spot.

## What fires them

Two triggers, in `src/useSoundCues.ts`. The mover's own move sounds the instant
it is chosen — `predict` runs it through the shared rules engine and plays off
that, so it never waits on a round trip to the server. Everything else comes
from diffing consecutive board snapshots, the same trick that animates
departures — this is what makes the *opponent's* moves audible, since there is
nothing to predict from for a move nobody here has chosen yet. One `addtotrack`
and/or one `removecard` per snapshot either way: firing once per direction
rather than once per card is what keeps a Joker clearing three cards from
sounding like clipping.

`removecard` is only ever a Jack or a Joker — a card taken off the table against
its owner's will. Giving one up on purpose is `addremove` instead: discarding
from hand, or disbanding a whole caravan. That distinction can only be drawn by
`predict`, from the move itself, so an opponent's disband is still heard as
`removecard`, and an opponent's discard — which never touches the table at all —
stays inaudible. Both are true to how much the client actually knows about the
other side's hand.

The bookends come from the snapshot diff. `startgame` fires on the first
snapshot, which is also when the files are fetched. `win`/`lose` fire when a
snapshot carries a result the one before it did not — so reconnecting to a
finished match is quiet — and they fire *after* the move's own cue, so the
deciding play is still heard as a play. A draw is nobody's win and sounds
neither. A `predict`ed move that happens to decide the match plays its sting
immediately too, the same way.

`src/sound.ts` owns loading, the random pick, and the mute setting (remembered in
`localStorage` under `caravan.sound`).

## Ambience and music

Two sibling folders hold the audio that is always there rather than fired by a
move, loaded the same way by `src/music.ts`:

```
../ambience/   one file, looped forever under everything
../music/      a playlist
```

The music plays a track picked at random, then a random *different* one when
that finishes, forever. Track names come from the filenames, with a leading
`MUS_` and any underscores tidied away, and show in the button's tooltip.

Each has its own mute in the header (`caravan.ambience` and `caravan.music`),
plus a skip button that appears while the music is playing. The 🔊 button
(`caravan.sound`) sits over all of them: off, it silences the card cues, the
ambience and the music; back on, each of those returns to its own setting. Either folder being empty hides its own control and
changes nothing else.

Neither can start on its own: browsers refuse unprompted audio until the page
has been interacted with, so the first click or keypress anywhere is what begins
playback. Volumes are `AMBIENCE_VOLUME` and `MUSIC_VOLUME` in `src/music.ts`,
both set below the cues so the cues stay the thing you hear.

## Importing a pack

The shipped sounds are 44.1 kHz stereo WAVs re-encoded to MP3, which costs about
a tenth of the size at no audible loss for a one-second card sound:

```bash
ffmpeg -i input.wav -codec:a libmp3lame -b:a 128k -ar 44100 output.mp3
```

Playback volume is set in one place — `VOLUME` in `src/sound.ts` — so a pack that
is uniformly too loud does not need re-encoding.

## Licensing

The sounds in use are the *Fallout: New Vegas* Caravan effects. That audio is
Bethesda's and is included here on the owner's decision; it carries no licence
granting redistribution. Anyone forking or republishing this repository should
weigh that for themselves, exactly as with the card art. Replacing the folders
with freely licensed sounds needs no code change.

<!-- Source: -->
<!-- Licence: -->
