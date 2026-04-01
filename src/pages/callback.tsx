import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { CallbackStatusShell } from '@/components/ui/CallbackStatusShell';

export default function AuthCallback() {
  const router = useRouter();
  const { handleCallback, setError } = useAuth();
  const [status, setStatus] = useState('Processing authentication...');
  const [progress, setProgress] = useState(0);
  const [isError, setIsError] = useState(false);
  const hasProcessedCallbackRef = useRef(false);
  const redirectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    // Show progress animation
    const progressInterval = setInterval(() => {
      setProgress(prev => {
        // Cap progress at 90% until we actually complete
        return prev < 90 ? prev + 5 : prev;
      });
    }, 1000); // Update every second
    
    return () => clearInterval(progressInterval);
  }, []);

  useEffect(() => {
    return () => {
      if (redirectTimeoutRef.current) {
        clearTimeout(redirectTimeoutRef.current);
        redirectTimeoutRef.current = null;
      }
    };
  }, []);
  
  useEffect(() => {
    if (hasProcessedCallbackRef.current) {
      return;
    }

    hasProcessedCallbackRef.current = true;

    const processCallback = async () => {
      try {
        console.log('Processing authentication callback');
        
        // Try to get the ID token from different places
        let idToken = null;
        
        // 1. Try URL hash (fragment)
        const hash = window.location.hash.substring(1);
        const hashParams = new URLSearchParams(hash);
        idToken = hashParams.get('id_token');
        
        // 2. If not in hash, try search params (query string)
        if (!idToken) {
          console.log('ID token not found in URL hash, checking search params');
          const searchParams = new URLSearchParams(window.location.search);
          idToken = searchParams.get('id_token');
        }
        
        // 3. Try extracting from full URL if token format is recognizable
        if (!idToken) {
          console.log('Attempting to extract token from full URL');
          const fullUrl = window.location.href;
          const tokenMatch = fullUrl.match(/id_token=([^&]+)/);
          if (tokenMatch && tokenMatch[1]) {
            idToken = tokenMatch[1];
            console.log('Found token in URL pattern match');
          }
        }
        
        console.log('URL information:', {
          fullUrl: window.location.href,
          hash: window.location.hash,
          search: window.location.search,
          hashLength: hash.length,
          idTokenFound: !!idToken
        });

        if (!idToken) {
          throw new Error('No ID token found in callback URL');
        }

        setStatus('Generating zero-knowledge proof...');
        
        // Complete the zkLogin flow
        await handleCallback(idToken);
        
        // Set progress to 100% when done
        setProgress(100);
        setStatus('Authentication successful! Redirecting...');
        
        // Check if there's a stored redirect URL
        const redirectUrl = localStorage.getItem('redirectAfterLogin');
        
        // Short delay before redirecting to show completion
        redirectTimeoutRef.current = setTimeout(() => {
          if (redirectUrl) {
            // Clear the stored redirect URL
            localStorage.removeItem('redirectAfterLogin');
            console.log('Redirecting to stored URL:', redirectUrl);
            // Use window.location.href for external URLs or different origins
            window.location.href = redirectUrl;
          } else {
            // Default redirect to dashboard
            router.replace('/dashboard');
          }
        }, 500);
      } catch (err) {
        console.error('Auth callback error:', err);
        setIsError(true);
        setStatus('Authentication failed');
        setError(err instanceof Error ? err.message : 'Authentication failed');
        
        // Short delay before redirecting on error
        redirectTimeoutRef.current = setTimeout(() => {
          router.replace('/');
        }, 2000);
      }
    };

    processCallback();
  }, [handleCallback, router, setError]);

  const tone = isError ? 'error' : progress >= 100 ? 'success' : 'processing';
  const pageTitle = isError
    ? 'Sign-in failed - Njangi on-chain'
    : 'Completing sign in - Njangi on-chain';
  const lead = isError
    ? 'We could not complete the secure sign-in handoff. The app will return you to the sign-in entry point so you can try again.'
    : 'We’re validating the provider response, generating your zero-knowledge proof, and restoring the right destination before returning you to the app.';
  const helperText = isError
    ? 'Redirecting you back to the login page.'
    : tone === 'success'
      ? 'Your wallet session is ready. Redirecting you now.'
      : 'Keep this tab open while the secure handoff completes.';

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
      </Head>
      <CallbackStatusShell
        tone={tone}
        status={status}
        progress={progress}
        lead={lead}
        helper={helperText}
        chips={['OAuth callback', 'zkLogin proof', 'Dashboard restore']}
      />
    </>
  );
}
