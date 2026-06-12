import React, { useEffect, useState } from 'react';
import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { AuthProvider } from '../contexts/AuthContext';
import { ActivityDetector } from '@/components/ActivityDetector';
import { IdleWarningModal } from '@/components/IdleWarningModal';
import { useAuth } from '@/contexts/AuthContext';
import { Navbar } from '@/components/ui/Navbar';
import LocaleDirSync from '@/components/LocaleDirSync';
import { Toaster } from 'react-hot-toast';
import dynamic from 'next/dynamic';

// Dynamically import MoonPayProvider to avoid SSR issues
const MoonPayProvider = dynamic(
  () => import('@moonpay/moonpay-react').then(mod => ({ default: mod.MoonPayProvider })),
  { ssr: false }
);

function AppContent({ Component, pageProps }: AppProps) {
  const { isAuthenticated } = useAuth();

  return (
    <ActivityDetector>
      <LocaleDirSync />
      {isAuthenticated && (
        <>
          <Navbar />
          <IdleWarningModal />
        </>
      )}
      <Component {...pageProps} />
      <Toaster 
        position="bottom-center" 
        reverseOrder={false}
        toastOptions={{
          duration: 5000,
          style: {
            background: '#363636',
            color: '#fff',
          },
          success: {
            duration: 3000,
          },
          error: {
            duration: 6000,
          }
        }}
      />
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