/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'studio-bg': '#16171F',
        'studio-panel': '#1E1F29',
        'studio-elevated': '#262738',
        'studio-border': '#30314A',
        'studio-accent': '#00B3A4',
        'studio-accent-bright': '#00D9C8',
        'studio-accent-dim': '#0E8F86',
        'studio-text': '#E6E8EF',
        'studio-dim': '#9BA0B0',
        'studio-success': '#34C77B',
        'studio-danger': '#F04A5A',
        'studio-warning': '#F5A623',
        'studio-info': '#58A6FF',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
