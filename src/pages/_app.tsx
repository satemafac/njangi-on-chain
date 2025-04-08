import React from 'react';
import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { AuthProvider } from '../contexts/AuthContext';
import { ActivityDetector } from '@/components/ActivityDetector';
import { IdleWarningModal } from '@/components/IdleWarningModal';
import { useAuth } from '@/contexts/AuthContext';
import { Navbar } from '@/components/ui/Navbar';

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
    </ActivityDetector>
  );
}

export default function App(props: AppProps) {
  return (
    <AuthProvider>
      <AppContent {...props} />
    </AuthProvider>
  );
} 