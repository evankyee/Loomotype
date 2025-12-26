/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Backgrounds - warm charcoal (matches desktop app)
        background: '#0a0a0b',
        surface: '#111113',
        'surface-elevated': '#18181b',
        'surface-hover': '#1f1f23',

        // Text - softer than pure white (matches SF Pro rendering)
        foreground: 'rgba(255, 255, 255, 0.95)',
        'foreground-secondary': 'rgba(255, 255, 255, 0.7)',
        'foreground-muted': 'rgba(255, 255, 255, 0.45)',
        'foreground-tertiary': 'rgba(255, 255, 255, 0.3)',

        // Borders - barely visible, refined
        border: 'rgba(255, 255, 255, 0.1)',
        'border-subtle': 'rgba(255, 255, 255, 0.06)',

        // Primary - sophisticated indigo-blue
        primary: '#6366f1',
        'primary-hover': '#818cf8',
        'primary-muted': '#4f46e5',

        // Accent - warm coral (video/creative energy)
        accent: '#f43f5e',
        'accent-hover': '#fb7185',
        'accent-muted': '#e11d48',

        // Semantic
        success: '#22c55e',
        'success-hover': '#4ade80',
        warning: '#f59e0b',
        danger: '#ef4444',
        'danger-hover': '#f87171',

        // Legacy compatibility
        card: '#111113',
        'card-hover': '#18181b',
        secondary: '#18181b',
        muted: 'rgba(255, 255, 255, 0.45)',
      },
      fontFamily: {
        sans: [
          'var(--font-sans)',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'SF Mono',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        'xs': ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        'sm': ['0.8125rem', { lineHeight: '1.25rem', letterSpacing: '-0.006em' }],
        'base': ['0.875rem', { lineHeight: '1.5rem', letterSpacing: '-0.011em' }],
        'lg': ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.014em' }],
        'xl': ['1.125rem', { lineHeight: '1.75rem', letterSpacing: '-0.017em' }],
        '2xl': ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.019em' }],
        '3xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.021em' }],
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
      borderRadius: {
        'sm': '4px',
        'DEFAULT': '6px',
        'md': '8px',
        'lg': '10px',
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      boxShadow: {
        'subtle': '0 1px 2px rgba(0, 0, 0, 0.5)',
        'elevated': '0 4px 16px rgba(0, 0, 0, 0.4)',
        'glow': '0 0 24px rgba(99, 102, 241, 0.15)',
        'glow-accent': '0 0 24px rgba(244, 63, 94, 0.15)',
        'inset': 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
      },
      transitionDuration: {
        '100': '100ms',
        '150': '150ms',
        '200': '200ms',
      },
      transitionTimingFunction: {
        'snappy': 'cubic-bezier(0.2, 0, 0, 1)',
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'slide-up': 'slideUp 150ms cubic-bezier(0.2, 0, 0, 1)',
        'scale-in': 'scaleIn 150ms cubic-bezier(0.2, 0, 0, 1)',
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
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
      backdropBlur: {
        'xs': '4px',
      },
    },
  },
  plugins: [],
};
