/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Backgrounds - warm charcoal tones, not cold navy
        background: '#0c0c0e',
        surface: '#141416',
        'surface-elevated': '#1a1a1d',
        'surface-hover': '#222225',

        // Text - softer, more readable (not pure white)
        foreground: '#f4f4f5',
        'foreground-secondary': '#a1a1aa',
        'foreground-muted': '#63636e',

        // Borders - subtle and refined
        border: '#27272a',
        'border-subtle': '#1e1e21',

        // Primary accent - sophisticated blue (not neon)
        primary: '#5c7cfa',
        'primary-hover': '#4c6ef5',
        'primary-muted': '#364fc7',

        // Secondary accent - warm coral for video/creative feel
        accent: '#ff6b6b',
        'accent-hover': '#fa5252',
        'accent-muted': '#c92a2a',

        // Semantic
        success: '#51cf66',
        'success-muted': '#40c057',
        warning: '#fcc419',
        danger: '#ff6b6b',
        'danger-hover': '#fa5252',

        // Legacy compatibility (gradual migration)
        card: '#141416',
        'card-hover': '#1a1a1d',
        secondary: '#1a1a1d',
        muted: '#63636e',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        'xs': ['0.75rem', { lineHeight: '1rem' }],
        'sm': ['0.8125rem', { lineHeight: '1.25rem' }],
        'base': ['0.875rem', { lineHeight: '1.5rem' }],
        'lg': ['1rem', { lineHeight: '1.75rem' }],
        'xl': ['1.125rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.25rem', { lineHeight: '2rem' }],
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
      borderRadius: {
        'sm': '0.25rem',
        'DEFAULT': '0.375rem',
        'md': '0.5rem',
        'lg': '0.75rem',
        'xl': '1rem',
      },
      boxShadow: {
        'subtle': '0 1px 2px 0 rgba(0, 0, 0, 0.3)',
        'elevated': '0 4px 12px 0 rgba(0, 0, 0, 0.4)',
        'glow': '0 0 20px rgba(92, 124, 250, 0.15)',
        'glow-accent': '0 0 20px rgba(255, 107, 107, 0.15)',
      },
      transitionDuration: {
        '150': '150ms',
        '200': '200ms',
      },
      transitionTimingFunction: {
        'snappy': 'cubic-bezier(0.2, 0, 0, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-up': 'slideUp 200ms cubic-bezier(0.2, 0, 0, 1)',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
};
