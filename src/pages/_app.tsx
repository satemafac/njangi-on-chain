import React, { useEffect } from 'react';
import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { AuthProvider } from '../contexts/AuthContext';
import { ActivityDetector } from '@/components/ActivityDetector';
import { IdleWarningModal } from '@/components/IdleWarningModal';
import { useAuth } from '@/contexts/AuthContext';
import { Navbar } from '@/components/ui/Navbar';
import { Toaster } from 'react-hot-toast';

function AppContent({ Component, pageProps }: AppProps) {
  const { isAuthenticated } = useAuth();

  return (
    <ActivityDetector>
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
  // Initialize automation service on app startup (client-side only)
  useEffect(() => {
    // Only run on client side
    if (typeof window !== 'undefined') {
      console.log('🤖 Initializing Njangi Automation System...');
      
      // Start automation service in background
      fetch('/api/automation/start', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            console.log('✅ Automation service started successfully');
          } else {
            console.warn('⚠️ Automation service startup failed:', data.error);
          }
        })
        .catch(error => {
          console.warn('⚠️ Could not connect to automation service:', error.message);
        });
    }
  }, []);

  return (
    <AuthProvider>
      <AppContent {...props} />
    </AuthProvider>
  );
} 