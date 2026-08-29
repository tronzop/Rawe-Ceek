# Rawe Ceek

A Ferrari-fan survival racer in plain HTML5 Canvas + JavaScript. No build step, no runtime dependencies.

You are the red car. The track scrolls under you at ever-increasing speed through an eight-round calendar — Monza to Bahrain, two of them under floodlights. Dodge Pirelli tyres, rival cars, oil and debris; ride the slipstream; manage your tyre wear and temperature; behave behind the safety car; box in the pit window when the wall lets you; and trust the strategy. (Don't.)

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
| `P` / `Esc` | Pause · `R` restart · `M` music · `N` sound effects |
| Touch / mouse | Drag to steer; press on the right quarter of the screen to boost |

### How it works

- **Crash** into a tyre or a rival car and the race is over. **Oil** spins you and adds wear; **debris** damages the front wing (a little less top speed until you pit).
- **Tyre wear** grows with the square of your speed. Past ~65 % grip falls off a cliff — you turn slower and can't use full throttle. At 100 % you puncture and limp until you pit.
- **Compounds**: softs are quick and short-lived, hards are slow and last, mediums are mediums. Inters and wets only grip when it **rains**, and it will rain.
- **Pit window** opens every ~26 s for 7 s. Press `B` or tap the pulsing **BOX BOX** button and the car steers itself into the pits (or steer up into the flashing green gap yourself). Ask too early and the wall tells you to stay out. The stop fits whatever compound you selected.
- **The stop is a mini-game**: you are the pit crew. Four wheels go one at a time; a marker sweeps across a bar and you fire the wheel gun (`Space`, `B` or tap) when it's in the green zone — the cyan centre is a *perfect*. A miss cross-threads the nut and costs 1.3 s; wait too long and the mechanic does it for you, slowly. Some wheels are **jammed** (tiny zone). All four perfect ≈ 1.67 s. Under 2.0 s is a **record stop** (+100), no misses is a clean stop (+50). This is Ferrari, so it will go wrong sometimes anyway.
- **Slipstream**: sit directly behind a rival and you get the tow — up to +12 % speed and the battery charges. Some rivals defend by moving across to cover your lane (watch their brake lights).
- **Safety car**: a car is stranded somewhere ahead, the field bunches up, marshals wave yellows and a speed delta applies. Overtaking under the SC is a **5 s penalty** (you crawl and score nothing while you serve it). Restart clean and you bank +50; overtakes pay double for the next 4 s.
- **Grand Prix calendar**: every 1.5 km is a race. Cross the line for +150 and 25 championship points, then the scenery morphs into the next venue: Monza, Monaco, Silverstone, Spa, Suzuka, Singapore (night), Interlagos, Bahrain (night). Each venue has its own skyline, palette and rain probability — Spa is soaked, Bahrain never rains.
- **The grid**: rivals are real drivers — the full 2025 field with team liveries, race numbers and their own helmet colours — plus **legends** in classic liveries (Senna's JPS Lotus, Schumacher's Benetton, Button's Brawn, Mansell's Williams, Räikkönen's Lotus, Alonso's Minardi…). Legends are rarer and worth +40. Each driver has their own pit-wall quips when you pass or nearly hit them (Alonso's GP2 engine, Kimi's *bwoah*, Yuki's *WHAT?!*). Add drivers in `src/grid.js`.
- **Team-mate**: one rival in seven is the other Ferrari (Leclerc or Hamilton). Passing him is +160 and a *Multi 21* radio message; a close call with him is worth more too.
- **Meme pack**: 22 radio moments are wired to events — Bwoah, GP2 engine, Multi 21, Simply lovely, WHAT?!… The repo ships each as a synthesised pit-wall reading run through a team-radio filter; drop the genuine clip into `assets/clips/` with the same name (`bwoah.mp3`) and it takes over. Driver portraits in `assets/drivers/` replace sad Greg with the driver you hit. See `assets/README.md` and the title screen's *Meme pack* panel.
- **Boxing**: press `B` and the car is ghosted — nothing can hit it — while the world drops into slow motion and it peels off into the pit lane for the wheel-gun mini-game.
- **Weather**: heavy rain brings lightning and standing water. Fresh tyres out of the pits are cold for a few seconds — weave and take it easy.
- **Score** = metres travelled + 60 per overtake + 25 per close call + bonuses. Every kilometre and every sustained push gets a radio message from the pit wall.
- **Career**: championship points, distance and a 16-trophy cabinet persist in this browser (title screen → Trophy cabinet).

### Sounds

The four meme clips in `assets/` are used as they were intended: *pushing like an animal* when you push, the scream on a close call, *so not right* on oil / a botched pit stop, and the game-over clip on retirement. Everything else — engine, gear shifts, wheel guns, and the soundtrack whose tempo follows your speed — is synthesised live with WebAudio. Music and SFX toggles are remembered.

## Project layout

```
index.html          markup for the title / pause / game-over screens + the canvas
src/
  main.js           bootstrap, state machine, DOM wiring, main loop
  world.js          the simulation: player, hazards, tyres, pit, weather (no DOM)
  logic.js          pure gameplay maths (tested)
  config.js         every tunable in one place
  render.js         canvas renderer + HUD
  audio.js          samples, synth soundtrack, engine drone
  input.js          keyboard + pointer
  radio.js          pit-wall lines
  career.js         persistent career stats + trophy definitions (tested)
  leaderboard.js    localStorage + server API client
  style.css
server/index.js     zero-dependency static + leaderboard server
test/               node:test unit tests (`npm test`)
assets/             sprite sheet, sad Greg, meme clips
```

## Deploy

```sh
docker compose up -d --build      # game on http://localhost:3732, scores persisted in a volume
```

`PORT` and `LEADERBOARD_FILE` are honoured by the server.

## Tuning

Everything that changes how the game feels — speeds, wear rates, pit timing, rain frequency, hazard weights, the venue calendar, safety-car odds, slipstream strength — is in `src/config.js`. `npm test` checks the maths in `src/logic.js` still holds after you fiddle.

## Unraid / auto-updating container

Every push to `main` runs the tests and publishes `ghcr.io/tronzop/rawe-ceek:latest`. On the Unraid box (no Compose plugin needed):

```sh
curl -fsSL https://raw.githubusercontent.com/tronzop/Rawe-Ceek/main/deploy/unraid/run.sh | sh
```

(If you do have the Compose plugin, `deploy/unraid/docker-compose.yaml` is the same setup.)

That starts the game on port 3732 plus a Watchtower sidecar that checks GHCR every 5 minutes and swaps in new images automatically. Scores persist in `appdata/rawe-ceek/data`; drop meme-pack files into `appdata/rawe-ceek/assets/clips` and `assets/drivers`.
