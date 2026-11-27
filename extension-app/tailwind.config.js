/** @type {import('tailwindcss').Config} */
// Colors are CSS variables (src/styles.css) so light and dark share one set of names.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './sidepanel.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        card: v('card'),
        raised: v('raised'),
        line: v('line'),
        hair: v('hair'),
        faint: v('faint'),
        fg: v('fg'),
        muted: v('muted'),
        // Color says who approves: agent (blue), you with one key (orange accent),
        // you plus your second key (magenta "both"). "both" also marks anything risky.
        accent: v('accent'),
        'accent-text': v('accent-text'),
        'on-accent': v('on-accent'),
        agent: v('agent'),
        'on-agent': v('on-agent'),
        both: v('both'),
        'on-both': v('on-both'),
      },
      fontFamily: {
        // Same typefaces as the website (haptixwallet.xyz).
        sans: ['"Geist Sans"', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        btn: '10px',
        card: '12px',
      },
    },
  },
  plugins: [],
};
