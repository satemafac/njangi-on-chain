import type { Config } from "tailwindcss";

export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/content/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",

        // The landing palette, promoted from inline arbitrary values.
        // Before this, every brand colour in the app was written as an
        // arbitrary hex (`text-[#E8B04B]`) with no shared definition, which is
        // how /learn, /faq and /blog drifted onto a different colour system
        // from the landing. Prefer these names in new work; the arbitrary
        // values still in place elsewhere are equivalent, not different.
        ink: {
          DEFAULT: "#0a0a0c", // page background, and the theme-color meta
          deep: "#0d0c12",
          surface: "#13121a", // cards
          border: "#2a2620",
          inner: "#221f29",
        },
        gold: {
          DEFAULT: "#E8B04B", // accents, eyebrows, active states
          hi: "#f6d99a", // highlights and focus rings
          deep: "#C8902F", // gradient end
          on: "#1a1304", // text on a gold fill
        },
        cream: {
          DEFAULT: "#f5f1e8", // headings
          muted: "#cfc8ba", // secondary text and links
          cowrie: "#EDE4D3",
        },
        sand: {
          DEFAULT: "#a8a294", // body text
          dim: "#8b8578", // captions
        },
        sui: "#4DA2FF",
      },
    },
  },
  plugins: [],
} satisfies Config;
