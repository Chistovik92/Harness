const path = require('node:path')

module.exports = {
  darkMode: 'class',
  content: [path.join(__dirname, 'src/renderer/**/*.{html,js,ts,jsx,tsx}')],
  theme: {
    extend: {
      colors: {
        text: '#f1f5f9',
        surface: '#1e293b',
        'surface-hover': '#334155',
        border: '#334155',
        'text-muted': '#94a3b8',
        accent: '#6366f1',
        'accent-hover': '#4f46e5',
      },
    },
  },
  plugins: [],
}
