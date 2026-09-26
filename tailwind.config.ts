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

        // Landing surfaces + labels (Apple dark-page system: a pure-black
        // canvas, tiles lifted a few steps above it, labels stepping down
        // in contrast rather than hue). Gold stays the single accent.
        night: {
          DEFAULT: "#000000", // canvas
          tile: "#141416", // bento tiles, sheets
          raised: "#1d1d1f", // controls on a tile, hover fills
          line: "#2c2c2e", // hairlines on tiles
        },
        mist: {
          DEFAULT: "#f5f5f7", // primary labels, headlines
          2: "#a1a1a6", // secondary copy (8:1 on black)
          3: "#86868b", // captions, fine print (5.8:1 on black)
          4: "#6e6e73", // large decorative text only (4.1:1)
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
