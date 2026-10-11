# Assets

## Shipped

| File | Used for |
| --- | --- |
| `ferrari_sheet.png` | 8-frame side-view sprite sheet of the player car (512 × 156 per frame). Other teams' liveries are palette swaps of it, built at runtime by `src/livery.js` (reds → team primary, orange/yellow → accent) |
| `sadgreg.png`, `retire_max_kick.jpg` | Retirement-screen pictures after a crash (one is picked at random) |
| `celebrate_seb_bow.jpg`, `celebrate_alonso_fly.jpg`, `celebrate_seb_p2.jpg` | Retirement-screen pictures when the run set a new personal best (one is picked at random) |
| `favicon.png` | Tab icon |
| `pushinglikeananimal.mp3` | Sustained push, even-km milestones |
| `scream.mp3` | Close calls |
| `sonotright.mp3` | Oil, punctures, botched pit stops |
| `gameover.mp3` | Retirement |

## Meme pack (optional)

The game looks for the files below and uses them when present; anything missing
falls back to the shipped clips or a synthesised cue, so you can add as many or
as few as you like. The title screen's **Meme pack** panel shows what it found.

The real team-radio recordings are FOM's copyright, so they are not in the repo.
Instead `assets/clips/` ships a **synthesised pit-wall voice pack**: every quote
below read by Windows TTS (`<id>.wav`, regenerate with
`pwsh deploy/tools/make-voice-pack.ps1`), which the game runs through a
team-radio filter (band-pass, crunch, squelch). To use the genuine clip, save it
next to the `.wav` with the same stem — `mp3`, `ogg` or `m4a` take precedence
over `wav` automatically. Search the quote on the usual soundboards, trim to
1–4 s, save under the exact filename.

Every clip with words is subtitled on the in-game radio strip (speaker + line,
from `who` / `say` in `src/grid.js`) the moment it starts playing, so the text
always matches the audio. Wordless clips (`thunder`, `penalty`) show the pit
wall's own line instead.

Save into `assets/clips/`:

| Filename | Quote | Plays on |
| --- | --- | --- |
| `lightsout.mp3` | Crofty — "It's lights out and away we go!" | race start |
| `boxbox.mp3` | "Box box, box box." | pit window opens while the car needs the stop (worn/punctured tyres, wing damage, wrong rubber) |
| `hammertime.mp3` | Bono — "It's hammer time." | sustained push (alternates with *pushing like an animal*) |
| `bono.mp3` | Hamilton — "Bono, my tyres are gone." | tyres go over the cliff; puncture; overtaking Hamilton |
| `iamstupid.mp3` | Leclerc — "I am stupid, I am stupid." | oil; overtaking Leclerc |
| `nomichaelno.mp3` | Toto — "No Michael, no! That was so not right." | crash (alternates with `gameover.mp3`) |
| `isthatglock.mp3` | Brundle — "Is that Glock?!" | rain starts; overtaking Schumacher |
| `dudududu.mp3` | "Du du du du Max Verstappen" | overtaking Verstappen |
| `simplylovely.mp3` | Verstappen — "Simply lovely." | chequered flag; close call with Verstappen |
| `gp2engine.mp3` | Alonso — "GP2 engine! GP2! Aaargh!" | overtaking Alonso (either era) |
| `smoothoperator.mp3` | Sainz — "Smooth operator." | overtaking Sainz |
| `what.mp3` | Tsunoda — "WHAT?!" | close call with Tsunoda |
| `bwoah.mp3` | Räikkönen — "Bwoah." | overtaking Räikkönen |
| `leavemealone.mp3` | Räikkönen — "Leave me alone, I know what I'm doing." | close call with Räikkönen; safety-car restart |
| `itsjames.mp3` | "Valtteri, it's James." | overtaking Bottas; team-mate pass fallback |
| `multi21.mp3` | Horner — "Multi 21, Seb. Multi 21." | overtaking your team-mate |
| `getinthere.mp3` | Bono — "Get in there, Lewis!" | chequered flag |
| `wearechecking.mp3` | Ferrari — "We are checking." | safety car deployed; botched pit stop |
| `safetycar.mp3` | "Safety car, safety car." | safety car deployed |
| `penalty.mp3` | any driver discovering a penalty | 5 s penalty |
| `thunder.mp3` | a real thunder rumble | lightning |
| `yesboys.mp3` | Norris — "Yes boys!" | reserved (overtaking Norris) |

Save portraits into `assets/drivers/` as `<driver id>.png` (any size; shown at
up to 620 px wide, landscape works best). When you crash into that driver, the
retirement screen shows their picture instead of sad Greg. `you.png` replaces
sad Greg for crashes into tyres.

Driver ids: `leclerc hamilton verstappen tsunoda norris piastri russell antonelli
alonso stroll gasly colapinto albon sainz hadjar lawson ocon bearman hulkenberg
bortoleto raikkonen bottas schumacher button senna prost hill mansell alonso05
alonso01`.

Liveries, helmets, numbers and radio quips live in `src/grid.js` — add a driver
there and they appear on track immediately.

## SFX (licensed)

`assets/sfx/` holds short recordings that replace a synthesised cue when present.
They play as sound effects (never on the radio channel), and if a file is
missing the synth version plays instead, so every file here is optional.

Shipped:

| File | Plays on | Source | Author | Licence | What was changed |
| --- | --- | --- | --- | --- | --- |
| `chequered_crowd.ogg` | chequered flag, under the *get in there* / *simply lovely* clip | ["F1 Race Crowd Applause Air Horns"](https://commons.wikimedia.org/wiki/File:F1-Race-Crowd-Applause-Air-Horns.wav) (originally [freesound #200809](https://freesound.org/people/WebbFilmsUK/sounds/200809/)) | WebbFilmsUK | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Trimmed to 9.5 s (4.2–13.7 s of the original: the crowd and air horns, no PA voice), raised 5.5 dB, 0.6 s fade-in and 1.5 s fade-out, re-encoded as Ogg Vorbis |
| `record_cheer.ogg` | record pit stop (under 2.0 s) | ["Clapping hurray.ogg"](https://commons.wikimedia.org/wiki/File:Clapping_hurray.ogg) | starlite | Public domain | Trimmed to 2 s (1.0–3.0 s of the original), lowered 4 dB, faded in and out, re-encoded as mono Ogg Vorbis |

Optional, not shipped. Both are CC0 on freesound, which needs a login, so
download them yourself and save them under these exact names:

| File | Plays on | Source | Suggested edit |
| --- | --- | --- | --- |
| `wheelgun.ogg` | each wheel-gun hit in the pit-stop mini-game (the game pitches it up 4 semitones and trims it to 0.3 s) | ["1 Inch Impact Gun"](https://freesound.org/people/dudebrobrodude/sounds/466716/) by dudebrobrodude, CC0 | Trim to one burst of about 0.3–0.5 s |
| `radio_ping.ogg` | the open tone at the start of a pit-wall voice clip | ["Formula 1 radio"](https://freesound.org/people/Fenrir21/sounds/825219/) by Fenrir21, CC0 | Use as is; the game plays the first 0.4 s |

The `mp3`, `wav` and `m4a` formats work too, as long as the file name is the same.
No FOM broadcast audio, F1 theme or real team radio is used anywhere in the game.

## Real engine sound (optional)

The engine is synthesised: a procedural 1.6 L V6 turbo-hybrid whose firing
frequency (rpm / 60 × 3) follows the revs through an eight-speed box, with exhaust
formants, soft clipping, intake hiss, a turbo whistle and an ignition cut on
upshifts. If you have recordings of a real engine you
are allowed to use, drop two seamless loops into `assets/engine/` and the game
switches to them automatically, pitch-tracking and crossfading by rpm:

| File | What to record |
| --- | --- |
| `low.wav` (or mp3/ogg/m4a) | 2–4 s steady loop near idle / low revs |
| `high.wav` | 2–4 s steady loop near the redline |

Both must be present; if either is missing the synth plays.
