import React, { useEffect, useState } from 'react';
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
import dynamic from 'next/dynamic';
import { Analytics } from '@vercel/analytics/next';

// Dynamically import MoonPayProvider to avoid SSR issues
const MoonPayProvider = dynamic(
  () => import('@moonpay/moonpay-react').then(mod => ({ default: mod.MoonPayProvider })),
  { ssr: false }
);

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

export default function App(props: AppProps) {
  const [isMounted, setIsMounted] = useState(false);

  // Initialize automation service on app startup (client-side only)
  useEffect(() => {
    setIsMounted(true);
    
    // Only run on client side
    if (typeof window !== 'undefined') {
      console.log('ℹ️ Using new WhatsApp Bot Backend for notifications...');
      
      // DISABLED: Start automation service in background
      // The old automation service has been replaced by the new WhatsApp Bot Backend Service
      // which runs independently and handles blockchain events, data fetching, and WhatsApp notifications.
      // New service: whatsapp-bot-backend (separate Node.js service)
      // 
      // Old code:
      // fetch('/api/automation/start', { method: 'POST' })
      //   .then(response => response.json())
      //   .then(data => {
      //     if (data.success) {
      //       console.log('✅ Automation service started successfully');
      //     } else {
      //       console.warn('⚠️ Automation service startup failed:', data.error);
      //     }
      //   })
      //   .catch(error => {
      //     console.warn('⚠️ Could not connect to automation service:', error.message);
      //   });
    }
  }, []);

  // Render without MoonPayProvider during SSR
  if (!isMounted) {
    return (
      <AuthProvider>
        <AppContent {...props} />
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <MoonPayProvider
        apiKey={process.env.NEXT_PUBLIC_MOONPAY_API_KEY || ""}
        debug={process.env.NODE_ENV === 'development'}
      >
        <AppContent {...props} />
      </MoonPayProvider>
    </AuthProvider>
  );
} 