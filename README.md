# Rawe Ceek

A Ferrari-fan survival racer in plain HTML5 Canvas + JavaScript. No build step, no runtime dependencies.

You are the red car — or the papaya one, or the silver one: pick any of the ten current teams' liveries on the title screen, each with its own handling. The track scrolls under you at ever-increasing speed through a fourteen-round calendar — Monza to Bahrain, three of them under floodlights. Dodge loose tyres, rival cars, oil and debris; ride the slipstream; manage your tyre wear and temperature; behave behind the safety car (the field bunches to its pace — lift to drop back, and you get a moment's grace after the yellow); box in the pit window when the wall lets you; and trust the strategy. (Don't.)

## Play

```sh
npm start          # serves the game + leaderboard API on http://localhost:8080
```

Or open `index.html` straight from disk — everything works offline except the shared leaderboard (scores fall back to this browser's localStorage).

### Controls

| Key | Action |
| --- | --- |
| `▲ ▼` / `W S` | Steer across the track |
| `▶` / `D` | Push (faster, more tyre wear) — hold for a while and you'll hear about it |
| `◀` / `A` | Lift and coast (slower, saves tyres) |
| `Space` / `Shift` | ERS boost (drains the battery; DRS gates refill it) |
| `1`–`5` / `Tab` | Choose the compound for your next stop (Soft / Medium / Hard / Inter / Wet) |
| `B` / **BOX BOX** button | Box this lap — the car steers itself into the pits when the window is open (steering `▲` into the green gap still works) |
| `P` / `Esc` | Pause · `R` restart · `M` music · `N` sound effects · `T` switch soundtrack |
| `◀ ▶` (title screen) | Choose your car |
| Mouse | Drag on the track to steer; press on the right quarter of the screen to boost |

### On a phone or tablet

Phones and tablets get a touch pad automatically (anything with a coarse pointer and no hover; force it with `?touch=1` or off with `?touch=0`). Turn the phone sideways — in portrait the race red-flags itself until you do.

| Touch | Action |
| --- | --- |
| Drag on the track | Steer — the car follows your thumb's movement, not its position, so it never hides the car |
| **▶ PUSH** / **◀ LIFT** (hold) | Throttle, same as the arrow keys |
| **ERS** (hold) | Boost; tapping it also fires the wheel gun in the box and launches you off the grid |
| **TYRE** | Cycles the compound for your next stop |
| **BOX** | Box this lap (green when the window is open) |
| **❚❚** | Pause |

The game asks for full screen and a landscape lock where the browser allows it (Android). On iOS use *Add to Home Screen* — the manifest opens it full screen in landscape.

### How it works

- **Your car**: the garage on the title screen has one car per current team — Ferrari, McLaren, Red Bull, Mercedes, Aston Martin, Alpine, Williams, Racing Bulls, Haas and Kick Sauber — in an approximation of its colours. Each has five rated stats (top speed, launch, handling, tyre life, battery) and quirks the bars do not show: some are tough or fragile, some have a quick pit crew, the Ferrari's wheel guns jam. The stats are multipliers on the tunables in `config.js` and the test suite keeps them roughly balanced, so a choice is a trade-off rather than an upgrade. The car is remembered between visits, the attract mode drives it, the leaderboard shows a swatch of it next to your name, and the other car in your colours is your **team-mate**. Add or tune cars in `src/cars.js`.
- **The start**: you line up P20 at the back of a staggered grid of twelve. Five red lights come on one by one, hold, and go out — hit push or boost within a third of a second for a **+50 great start** (going before they are out is a jump start: no penalty, no bonus). Everyone launches at their own rate; passes in the pack pay +30. For the first ten seconds nothing else spawns and contact costs bodywork, not the race.
- **Damage**: the car has two damageable parts, shown on the damage meter. The **front wing** takes debris and nose-to-tail contact and costs top speed; the **floor** takes side-by-side rubs (or a car into your rear) and costs grip. A gentle touch is survivable — you lose momentum and the other car gets punted on — but a hard frontal hit outside the launch, or any hit on a part already at 100 %, is a **crash** and the race is over. A rolling tyre or a stranded car is always a crash. The pit crew fits a new nose and floor with the tyres, and the wall calls you in from 30 % damage.
- **Oil** spins you and adds wear.
- **Tyre wear** grows with the square of your speed. Past ~65 % grip falls off a cliff — you turn slower and can't use full throttle. At 100 % you puncture and limp until you pit.
- **Compounds**: softs are quick and short-lived, hards are slow and last, mediums are mediums. Inters and wets only grip when it **rains**, and it will rain.
- **Pit window** opens every ~26 s for 7 s. Press `B` or tap the pulsing **BOX BOX** button and the car steers itself into the pits (or steer up into the flashing green gap yourself). Ask too early and the wall tells you to stay out. The stop fits whatever compound you selected.
- **The stop is a mini-game**: you are the pit crew. Four wheels go one at a time; a marker sweeps across a bar and you fire the wheel gun (`Space`, `B` or tap) when it's in the green zone — the cyan centre is a *perfect*. A miss cross-threads the nut and costs 1.3 s; wait too long and the mechanic does it for you, slowly. Some wheels are **jammed** (tiny zone). All four perfect ≈ 1.67 s. Under 2.0 s is a **record stop** (+100), no misses is a clean stop (+50). This is Ferrari, so it will go wrong sometimes anyway.
- **Slipstream**: sit directly behind a rival and you get the tow — up to +12 % speed and the battery charges. Some rivals defend by moving across to cover your lane (watch their brake lights).
- **Safety car**: a car is stranded somewhere ahead, the field bunches up, marshals wave yellows and a speed delta applies. Overtaking while the field bunches up is a **5 s penalty** (you crawl and score nothing while you serve it). Then the race is **neutralised**: the car is taken off you and holds station behind the safety car on its own, and the **weave** mini-game starts. Swing the car up and down (`▲ ▼`, or wiggle a thumb on a phone) to keep the tyre temperature in the green window — each full swing is a weave and adds heat, safety-car pace bleeds it away. Below the window you restart on cold tyres (the usual cold-tyre grip penalty applies); above it the tyres blister and wear. A **3-2-1 countdown** hands the car back at the green: time in the window pays up to +80, a clean period +50, and hitting the throttle right after the green (not before) is a **+40 jump**. Overtakes pay double for the next 4 s.
- **Grand Prix calendar**: every 1.5 km is a race. Cross the line for +150 and 25 championship points, then a round card slides in and the next venue wipes across the backdrop: Monza, Monaco, Zandvoort, Silverstone, Spa, Baku, Suzuka, Singapore (night), Austin, Mexico City, Interlagos, Las Vegas (night), Melbourne, Bahrain (night). Each venue has its own skyline, sky, grass, barrier and asphalt palette and rain probability — Spa is soaked, Bahrain never rains.
- **The grid**: rivals are real drivers — the full 2025 field with team liveries, race numbers and their own helmet colours — plus **legends** in classic liveries (Senna's JPS Lotus, Schumacher's Benetton, Button's Brawn, Mansell's Williams, Räikkönen's Lotus, Alonso's Minardi…). Legends are rarer and worth +40. Each driver has their own pit-wall quips when you pass or nearly hit them (Alonso's GP2 engine, Kimi's *bwoah*, Yuki's *WHAT?!*). Add drivers in `src/grid.js`.
- **Team-mate**: one rival in seven is the other car from your team (Leclerc or Hamilton if you drive the Ferrari, Norris or Piastri in the McLaren, and so on). Passing him is +160 and a *Multi 21* radio message; a close call with him is worth more too.
- **Meme pack**: 22 radio moments are wired to events — Bwoah, GP2 engine, Multi 21, Simply lovely, WHAT?!… The repo ships each as a synthesised pit-wall reading run through a team-radio filter; drop the genuine clip into `assets/clips/` with the same name (`bwoah.mp3`) and it takes over. Driver portraits in `assets/drivers/` replace sad Greg with the driver you hit. See `assets/README.md` and the title screen's *Meme pack* panel.
- **Boxing**: press `B` and the car is ghosted — nothing can hit it — while the world drops into slow motion and it peels off into the pit lane for the wheel-gun mini-game.
- **Weather**: heavy rain brings lightning and standing water. Fresh tyres out of the pits are cold for a few seconds — weave and take it easy.
- **Score** = metres travelled + 60 per overtake + 25 per close call + bonuses. Every kilometre and every sustained push gets a radio message from the pit wall.
- **Career**: championship points, distance, the teams you have raced for and a 22-trophy cabinet persist in this browser (title screen → Trophy cabinet).

### Sounds

The four meme clips in `assets/` are used as they were intended: *pushing like an animal* when you push (and at even-kilometre milestones only if you actually are pushing), the scream on a close call, *so not right* on oil / a botched pit stop, and the game-over clip on retirement. Every clip with words is **subtitled** on the radio strip the moment it starts — speaker and line — so what you read is always what you hear; the pit wall's own text line queues behind it instead of talking over it. Pit-wall clips get a team-radio key-up (static, a click and an open ping) and a squelch tail when they end, and the band drops under speech like a broadcast while the engine dips 6 dB. *Box box* is only called when the car actually needs the stop (worn or punctured tyres, wing damage, wrong rubber for the weather); an unneeded window gets a quiet chime.

The F1 sound design is synthesised live with WebAudio, apart from two crowd recordings:

- **The engine** is a 1.6 L **V6 turbo-hybrid**, not a V12. It fires at rpm / 60 × 3: 200 Hz at the 4,000 rpm idle and 525–600 Hz in the race range. It has the uneven 90° firing, exhaust formants, a turbo whistle that spools with boost, a 40 ms ignition cut and crack on each upshift, auto-blips and overrun pops on downshifts, and a wastegate *pssh* when you lift. Under it the **MGU-K** whines up while you deploy ERS and whines down as it harvests off the throttle.
- **The start**: on the grid your engine bounces on launch control and the field around you rumbles. That noise drops with each light (the gantry itself is silent, so each light gets only a soft tick). At lights out the grid goes quiet for a moment, then the whole field launches with a wheelspin chirp and a crowd swell. A jump start gets the FIA double tone. Your **reaction time** shows under LIGHTS OUT, and the career keeps your best launch.
- **On track**: every pass is a Doppler pass-by of the other car, panned front to back (or back to front when you are the one passed), with the old score chime 12 dB underneath. A close call is a whoosh on the side the car went by, and a scrape adds a grain of paint on paint. The flow multiplier steps up in semitones. The first car in your mirrors gets a rising blip and a "car behind" from the wall. DRS opening is a flap click and a dip in the wind noise. A wing at 50 % damage or more, or a damaged floor, drags on the tarmac until it is fixed. Contact is a carbon crunch. A crash is a crack, a crunch and a scatter of debris while the engine stalls.
- **The pits**: the limiter stutters on the way in, with a double dash beep. The front jack clanks, and the engine idles while you work the wheel guns. Each hit is a whirr and a hammer; a miss is a gun bogging down. The jacks drop with a hiss and a thump, and you leave the lane with a rev and a chirp.
- **Safety car**: there is no siren, because F1 has none. You get a radio key-up, a triple dash beep and the engine bed dropping for a second. The safety car's road-car V8 burbles while it is on screen, its lights click off when it comes in, and the field revs up together at the green.
- **The crowd**: the grandstands and their air horns at the chequered flag, and a quick cheer for a record pit stop. These are recordings; if the files are removed, a synth version plays.

The continuous cues follow the sim frame by frame: a slipstream whoosh with the tow, rain hiss with the track wetness, a flat-tyre thump while you limp. Every loop stops on pause, restart and retirement, and `N` mutes all sound effects. The soundtracks' tempo and layers follow your speed: **Rawe Ceek Mariachi** (default: an original mariachi piece in the spirit of the Mexican GP celebrations — twin trumpets in thirds, guitarrón, vihuela strums, güiro and shaker, and a grito when you are flat out; it is not the broadcast theme, which is copyrighted), **Jarabe Rawe** (a jauntier original in 6/8 huapango style: faster, staccato trumpets, hemiola bass, strums on every off-beat and a grito at the end of each phrase) and the original **Synth** track. Press `T` to cycle or pick one from the Soundtrack selector. Music, SFX and soundtrack choices are remembered. No FOM broadcast audio, F1 theme or team radio is used.

**Credits**: crowd and air horns are ["F1 Race Crowd Applause Air Horns"](https://commons.wikimedia.org/wiki/File:F1-Race-Crowd-Applause-Air-Horns.wav) by WebbFilmsUK, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), trimmed and re-encoded. The record-stop cheer is ["Clapping hurray"](https://commons.wikimedia.org/wiki/File:Clapping_hurray.ogg) by starlite, public domain. Optional CC0 samples you can add yourself (a wheel gun and a radio ping) are listed in [assets/README.md](assets/README.md#sfx-licensed).

## Project layout

```
index.html          markup for the title / pause / game-over screens, the touch pad + the canvas
manifest.webmanifest  full-screen landscape when added to a phone home screen
src/
  main.js           bootstrap, state machine, DOM wiring, main loop
  world.js          the simulation: player, hazards, tyres, pit, weather (no DOM)
  logic.js          pure gameplay maths (tested)
  config.js         every tunable in one place
  render.js         canvas renderer + HUD
  audio.js          samples, synth soundtrack, V6 engine, F1 sound effects
  input.js          keyboard, pointer and the touch pad
  radio.js          pit-wall lines
  mariachi.js       the mariachi soundtrack: sequencer data + trumpet/guitarrón/vihuela synths
  cars.js           the garage: one car per team, stats, balance weights (tested)
  livery.js         palette-swaps the Ferrari sprite sheet into each team's colours
  career.js         persistent career stats + trophy definitions (tested)
  leaderboard.js    localStorage + server API client
  style.css
server/index.js     zero-dependency static + leaderboard server
test/               node:test unit tests (`npm test`)
assets/             sprite sheet, sad Greg, meme clips
```

Rawe Ceek is an unofficial fan game. Team and driver names identify which real cars the colours are inspired by and nothing more: there are no logos or sponsor marks, the liveries are approximations, and nothing here is endorsed by or affiliated with Formula 1, the teams or the drivers.

## Deploy

```sh
docker compose up -d --build      # game on http://localhost:3732, scores persisted in a volume
```

`PORT` and `LEADERBOARD_FILE` are honoured by the server.

## Tuning

Everything that changes how the game feels — speeds, wear rates, pit timing, rain frequency, hazard weights, the venue calendar, safety-car odds, slipstream strength — is in `src/config.js`. Per-car differences are multipliers in `src/cars.js`; `carBalance` there scores a car's overall strength and the tests fail if one drifts more than ±0.07 from the pack. `npm test` checks the maths in `src/logic.js` still holds after you fiddle.

## Unraid / auto-updating container

Every push to `main` runs the tests and publishes `ghcr.io/tronzop/rawe-ceek:latest`. On the Unraid box (no Compose plugin needed):

```sh
curl -fsSL https://raw.githubusercontent.com/tronzop/Rawe-Ceek/main/deploy/unraid/run.sh | sh
```

(If you do have the Compose plugin, `deploy/unraid/docker-compose.yaml` is the same setup.)

That starts the game on port 3732 plus a Watchtower sidecar that checks GHCR every 5 minutes and swaps in new images automatically. Scores persist in `appdata/rawe-ceek/data`; drop meme-pack files into `appdata/rawe-ceek/assets/clips` and `assets/drivers`.
