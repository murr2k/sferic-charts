import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    lib: { entry: 'src/index.ts', name: 'sferic', formats: ['es', 'umd'], fileName: (f) => (f === 'es' ? 'sferic.js' : 'sferic.umd.cjs') },
    outDir: 'dist',
    sourcemap: true,
  },
})
