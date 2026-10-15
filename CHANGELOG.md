# Changelog

All notable changes to Sferic Charts are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Type declarations resolve under `moduleResolution` `node16` and `nodenext`
  (relative imports now carry explicit `.js` extensions).
- When WebGL2 cannot be created, 2D-only charts keep rendering and GPU-rendered panels
  show a notice instead of every chart on the page stopping; creation is retried.
- GPU context loss is recovered: the shared context is replaced and every chart
  re-uploads its data and redraws.
- The map decoder validates TopoJSON and GeoJSON input (arc references, coordinates,
  transform, nesting depth, size budget) and throws descriptive errors.
- Polar and hierarchy GPU buffers are re-specified whole instead of partially updated,
  avoiding pipeline stalls.

### Changed

- GPU memory is reclaimed: the shared context is released a few seconds after the last
  chart is disposed, oversized render targets shrink, and idle MSAA buffers are freed.
- Diagnostics moved from page globals to an exported `debug` object; importing the
  library no longer touches any global.
- Chart canvases expose `role="img"` and an `aria-label` (the chart title by default,
  or `setAccessibleLabel()`).

### Added

- `npm test` (hostile-input tests for the map decoder), `npm run test:browser`
  (context loss, no-WebGL, GPU memory and accessibility checks),
  `npm run verify:package`, and a `prepublishOnly` gate running typecheck, tests,
  build and package verification.

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

[Unreleased]: https://github.com/murr2k/sferic-charts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/murr2k/sferic-charts/releases/tag/v0.1.0
