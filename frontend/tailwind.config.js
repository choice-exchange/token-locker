/** @type {import('tailwindcss').Config} */
// Theme intentionally aligned with choice_exchange_app/tailwind.config.js so
// components can graduate into the exchange app without restyling.
// Original Choice tokens (primaryColor / btnGrey / textGrey / etc.) are kept
// verbatim; ink-* / accent-* are semantic aliases pointing at the same hex
// values for ergonomics inside this app.

const choicePalette = {
    // Backgrounds (darkest → lightest)
    darkBgColor: "#020202", // body
    greyBgColor: "#0F0F0F", // panels / cards
    socialColors: "#191919", // hover / elevated surface
    btnGrey: "#262626", // chips / inputs / secondary buttons

    // Brand accents
    primaryColor: "#FDC70C",
    primaryColorDark: "#e3b209",
    primaryBgColor: "#E9C46A",
    textGrey: "#BFBFBF",
};

export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            fontFamily: {
                sans: ["Montserrat", "Inter", "system-ui", "sans-serif"],
                montserrat: ["Montserrat", "sans-serif"],
                inter: ["Inter", "sans-serif"],
                mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
            },
            backgroundColor: {
                ...choicePalette,
            },
            colors: {
                ...choicePalette,

                // Semantic alias scale — maps onto Choice palette so existing
                // bg-ink-* / text-ink-* classes pick up the brand colors.
                ink: {
                    900: "#020202", // darkBgColor
                    800: "#0F0F0F", // greyBgColor
                    700: "#191919", // socialColors
                    600: "#262626", // btnGrey
                    500: "#2a2a2a", // borders
                    400: "#3a3a3a", // subtle borders
                    300: "#82848E", // caption text
                    200: "#BFBFBF", // textGrey
                    100: "#FFFFFF",
                },
                accent: {
                    300: "#FFE066",
                    400: "#FFD955",
                    500: "#FDC70C", // primaryColor
                    600: "#e3b209", // primaryColorDark — hover
                    700: "#a07700",
                },

                good: "#26A17B", // matches Choice's gradient green
                warn: "#FDC70C",
                bad: "#f87171",
            },
            backgroundImage: {
                "custom-gradient":
                    "linear-gradient(106.27deg, rgba(38, 161, 123, 1) -22.4%, rgba(221, 185, 98, 1) 139.03%)",
            },
            screens: {
                "max-md": { max: "767px" },
            },
            animation: {
                border: "border 4s linear infinite",
            },
            keyframes: {
                border: {
                    to: { "--border-angle": "360deg" },
                },
            },
        },
    },
    plugins: [],
};
