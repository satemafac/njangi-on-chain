import { Html, Head, Main, NextScript } from 'next/document';
import { AUTH_CALLBACK_FRAGMENT_SCRIPT } from '@/lib/auth-callback-fragment';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Favicons. All generated from public/brand/icon-source.png (the brand
            mandala, trimmed to its bounding box) by scripts/generate-icons.mjs —
            replace the source and re-run it, never hand-edit the rasters.
            Google only considers a favicon whose dimensions are a square
            multiple of 48px, which is why the PNGs stop at 192 and the 512
            lives in the manifest instead. */}
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" type="image/png" sizes="48x48" href="/icons/icon-48.png" />
        <link rel="icon" type="image/png" sizes="96x96" href="/icons/icon-96.png" />
        <link rel="icon" type="image/png" sizes="144x144" href="/icons/icon-144.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        
        {/* SEO + Open Graph + Twitter are defined PER PAGE via next/head (the
            landing emits the dark globe og.png + on-brand copy). A stale global
            set here was duplicating every page's tags, so scrapers showed two
            images and the wrong description. Keep _document global-only. */}

        {/* Web App capabilities */}
        {/* theme-color is set per-page via next/head (the landing uses #0a0a0c);
            no global default here so it can't conflict / force a tint on light pages. */}
        <meta name="google-site-verification" content="f6bd3c31267ded21" />

        {/* Parks the OAuth fragment (#id_token=...) off the URL BEFORE Next's
            client boots. Next replays location.href through router.replace
            during hydration, and `iss=https://` trips its `//` check, so the
            full JWT was console.error'd on every login. Must be a plain
            synchronous script here — anything bundled runs too late. See
            src/lib/auth-callback-fragment.ts. */}
        <script dangerouslySetInnerHTML={{ __html: AUTH_CALLBACK_FRAGMENT_SCRIPT }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
} 