import { defineConfig } from 'vite'
import { sfericAlias } from './vite.config'

// Static website build: site/ becomes the root of dist-site/. `npm run build:site` then
// builds the gallery into dist-site/gallery/ (vite.config.ts, --mode pages). In
// development the website is served by the gallery dev server at /site/.
export default defineConfig({
  root: 'site',
  base: './',
  publicDir: false,
  resolve: { alias: sfericAlias },
  // The usage editor runs readers' code against the whole library, so it is bundled
  // in full (about 180 kB gzipped) rather than tree-shaken.
  build: { outDir: '../dist-site', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
})
