/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0a0a0f',
        foreground: '#ffffff',
        card: '#12121a',
        'card-hover': '#1a1a25',
        border: 'rgba(255,255,255,0.1)',
        primary: '#667eea',
        'primary-hover': '#764ba2',
        secondary: '#1e1e2e',
        muted: '#6b6b80',
        accent: '#22c55e',
        danger: '#ef4444',
      },
    },
  },
  plugins: [],
};
