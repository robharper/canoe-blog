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
                            fontWeight: '800',
                            letterSpacing: '-0.02rem',
                        },
                        p: {
                            fontSize: '1.25rem',
                        },
                        h1: {
                            fontSize: '2.4rem',
                        },
                        h2: {
                            fontSize: '1.6rem',
                        },
                        h3: {
                            fontSize: '1.5rem',
                        },
                        h4: {
                            fontSize: '1.4rem',
                        },
                    },
                }
            }),
        },
    },
    plugins: [typography],
}