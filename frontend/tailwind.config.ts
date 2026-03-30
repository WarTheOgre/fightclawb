import type { Config } from 'tailwindcss'

export default {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        black: '#080808',
        dark: '#111111',
        concrete: '#1c1c1c',
        blood: '#7a0000',
        red: '#c41e1e',
        rust: '#8b3a2a',
        cream: '#e8e3da',
        yellow: '#c9a84c',
        chalk: '#d4cfc8',
        ghost: 'rgba(232,227,218,0.06)',
      },
      fontFamily: {
        bebas: ['var(--font-bebas)', 'sans-serif'],
        marker: ['var(--font-marker)', 'cursive'],
        mono: ['var(--font-ibm-mono)', 'monospace'],
        oswald: ['var(--font-oswald)', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
