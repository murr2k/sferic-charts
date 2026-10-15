// Hostile-input tests for the TopoJSON / GeoJSON decoder (untrusted map geometry).
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'sferic-test-'))
const out = join(dir, 'topojson.mjs')
await build({ entryPoints: [new URL('../src/map/topojson.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' })
const T = await import(pathToFileURL(out).href)
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const square = { type: 'Topology', arcs: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]], objects: { land: { type: 'Polygon', arcs: [[0]], id: 'A' } } }

test('decodes a valid polygon', () => {
  const f = T.topologyToFeatures(square)
  assert.equal(f.length, 1)
  assert.equal(f[0].polygons[0][0].length, 5)
})

test('rejects out-of-range arc references', () => {
  const bad = { ...square, objects: { land: { type: 'Polygon', arcs: [[7]] } } }
  assert.throws(() => T.topologyToFeatures(bad), /out of range/)
  assert.throws(() => T.topologyMesh(bad), /out of range/)
  const neg = { ...square, objects: { land: { type: 'Polygon', arcs: [[-9]] } } }
  assert.throws(() => T.topologyToFeatures(neg), /out of range/)
})

test('rejects non-integer arc references', () => {
  const bad = { ...square, objects: { land: { type: 'Polygon', arcs: [['0']] } } }
  assert.throws(() => T.topologyToFeatures(bad), /not an integer/)
})

test('bounds GeometryCollection nesting without overflowing the stack', () => {
  let g = { type: 'Polygon', arcs: [[0]] }
  for (let i = 0; i < 100_000; i++) g = { type: 'GeometryCollection', geometries: [g] }
  assert.throws(() => T.topologyToFeatures({ ...square, objects: { land: g } }), /nested deeper/)
})

test('rejects non-numeric coordinates and malformed transforms', () => {
  assert.throws(() => T.topologyToFeatures({ ...square, arcs: [[[0, 'x']]] }), /numeric pair/)
  assert.throws(() => T.topologyToFeatures({ ...square, transform: { scale: [1], translate: [0, 0] } }), /transform/)
  assert.throws(() => T.geojsonToFeatures({ type: 'Polygon', coordinates: [[[0, 0], [1, NaN], [1, 1]]] }), /numeric pair/)
  assert.throws(() => T.geojsonToFeatures({ type: 'FeatureCollection', features: 'nope' }), /not an array/)
  assert.throws(() => T.geojsonToFeatures({ hello: 1 }), /neither TopoJSON nor GeoJSON/)
})

test('decodes valid GeoJSON', () => {
  const f = T.geojsonToFeatures({ type: 'Feature', properties: { name: 'x' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } })
  assert.equal(f.length, 1)
  assert.equal(f[0].properties.name, 'x')
})
