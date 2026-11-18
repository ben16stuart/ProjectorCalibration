# ProjectorCal

Camera-assisted projector calibration. Static web app (no build step, no dependencies)
served by nginx in Docker at http://localhost:7904 (`docker compose up -d --build`), or by
any static server from `web/`. All camera capture and analysis run **in the browser**; the
container only serves files.

Developed against an **Acer H7850** fed by an Apple TV 4K, where the motivating complaint
was HDR looking barely better than SDR.

It is used in **Safari** with an iPhone as a Continuity Camera (Chrome did not list the
iPhone). Keep Safari working: Chrome-only APIs (e.g. `getScreenDetails`) need a fallback.
`camera.js` stops a measurement when the camera pauses or freezes (iPhone unlocked or
moved); never let a measurement read a stale frame.

## Layout

- `web/js/patterns.js` — the single definition of every test pattern (normalized rects,
  8-bit SDR codes or 10-bit PQ codes, plus `meta` the analyzers rely on). The browser
  renderer, the analyzers and the video generator all read it. Change patterns only here.
- `web/js/analysis.js` — pure analyzers: per-patch camera stats → measurements/verdicts.
- `web/js/advisor.js` — presets (incl. `acer_h7850`), threshold search (bracket + bisect),
  proportional search, per-test advice text. Search state is plain JSON (localStorage).
- `web/js/geometry.js` — screen detection from a white−black diff, homography, samplers.
- `web/js/stats.js`, `measure.js`, `camera.js`, `display.js`, `pattern-window.js`, `app.js` — browser side.
- `web/js/hdr.js` — HDR signal-chain checklist and diagnosis rules.
- `tools/make_videos.py` — renders patterns (via `tools/export_patterns.mjs`) to SDR H.264 /
  HDR10 HEVC videos in `videos/` (gitignored, excluded from the image). `--verify` decodes and
  checks exact codes. Note: swscale maps 16-bit RGB as value/65280, hence the 65280 scale.

## Rules that keep a webcam honest (don't break these)

- Compare patches only within one frame; never compare absolute camera values across patterns
  (auto-exposure/AWB differ).
- Normalize each bar by the background immediately beside it (gaps are measured elements).
- Gamma uses equality matching (dither vs solid, solid sandwiched between two dithers).
- Analyzers must return `pass: null` / `confidence: 'none'` when the camera can't tell
  (crushed camera blacks, saturation, resolved dither lines), never a guess.

## Tests

`npm test` — `tests/logic.test.mjs` (searches, PQ, homography, HDR rules) and
`tests/pipeline.test.mjs`, which runs the real analyzers on frames from `tests/sim.mjs`
(projector model + camera model). Any analyzer or pattern change must keep these passing;
add a sim case for new behaviour.
