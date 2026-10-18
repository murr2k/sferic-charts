// Patterns that keep local paths and other leaks out of the published package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forbiddenIn } from '../scripts/forbidden.mjs'

test('flags leaked home directories on Windows, Linux and macOS', () => {
  for (const s of [
    'C:\\Users\\alice\\proj\\src\\a.ts',
    '"C:/Users/alice/proj/src/a.ts"',
    '"sourceRoot":"/home/alice/proj/"',
    "sources: ['/Users/alice/proj/src/a.ts']",
    'file:///home/alice/proj/a.ts',
  ]) assert.ok(forbiddenIn(s).some((w) => w.startsWith('local absolute path')), s)
})

test('leaves relative paths, URLs and prose alone', () => {
  for (const s of ['../src/index.ts', 'https://example.com/home/page/', 'https://x.org/Users/list/', '/usr/lib/x.so', 'a /home dir'])
    assert.deepEqual(forbiddenIn(s), [], s)
})

test('flags product names and debug globals', () => {
  assert.deepEqual(forbiddenIn('new LightningChart()'), ['third-party product name'])
  assert.deepEqual(forbiddenIn('window.__sfericDebug = debug'), ['debug global'])
})
