# Changelog

All notable changes to Sferic Charts are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
