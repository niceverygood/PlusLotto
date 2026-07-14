import type { Config } from 'tailwindcss'

// 색 토큰은 design-system/tokens.css 의 CSS 변수를 단일 소스로 참조한다.
// (CLAUDE §3.2 의 hex 나열을 var() 매핑으로 대체 — 런타임 등급색 변경 반영, DECISIONS D2)
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: 'var(--ink-900)',
          800: 'var(--ink-800)',
          700: 'var(--ink-700)',
          600: 'var(--ink-600)',
          500: 'var(--ink-500)',
        },
        primary: {
          700: 'var(--primary-700)',
          600: 'var(--primary-600)',
          500: 'var(--primary-500)',
          100: 'var(--primary-100)',
          50: 'var(--primary-50)',
        },
        accent: {
          600: 'var(--accent-600)',
          500: 'var(--accent-500)',
          100: 'var(--accent-100)',
          50: 'var(--accent-50)',
        },
        success: { DEFAULT: 'var(--success)', bg: 'var(--success-bg)', bd: 'var(--success-bd)' },
        warning: { DEFAULT: 'var(--warning)', bg: 'var(--warning-bg)', bd: 'var(--warning-bd)' },
        danger: { DEFAULT: 'var(--danger)', bg: 'var(--danger-bg)', bd: 'var(--danger-bd)' },
        info: { DEFAULT: 'var(--info)', bg: 'var(--info-bg)', bd: 'var(--info-bd)' },
        gray: {
          50: 'var(--gray-50)',
          100: 'var(--gray-100)',
          200: 'var(--gray-200)',
          300: 'var(--gray-300)',
          400: 'var(--gray-400)',
          500: 'var(--gray-500)',
          600: 'var(--gray-600)',
          700: 'var(--gray-700)',
          800: 'var(--gray-800)',
          900: 'var(--gray-900)',
        },
        grade: {
          free: 'var(--g-free)',
          'free-bg': 'var(--g-free-bg)',
          simple: 'var(--g-simple)',
          'simple-bg': 'var(--g-simple-bg)',
          gold: 'var(--g-gold)',
          'gold-bg': 'var(--g-gold-bg)',
          goldp: 'var(--g-goldp)',
          'goldp-bg': 'var(--g-goldp-bg)',
          vip: 'var(--g-vip)',
          'vip-bg': 'var(--g-vip-bg)',
          royal: 'var(--g-royal)',
          'royal-bg': 'var(--g-royal-bg)',
          ovr: 'var(--g-ovr)',
          'ovr-bg': 'var(--g-ovr-bg)',
          toss: 'var(--g-toss)',
          'toss-bg': 'var(--g-toss-bg)',
        },
        ball: {
          y: 'var(--ball-y)',
          b: 'var(--ball-b)',
          r: 'var(--ball-r)',
          k: 'var(--ball-k)',
          g: 'var(--ball-g)',
        },
      },
      fontFamily: {
        sans: ['Pretendard Variable', 'Pretendard', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: { sm: '6px', DEFAULT: '8px', lg: '12px', full: '999px' },
      boxShadow: {
        sm: '0 1px 2px rgba(15,20,32,.06),0 1px 1px rgba(15,20,32,.04)',
        md: '0 4px 14px rgba(15,20,32,.08)',
        lg: '0 16px 40px rgba(15,20,32,.14)',
      },
      spacing: { topbar: '56px', sidebar: '248px' },
    },
  },
  plugins: [],
}

export default config
