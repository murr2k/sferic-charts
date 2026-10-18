import { defineConfig, Plugin } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { cpus } from 'node:os'

/**
 * Dev-only: POST /__snap?name=foo with a PNG body writes it to SFERIC_SNAP_DIR
 * (default .snapshots/). Used to inspect rendered charts during development.
 */
function snapshotSink(): Plugin {
  const dir = process.env.SFERIC_SNAP_DIR || '.snapshots'
  return {
    name: 'sferic-snapshot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__snap', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        const name = basename(new URL(req.url ?? '', 'http://x').searchParams.get('name') || 'snap').replace(/[^\w.-]/g, '_')
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          mkdirSync(dir, { recursive: true })
          const file = join(dir, name.endsWith('.png') ? name : `${name}.png`)
          writeFileSync(file, Buffer.concat(chunks))
          res.end(file)
        })
      })
    },
  }
}

/**
 * Dev-only: GET /__cpu returns cumulative [idle, busy] milliseconds per logical
 * processor (os.cpus()). The live CPU example derives utilization from deltas.
 * Windows already counts interrupt time inside `sys` (user + sys + idle = wall
 * time), so `irq` is added only on other platforms.
 */
function cpuTimes(): Plugin {
  return {
    name: 'sferic-cpu-times',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__cpu', (_req, res) => {
        const irq = process.platform === 'win32' ? 0 : 1
        const times = cpus().map(({ times: t }) => [t.idle, t.user + t.nice + t.sys + irq * t.irq])
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ times }))
      })
    },
  }
}

// Gallery dev server. Port 8779 is allocated in ~/.claude/port-registry.md.
export default defineConfig({
  plugins: [snapshotSink(), cpuTimes()],
  server: { port: 8779, strictPort: true, host: '127.0.0.1' },
  preview: { port: 8779, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist-gallery', target: 'es2022' },
})
