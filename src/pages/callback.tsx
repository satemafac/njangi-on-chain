import React, { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';

export default function AuthCallback() {
  const router = useRouter();
  const { handleCallback, setError } = useAuth();
  
  useEffect(() => {
    const processCallback = async () => {
      try {
        // Get the ID token from the URL hash
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const idToken = params.get('id_token');

        if (!idToken) {
          throw new Error('No ID token found in callback URL');
        }

        // Complete the zkLogin flow
        await handleCallback(idToken);
        router.push('/dashboard');
      } catch (err) {
        console.error('Auth callback error:', err);
        setError(err instanceof Error ? err.message : 'Authentication failed');
        router.push('/');
      }
    };

    processCallback();
  }, [handleCallback, router, setError]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent"></div>
      <span className="ml-3 text-gray-700">Completing authentication...</span>
    </div>
  );
} 