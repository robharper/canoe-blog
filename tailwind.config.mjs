/** @type {import('tailwindcss').Config} */
import typography from '@tailwindcss/typography';

export default {
    content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
    theme: {
        extend: {
            fontFamily: {
                heading: ['Inter', 'system-ui', 'sans-serif'],
                body: ['Source Serif 4', 'Georgia', 'serif'],
            },
            typography: (theme) => ({
                DEFAULT: {
                    css: {
                        maxWidth: '84ch',
                        fontFamily: theme('fontFamily.body'),
                        letterSpacing: '-0.005rem',
                        lineHeight: 1.6,
                        'h1, h2, h3, h4': {
                            fontFamily: theme('fontFamily.heading'),
                            letterSpacing: '-0.04rem',
                        },
                        p: {
                            fontSize: '1.25rem',
                        },
                        h1: {
                            fontSize: '2.4rem',
                            fontWeight: '900',
                        },
                        h2: {
                            fontSize: '1.65rem',
                            fontWeight: '900',
                        },
                        h3: {
                            fontSize: '1.45rem',
                            fontWeight: '800',
                        },
                        h4: {
                            fontSize: '1.35rem',
                            fontWeight: '600',
                        },
                    },
                }
            }),
        },
    },
    plugins: [typography],
}