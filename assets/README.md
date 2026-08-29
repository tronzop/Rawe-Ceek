# Assets

## Shipped

| File | Used for |
| --- | --- |
| `ferrari_sheet.png` | 8-frame side-view sprite sheet of the player car (512 × 156 per frame) |
| `sadgreg.png` | Default retirement-screen portrait |
| `favicon.png` | Tab icon |
| `pushinglikeananimal.mp3` | Sustained push, even-km milestones |
| `scream.mp3` | Close calls |
| `sonotright.mp3` | Oil, punctures, botched pit stops |
| `gameover.mp3` | Retirement |

## Meme pack (optional)

The game looks for the files below and uses them when present; anything missing
falls back to the shipped clips or a synthesised cue, so you can add as many or
as few as you like. The title screen's **Meme pack** panel shows what it found.

Clips are not included in the repo: team-radio audio is FOM's copyright, so
source your own (the usual meme soundboards have all of these — search the
quote, download, trim to 1–4 s, save as MP3 under the exact filename).

Save into `assets/clips/`:

| Filename | Quote | Plays on |
| --- | --- | --- |
| `lightsout.mp3` | Crofty — "It's lights out and away we go!" | race start |
| `boxbox.mp3` | "Box box, box box." | pit window opens |
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
