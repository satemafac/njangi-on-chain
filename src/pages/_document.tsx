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
        
        {/* Primary Meta Tags */}
        <meta name="title" content="Njangi On-Chain" />
        <meta name="description" content="Join secure, transparent savings circles powered by SUI blockchain. Create and manage your community savings with automated payouts and full transparency." />
        <meta name="keywords" content="njangi, savings circle, sui blockchain, community savings, blockchain" />
        
        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://njangi-on-chain-1014e48e59ae.herokuapp.com/" />
        <meta property="og:title" content="Njangi On-Chain - Community Savings Circles" />
        <meta property="og:description" content="Join secure, transparent savings circles powered by SUI blockchain. Create and manage your community savings with automated payouts and full transparency." />
        <meta property="og:image" content="https://njangi-on-chain-1014e48e59ae.herokuapp.com/og-image.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="Njangi On-Chain logo with the text 'Community Savings Circles on SUI Blockchain'" />
        <meta property="og:site_name" content="Njangi On-Chain" />
        
        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content="https://njangi-on-chain-1014e48e59ae.herokuapp.com/" />
        <meta property="twitter:title" content="Njangi On-Chain - Community Savings Circles" />
        <meta property="twitter:description" content="Join secure, transparent savings circles powered by SUI blockchain. Create and manage your community savings with automated payouts and full transparency." />
        <meta property="twitter:image" content="https://njangi-on-chain-1014e48e59ae.herokuapp.com/og-image.png" />
        <meta name="twitter:image:alt" content="Njangi On-Chain logo with the text 'Community Savings Circles on SUI Blockchain'" />
        
        {/* Web App capabilities */}
        <meta name="theme-color" content="#3B82F6" /> {/* Blue-600 color */}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
} 