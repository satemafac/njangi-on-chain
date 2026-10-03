import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { AuthProvider } from '../contexts/AuthContext';
import { Seo } from '@/components/Seo';
import { isNoindexRoute } from '@/lib/seo-routes';
import { organization } from '@/lib/structured-data';
import { ActivityDetector } from '@/components/ActivityDetector';
import { IdleWarningModal } from '@/components/IdleWarningModal';
import { useAuth } from '@/contexts/AuthContext';
import { Navbar } from '@/components/ui/Navbar';
import LocaleDirSync from '@/components/LocaleDirSync';
import { Toaster } from 'react-hot-toast';
import { Analytics } from '@vercel/analytics/next';
import { useSameUrlNavigationRecovery } from '@/hooks/useSameUrlNavigationRecovery';

function AppContent({ Component, pageProps }: AppProps) {
  const { isAuthenticated } = useAuth();
  // router.pathname is the route *pattern* ("/circle/[id]/goals"), not asPath —
  // stable during SSR and it never leaks a circle id into the decision.
  const { pathname } = useRouter();
  const blocked = isNoindexRoute(pathname);

  return (
    <ActivityDetector>
      <Head>
        {/* Deliberately UNKEYED. next/head's own defaultHead() ships an unkeyed
            viewport tag; a keyed one here would bypass the name-category dedup
            and render both. Unkeyed means ours collapses with theirs. */}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {/* Sitewide head defaults. This belongs in _app and NOT in _document:
          _app's <Head> is next/head's, so it shares the dedup pass with each
          page's <Seo> and page tags cleanly override it. _document's <Head> is
          next/document's, which has no dedup against next/head output at all —
          which is why SEO tags there duplicated every page's and had to be
          removed. Any page rendering its own <Seo> overrides everything here. */}
      <Seo noindex={blocked} nofollow={blocked} siteJsonLd={[organization()]} />
      <LocaleDirSync />
      {isAuthenticated && (
        <>
          <Navbar />
          <IdleWarningModal />
        </>
      )}
      <Component {...pageProps} />
      {/* Toast palette mirrors BillingUpsellModal / CallbackStatusShell:
          warm paper surface, ink text, muted green/brick status icons. */}
      <Toaster
        position="bottom-center"
        reverseOrder={false}
        toastOptions={{
          duration: 5000,
          style: {
            background: '#fbfaf7',
            color: '#171923',
            border: '1px solid #dfd6ca',
            borderRadius: '14px',
            boxShadow: '0 18px 50px -24px rgba(15, 23, 42, 0.35)',
            padding: '10px 14px',
            fontSize: '14px',
            fontWeight: 500,
            lineHeight: '1.45',
          },
          success: {
            duration: 3000,
            iconTheme: {
              primary: '#3f7d54',
              secondary: '#fbfaf7',
            },
          },
          error: {
            duration: 6000,
            iconTheme: {
              primary: '#a1493c',
              secondary: '#fbfaf7',
            },
          }
        }}
      />
      <Analytics />
    </ActivityDetector>
  );
}

// No MoonPayProvider here. It used to wrap every page, but nothing consumed
// it: the MoonPay flow is the signed-URL launcher (MoonPayLauncher). It
// injected MoonPay's SDK script into every page view, and when an ad blocker
// or the network stopped that script its rejection went unhandled (Sentry
// JAVASCRIPT-NEXTJS-2). It was also a `next/dynamic` component swapped in
// after mount, so every page rendered, went blank while the chunk loaded, and
// remounted from scratch.
export default function App(props: AppProps) {
  useSameUrlNavigationRecovery();

  return (
    <AuthProvider>
      <AppContent {...props} />
    </AuthProvider>
  );
}
