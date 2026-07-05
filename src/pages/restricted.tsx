// /restricted — landing page for the embargoed-jurisdiction geo-block
// (src/middleware.ts; program details in docs/sanctions-program.md).
// Static and dependency-free on purpose: it must render for a blocked
// visitor without touching auth, RPC, or the database.

import React from 'react';
import Head from 'next/head';

export default function Restricted() {
  return (
    <>
      <Head>
        <title>Not available in your region - Njangi On-Chain</title>
        <meta name="robots" content="noindex" />
      </Head>
      <main className="flex min-h-screen items-center justify-center bg-[#fbfaf7] px-6">
        <div className="max-w-md rounded-[28px] border border-[#dfd6ca] bg-white p-8 text-center shadow-[0_28px_80px_-40px_rgba(15,23,42,0.35)]">
          <h1 className="text-xl font-semibold tracking-[-0.03em] text-[#171923]">
            Njangi On-Chain isn&apos;t available in your region
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#5d6674]">
            Legal restrictions prevent us from offering the app where you are
            connecting from. Informational pages remain available.
          </p>
        </div>
      </main>
    </>
  );
}
