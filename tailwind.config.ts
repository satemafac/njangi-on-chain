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

        // The public-site palette. Every public page (landing, /learn, /faq,
        // /pricing, /blog) sits on Apple's dark-page system: a pure-black
        // canvas, tiles lifted a few steps above it, labels stepping down in
        // contrast rather than hue, gold the single accent.
        //
        // `ink` / `cream` / `sand` are the names the long-form marketing pages
        // were written against (2026-08); `night` / `mist` below are the
        // landing's names for the same values. Both resolve to one set of
        // neutrals so the pages cannot drift onto different greys again.
        ink: {
          DEFAULT: "#000000", // page background, and the theme-color meta
          deep: "#0b0b0d",
          surface: "#141416", // cards
          border: "#2c2c2e",
          inner: "#1d1d1f",
        },
        gold: {
          DEFAULT: "#E8B04B", // accents, eyebrows, active states
          hi: "#f6d99a", // highlights and focus rings
          deep: "#C8902F", // gradient end
          on: "#1d1d1f", // text on a gold fill
        },
        cream: {
          DEFAULT: "#f5f5f7", // headings, primary labels
          muted: "#d2d2d7", // secondary text and links
          cowrie: "#EDE4D3", // the heritage accent — cultural names
        },
        sand: {
          DEFAULT: "#a1a1a6", // body text
          dim: "#86868b", // captions
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
