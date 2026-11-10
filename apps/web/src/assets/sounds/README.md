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

`src/useSoundCues.ts`. Every board snapshot arrives with the events that made
it, and the cues are read straight off those, the same for your moves and the
opponent's:

- a card played onto a caravan is `addtotrack`;
- a Jack or Joker taking cards off is `removecard` — a Jack lands nowhere, so
  it is heard only as the removal;
- a discard or a disband, given up on purpose, is `addremove`;
- the match being won or lost is `win`/`lose`, after the move's own cue. A draw
  is nobody's win and sounds neither.

One of each per move: a Joker clearing three cards is one `removecard`, not
three, which is what keeps it from sounding like clipping. `startgame` fires on
the first snapshot, which is also when the files are fetched, and that
snapshot's events are not sounded — joining or reconnecting to a match in
progress replays nothing.

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
