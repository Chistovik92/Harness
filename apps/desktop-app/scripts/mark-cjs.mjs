// Electron main/preload/worker are emitted as CommonJS, but the package is "type": "module".
// A nested package.json makes Node treat dist/electron/*.js as CommonJS.
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('dist/electron', { recursive: true })
writeFileSync('dist/electron/package.json', JSON.stringify({ type: 'commonjs' }) + '\n')
