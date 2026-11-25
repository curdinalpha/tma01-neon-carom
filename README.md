# NEON CAROM

A one-thumb ricochet roguelite for phones (390x844 portrait). Drag to aim, let go, and watch a stream of balls carom off numbered blocks. Clear the wave, pick an upgrade, go again. Built for Stellarator Yard ARENA-TMA-01 (t=26).

Everything is one `index.html` (~51 KB): plain 2D canvas, procedural WebAudio sounds, no assets, no libraries, no network.

## Play

Open `index.html` in any browser (phone or desktop, works offline from disk).

- **Drag** anywhere above the launcher to aim. The dotted line previews the first bounces.
- **Let go** to fire the whole volley. Tap during a volley for fast forward.
- Blocks show their HP. Each volley pushes the board down one row. If anything crosses the red dashed line, you lose.
- Green rings = +1 ball. Orange blocks with a fuse are bombs (chain them). Spinning diamonds burst into 3 bonus balls. Every 5th wave has a crowned boss.
- Hits in a single volley build a combo: every 10 hits bumps the score multiplier.
- Clearing the last block of a wave opens a **3-card draft**: Split Shot, Gravity Well, Chain Arc, Pierce, Merge Multiplier, Bigger Volley, Heavy Core, Detonator, Aegis. Cards stack and level up, so runs feel different.
- Killing a block in the very last row before the line is a **CLOSE CALL** (bonus points).
- First breach of a run: **SO CLOSE!** screen with a 6s countdown. One tap on Continue clears the bottom rows and gives you a shield. Next breach without a shield is game over.
- Speaker icon (top right) or `m` mutes. Best score is kept in localStorage.

Juice: hit-stop on big kills, trauma-based screen shake, particles, shockwave rings, lightning arcs, popping combo text, a heartbeat when blocks are one row from the line, haptics on phones that support it.

## Bot bridge

```js
window.__GAME.reset(seed_u32)   // seeded mulberry32 PRNG, no Math.random anywhere
window.__GAME.step(dt_ms, {x, y, down, tap, choice})  // fixed 60 Hz sim, then draws the canvas
window.__GAME.state()           // {phase, wave, score, entities, combo, game_over, awaiting_revive, ...}
```

- `x`, `y` in 0..1 are treated as normalized, larger values as canvas pixels.
- `down` true = dragging (aim), true -> false = release (fire). `tap` toggles fast forward / continues on the revive screen.
- `choice` 0..2 picks a draft card while `phase === 'draft'`.
- Phases: `aim`, `fire`, `advance`, `clear`, `draft`, `awaiting_revive`, `game_over`.
- Once the bridge is used, the real-time loop stops so only `step()` moves the sim (fully deterministic).

## Verify

Needs Node 22+ and Chromium/Chrome.

```bash
node bench/tma-01/verify_tma01.mjs ./        # official verifier
node tests/spec_check.mjs ./                 # extra checks, zero deps
# set CHROMIUM_BIN=/path/to/chrome if it is not /usr/bin/chromium
```

`tests/spec_check.mjs` covers: size cap, no URL strings, no Math.random, WebAudio only, 1.5s hook (aim phase on frame 0, a shot fires within 6 ticks), 3 fresh browser runs with identical state hash over 6000 ticks, 3-card drafts, wave 10+ reached by a random-aim bot, defeat -> awaiting_revive -> Continue (shield + row clear) -> game_over, revive timeout, active vs idle trace, and zero network requests.

Results I got (Node 24, Chrome 156, headless):

```
verify_tma01.mjs: PASS files=2 (3/3 runs identical)
spec_check.mjs:   RESULT ALL PASS (21 checks)
determinism:      seed 1234, 6000 ticks, 3 runs -> same sha256 7325b61b3f0e007e...
```

## License

MIT
