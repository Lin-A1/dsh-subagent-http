import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  outDir: 'lib',
  clean: true,
  sourcemap: false,
})
