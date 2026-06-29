import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* Favicon */}
        <link rel="icon" href="/icons/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16x16.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icons/android-chrome-192x192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icons/android-chrome-512x512.png" />
        <link rel="manifest" href="/site.webmanifest" />
        
        {/* SEO + Open Graph + Twitter are defined PER PAGE via next/head (the
            landing emits the dark globe og.png + on-brand copy). A stale global
            set here was duplicating every page's tags, so scrapers showed two
            images and the wrong description. Keep _document global-only. */}

        {/* Web App capabilities */}
        {/* theme-color is set per-page via next/head (the landing uses #0a0a0c);
            no global default here so it can't conflict / force a tint on light pages. */}
        <meta name="google-site-verification" content="f6bd3c31267ded21" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
} 