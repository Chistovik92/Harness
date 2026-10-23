// Vite's root is src/renderer, so point Tailwind at its config explicitly.
const path = require('node:path')

module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.cjs') },
    autoprefixer: {},
  },
}
