# Sferic — Claude Code Configuration

## What this is

Sferic is a GPU-accelerated browser charting library: XY, 3D, polar, radial,
hierarchy, grid and map charts behind a fluent builder API
(`sferic().ChartXY({ theme }).setTitle(...)`, `axisX.setTickStrategy(...)`,
`addLineSeries().appendJSON(...)`, `Themes.storm`, `LUT`/`PalettedFill`, ...)
and a dark default theme with GPU line glow. Zero runtime
dependencies; raw WebGL2 + Canvas2D. The gallery (`index.html`, `gallery/`) is
the showcase and test bed.

## Run / build / test

```powershell
npm install
.\run.cmd                 # Vite dev server, gallery at http://127.0.0.1:8779
npm run typecheck         # tsc --noEmit (must stay clean)
npm run build:lib         # dist/sferic.js (ES) + UMD + dist/types
npm run build             # static gallery to dist-gallery/
```

Headless verification (puppeteer-core driving the installed Chrome with the
real GPU; the dev server must be running):

```powershell
npm run snap                          # every example -> .snapshots/<theme>/<id>.png; fails on page or WebGL errors
npm run snap -- --theme light --filter rt-,xy-log
npm run bench                         # frame-time table, vsync off (--vsync to cap)
node scripts/glcount.mjs <id>         # WebGL calls per frame
node scripts/profile.mjs <id> [s]     # CPU profile, self time by function
node scripts/gpu-experiment.mjs <id> bufferSubData   # stub a GL call, compare frame time
```

Reference numbers (Intel Arc iGPU, 1920x1080, vsync off): 100-chart streaming
dashboard ~9 ms/frame, 10M-point line zoom ~6 ms, 1M scatter pan ~1.6 ms.

Visual check without a screenshot tool: in the gallery page (dev only),
`await window.__snap('name')` POSTs the current chart canvas to the Vite
middleware, which writes `.snapshots/name.png` (gitignored). View it with Read.
`globalThis.__sfericStats` holds smoothed per-phase CPU frame timings (ms).
The gallery self-accepts HMR: edits re-run the current example in place
instead of reloading the page.

## Architecture

| Path | Role |
|---|---|
| `src/core/` | `color.ts` (Color, ColorRGBA/HEX/HSV/CSS), `style.ts` (fills, lines, LUT, `Mutator<T>`), `theme.ts` (Themes, `font()`, `seriesColor()`), `Panel.ts` (base of every chart: title, padding, background, UI text boxes, tweens), `Legend.ts`, `util.ts` (Emitter, Tween, text metrics, formatting) |
| `src/render/` | `GLRenderer.ts` (the single shared WebGL2 context, MSAA + MRT glow pipeline), `shaders.ts` (`VS_HEAD`/`FS_HEAD` + programs), `draw.ts` (line/point/area draws from stores, `RectBatch`, `SegmentBatch`, `HeatmapTexture`), `Surface.ts` (visible canvas, scheduler, pointer routing) |
| `src/xy/` | `ChartXY.ts`, `Axis.ts` (interval, scroll strategies, bands, constant lines, custom ticks), `ticks.ts` (Numeric/log, DateTime, Time, Empty), `store.ts` (chunked float32 store), `series/` |
| `src/dashboard/` | `Dashboard.ts`: grid of panels on one Surface, draggable splitters |
| `src/<module>/` | Other chart families (chart3d, polar, pie, bar, zoomband, parallel, hierarchy, datagrid, map), each with an `index.ts` re-exported by `src/index.ts` |
| `src/lc.ts` | `sferic()` factory: `ChartXY`, `Dashboard`, `Chart3D`, `Polar`, `Spider`, `Pie`, `Gauge`, `Funnel`, `Pyramid`, `BarChart`, `ZoomBandChart`, `ParallelCoordinateChart`, `TreeMapChart`, `SunburstChart`, `DataGrid`, `Map` |
| `src/xydata/` | Deterministic synthetic data generators for examples and tests |
| `gallery/examples/*.ts` | One example per file, `export default { title, category, description, tags, run({container, theme}) => cleanup } satisfies Example`; auto-discovered |

### Rendering model

- One process-wide WebGL2 context (`getRenderer()`), hidden canvas. Each
  `Surface` (a standalone chart or a whole Dashboard) owns ONE visible 2D
  canvas. Per frame: `layout` -> `drawBackground` (2D) -> GL pass for all
  drawables into the shared context, composited, then `drawImage`d into the
  2D canvas -> `drawOverlay` (2D: axes, labels, legend, cursor). Unlimited
  charts per page; no per-chart GL context.
- All coordinates passed between layers are **CSS px, y down**, relative to the
  surface. GL code multiplies by `r.dpr`. `r.scissor(rect)` takes CSS px.
- Rendering is on-demand: call `panel.requestRender()` after any state change.
  `Panel.animate(new Tween(...))` keeps frames coming until the tween ends.
- Glow: every fragment shader built on `FS_HEAD` must output via
  `emit(color)`. Set `r.glow = 1` before drawing content that should glow,
  `0` otherwise. The bloom is a post-process over the whole surface.
- Data precision: stores keep float32 values relative to a per-chunk origin;
  transforms are built in float64 by `makeXform(axisMapX, axisMapY, ox, oy, dpr)`.
  Never upload absolute epoch-ms timestamps as float32.
- 3D content uses the depth buffer the FBO already has (cleared per frame);
  enable/disable `DEPTH_TEST` inside your own `drawGL`.
- MSAA is opt-in: `Panel.wantsMSAA()` (default false). 2D primitives are
  SDF-antialiased in their fragment shaders; only un-antialiased triangles
  (3D meshes, filled polygons) need it, and it costs 4x fill on two targets.
- Level of detail: monotonic-X line/area series with more than ~6 points per
  pixel draw from a per-chunk min/max pyramid (`Chunk.lod(L)`, bucket =
  8 << L points, each level derived from the one below). The first/last LOD
  vertex of a chunk is pinned to the bridge/last sample so chunk joins are
  seamless.

### Writing a chart (Panel subclass)

Override: `layout(ctx)` (start with `const content = this.layoutBase()`; a
legend takes space via `this.legend.layout(content)`), `drawBackground`,
`hasGL()`/`drawGL(r)`, `drawOverlay(ctx)` (end with `this.drawTitle(ctx)`,
`this.drawUI(ctx)`), `onPointer(e)` (call `this.handleUI(e)` first; return
true when the event changed something), `tick(now)`, `disposeGL(r)`. Read
colors/fonts from `this.theme` (never hard-code a palette). Use `Mutator<T>`
+ `resolve()` for style setters, return `this` from setters, and call
`this.requestRender()`.

## Invariants & "do not regress"

- Standalone panels take their rect from the surface in `layoutBase()`;
  Dashboard cells get it from the Dashboard. **Why:** a missing rect once
  collapsed every chart into the top-left corner.
- `resetAttribs(keep)` before every draw: WebGL validates enabled attribute
  arrays against draw counts, and stale arrays from a previous program cause
  INVALID_OPERATION.
- Never `bufferSubData` into a buffer the GPU may still be reading (anything
  drawn last frame). **Why:** on ANGLE/D3D11 each such update stalls the
  pipeline; the 100-chart dashboard went 17 -> 8 ms once removed. The store
  commits chunk buffers whole with `bufferData` (orphaning) every ~2K samples
  and draws newer samples from a per-frame tail buffer (`XYStore.parts`).
- Texture units 0-3 are parked on a white texture after `begin()`/`end()`.
  **Why:** shaders declare `u_lut` even when lutMode is 0; if unit 0 still holds
  the scene texture (the current render target) WebGL silently drops the draw
  as a feedback loop. This once blanked every solid-color line.
- GL state shadow: uniforms set via `r.useXform/useLUT/useFill` and
  `r.u1f/u1i/u2f/u3f/u2i/u4f`, generic attributes, divisors, pointers and
  scissor are cached. Drawables issuing raw `gl.*` state calls keep
  `usesRawGL() === true` (the default) so the cache is invalidated around
  them; never mix raw `gl.uniform*` and cached setters for one uniform.
- `npm run snap` treats WebGL console warnings as errors; keep it that way,
  since dropped draws raise no exception.
- No third-party product names in shipped code, package metadata or the API
  (no `lightningChart` export, no copied example titles or data, own theme names
  and palettes). **Why:** avoid trademark or copyright complaints; the README's
  porting section and trademark notice are the only places the name appears.
- Do not default new dev servers to common ports; this project's port is 8779
  (`~/.claude/port-registry.md`).

## Open questions / known gaps

- `scrollDimension: 'rows'` for scrolling heatmaps is not supported.
