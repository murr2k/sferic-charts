# Changelog

All notable changes to Sferic Charts are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-17

No library changes: the first release published from GitHub Actions, with npm
provenance.

### Added

- Release workflow (`.github/workflows/release.yml`): pushing a `vX.Y.Z` tag publishes
  to npm from GitHub Actions with trusted publishing and provenance; a manual run is a
  dry run of the same gate.

## [0.2.0] - 2026-10-17

### Fixed

- Type declarations resolve under `moduleResolution` `node16` and `nodenext`
  (relative imports now carry explicit `.js` extensions), and CommonJS consumers get
  CommonJS declarations (`.d.cts`, through the `require` condition) instead of ESM
  ones that TypeScript rejected with TS1479.
- When WebGL2 cannot be created, 2D-only charts keep rendering and GPU-rendered panels
  show a notice instead of every chart on the page stopping; creation is retried.
- GPU context loss is recovered: the shared context is replaced and every chart
  re-uploads its data and redraws.
- The map decoder validates TopoJSON and GeoJSON input (arc references, coordinates,
  transform, nesting depth, size budget) and throws descriptive errors.
- Polar and hierarchy GPU buffers are re-specified whole instead of partially updated,
  avoiding pipeline stalls.
- Deep zoom draws data where it belongs. When a chunk's origin was 1e9 px or more from
  the view, a float32 offset in the vertex shader misplaced points and lines by tens
  to hundreds of pixels; shaders now subtract a two-part view anchor before scaling.
- Deep zoom keeps long segments: line segments and area edges whose endpoints lie
  1e10 px or more off screen no longer tilt or vanish. Boundary segments of
  monotonic series are clipped in float64 on the CPU, and the line shader clips the
  rest in two stages.
- Deep zoom keeps x at full precision: chunks store x as a float32 high word plus,
  when needed, a low word. Float32 alone rounded x to 2^-25 of the chunk's span, which
  put a mark in an hour of fractional epoch-ms timestamps 127 px off at 1 µs per pixel.
- Area fills and 1 px lines no longer bend when a vertex is about 1e6 px off screen.
- Heatmap series can be created when WebGL2 is unavailable (the GPU panel shows the
  notice instead of the constructor throwing).
- `debug.stats` moving averages start from the first sample instead of decaying up
  from 0.
- `debug.syncGPU` waits for the GPU (a 1-pixel readback); it called `gl.finish()`,
  which returns immediately in Chrome, so "GPU" timings were CPU submission only.
- Development: `npm run snap` fails without WebGL2 or when an example renders without
  a GPU context; the test harness records WebGL warnings again (puppeteer reports them
  as `warn`) and proves it with a planted warning at startup; `verify:package` also
  rejects Linux and macOS home directory paths.

### Changed

- GPU memory is reclaimed: the shared context is released a few seconds after the last
  chart is disposed, oversized render targets shrink, and idle MSAA buffers are freed.
- Diagnostics moved from page globals to an exported `debug` object; importing the
  library no longer touches any global.
- Chart canvases expose `role="img"` and an `aria-label` (the chart title by default,
  or `setAccessibleLabel()`).
- `npm run bench` reports the GPU-synced cost of each rendered frame instead of the
  interval between animation frames, which measured input pacing. The README
  performance table is re-measured this way (the 1M-point scatter costs 11.5 ms per
  frame, not the 1.6 ms frame interval quoted before).
- `debug.stats.glFinish` is renamed `gpuSync`.

### Added

- `npm test` (hostile-input tests for the map decoder), `npm run test:browser`
  (context loss, no-WebGL, GPU memory and accessibility checks),
  `npm run verify:package`, and a `prepublishOnly` gate running typecheck, tests,
  build and package verification.
- `debug.onFrame` hook: wall time of each rendered frame (with `debug.syncGPU`, including
  GPU completion).
- Gallery example: live per-core CPU utilization on a spider chart with a 10 s peak
  envelope, read from the OS through a dev-server endpoint (`/__cpu`); simulated in
  the static build.

### Security

- Dev dependency `puppeteer-core` upgraded to 25, clearing seven high-severity
  advisories in its download helpers (never shipped to consumers).

## [0.1.0] - 2026-10-15

First release.

### Added

- WebGL2 renderer shared by all charts on a page: instanced SDF lines, points and
  rectangles, area and heatmap shaders, bloom glow post-process, opt-in MSAA, and a
  GL state cache.
- `ChartXY` with line, point, point-line, area, area range, step, spline, heatmap grid,
  scrolling heatmap, box, OHLC / candlestick, rectangle, segment and ellipse series.
- Numeric, logarithmic, DateTime (years to microseconds) and Time tick strategies;
  multiple, stacked and opposite axes; fitting, expansion, progressive, regressive and
  scrolling strategies; fit-to-visible-data; bands, constant lines and custom ticks.
- Cursor modes (nearest, all, pointed) with result tables, synchronized cursors and
  axis intervals, legends with LUT color bars, series pointer events.
- Zoom (wheel, rectangle), pan, pinch, axis drag and double-click fit interactions.
- Chunked data store with float64 origins, min/max level-of-detail pyramid for dense
  progressive data, and stall-free GPU uploads (whole-buffer commits plus a per-frame
  tail buffer).
- `Dashboard` with draggable splitters and UI panels.
- `Chart3D` (points, lines, surface grids, scrolling surfaces, meshes, boxes), `Polar`,
  `Spider`, `Pie`, `Gauge`, `Funnel`, `Pyramid`, `BarChart`, `ZoomBandChart`,
  `ParallelCoordinateChart`, `TreeMapChart`, `SunburstChart`, `DataGrid` and `Map`.
- Themes: `storm` (default, with GPU bloom glow), `daylight`, `aurora`, `lagoon`,
  `graphite`; the `storm` and `daylight` series palettes are validated for
  color-vision-deficiency separation.
- Synthetic data generators (`src/xydata`) and an interactive gallery of 63 examples.
- Headless verification tooling: `npm run snap`, `npm run bench`, and diagnostic
  scripts for GL call counts, CPU profiles and GPU stall experiments.

[Unreleased]: https://github.com/murr2k/sferic-charts/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/murr2k/sferic-charts/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/murr2k/sferic-charts/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/murr2k/sferic-charts/releases/tag/v0.1.0
