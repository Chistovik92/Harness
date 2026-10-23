import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Packaged builds load index.html over file://, so a strict CSP is safe there.
// It is skipped in dev because Vite injects inline scripts for HMR.
const csp = {
  name: 'inject-csp',
  apply: 'build' as const,
  transformIndexHtml: () => [{
    tag: 'meta',
    attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" },
    injectTo: 'head-prepend' as const,
  }],
}

export default defineConfig({
  plugins: [react(), csp],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@electron': path.resolve(__dirname, 'src/electron'),
    },
  },
})
