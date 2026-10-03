import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { CallbackStatusShell } from '@/components/ui/CallbackStatusShell';
import { claimCallbackToken } from '@/lib/auth-callback-guard';
import {
  clearAuthCallbackFragment,
  readAuthCallbackFragment,
} from '@/lib/auth-callback-fragment';
import { isAppPath, takePostLoginDestination } from '@/lib/post-login-redirect';
import { trackFunnel } from '@/lib/funnel-events';

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
    if (!router.isReady) {
      return;
    }

    if (hasProcessedCallbackRef.current) {
      return;
    }

    hasProcessedCallbackRef.current = true;

    // On failure, decide the destination when the timer fires, not now: a
    // parallel run (duplicate page load, or a dev StrictMode re-run) may
    // have established the session while the error was on screen, and an
    // authenticated user belongs on the dashboard, not the landing page.
    const redirectAfterFailure = () => {
      redirectTimeoutRef.current = setTimeout(() => {
        clearAuthCallbackFragment();
        if (
          window.localStorage.getItem('isAuthenticated') === 'true' &&
          window.localStorage.getItem('account')
        ) {
          router.replace('/dashboard');
        } else {
          router.replace('/');
        }
      }, 2000);
    };

    const processCallback = async () => {
      try {
        console.log('Processing authentication callback');
        
        // Try to get the ID token from different places
        let idToken = null;
        let appleUserData = null;
        
        // 1. Try the URL fragment. _document parks it off the address bar
        //    before Next boots (see auth-callback-fragment.ts); this reads
        //    the stash and falls back to the live hash.
        const hash = readAuthCallbackFragment();
        const hashParams = new URLSearchParams(hash);
        idToken = hashParams.get('id_token');
        const hashError = hashParams.get('error');
        const hashErrorDescription = hashParams.get('error_description');
        const hashCode = hashParams.get('code');
        
        // Extract Apple user data if available
        const userDataParam = hashParams.get('user');
        if (userDataParam) {
          try {
            appleUserData = JSON.parse(decodeURIComponent(userDataParam));
            console.log('Apple user profile data found:', appleUserData);
          } catch (e) {
            console.warn('Failed to parse Apple user data:', e);
          }
        }
        
        // 2. If not in hash, try search params (query string)
        if (!idToken) {
          console.log('ID token not found in URL hash, checking search params');
          const searchParams = new URLSearchParams(window.location.search);
          idToken = searchParams.get('id_token');

          const searchError = searchParams.get('error');
          const searchErrorDescription = searchParams.get('error_description');
          const searchCode = searchParams.get('code');

          if (!idToken) {
            const providerError = hashError || searchError;
            const providerErrorDescription = hashErrorDescription || searchErrorDescription;
            const authorizationCode = hashCode || searchCode;

            if (providerError) {
              throw new Error(
                decodeURIComponent(providerErrorDescription || providerError)
              );
            }

            if (authorizationCode) {
              throw new Error('Authorization code received without an ID token. Check the OAuth response mode and callback route configuration.');
            }
          }
        }
        
        // 3. Try extracting from the raw fragment / full URL if the token
        //    format is recognizable
        if (!idToken) {
          console.log('Attempting to extract token from full URL');
          const fullUrl = `${window.location.href}#${hash}`;
          const tokenMatch = fullUrl.match(/id_token=([^&]+)/);
          if (tokenMatch && tokenMatch[1]) {
            idToken = tokenMatch[1];
            console.log('Found token in URL pattern match');
          }
        }
        
        // Shape only — never the URL, fragment or query themselves, which
        // carry the id_token (and with it the user's email and sub).
        console.log('URL information:', {
          pathname: window.location.pathname,
          hashLength: hash.length,
          searchLength: window.location.search.length,
          idTokenFound: !!idToken
        });

        if (!idToken) {
          setIsError(true);
          setStatus('Authentication failed');
          setError('No ID token found in callback URL. Check the OAuth redirect configuration and try again.');
          redirectAfterFailure();
          return;
        }

        if (!claimCallbackToken(idToken)) {
          // A concurrent invocation of this effect (React StrictMode
          // re-runs it in dev with a fresh ref) already owns this token —
          // let that run drive the UI instead of racing it with a
          // duplicate /api/zkLogin call.
          return;
        }

        setStatus('Generating zero-knowledge proof...');
        
        // Complete the zkLogin flow
        await handleCallback(idToken);

        // Every effect run has read the fragment by now (the StrictMode
        // duplicate returned synchronously above); stop the JWT from
        // outliving this page on the window object.
        clearAuthCallbackFragment();
        
        // Set progress to 100% when done
        setProgress(100);
        // Clear any error tone a losing duplicate run painted first.
        setIsError(false);
        setStatus('Authentication successful! Redirecting...');

        trackFunnel('signin_completed');

        // Where to next: the landing page's "Start a circle" stores
        // /create-circle, the join page stores its own URL; both are validated
        // as same-origin before use (src/lib/post-login-redirect.ts).
        const destination = takePostLoginDestination();

        // Short delay before redirecting to show completion
        redirectTimeoutRef.current = setTimeout(() => {
          if (destination && isAppPath(destination)) {
            router.replace(destination);
          } else if (destination) {
            // Same-origin absolute URL (join page): a full navigation, as before.
            window.location.href = destination;
          } else {
            // Default redirect to dashboard
            router.replace('/dashboard');
          }
        }, 1000);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Authentication failed';
        console.warn('Auth callback error:', errorMessage);

        // Don't cry wolf: if a session actually got established (e.g. the
        // callback was loaded twice and the FIRST run already signed in and
        // consumed the one-time setup data, making THIS run throw), the user
        // is authenticated — treat it as success instead of flashing a scary
        // error and bouncing them to the landing page.
        if (
          typeof window !== 'undefined' &&
          window.localStorage.getItem('isAuthenticated') === 'true' &&
          window.localStorage.getItem('account')
        ) {
          console.log('Auth callback: session already established; treating as success');
          setProgress(100);
          setIsError(false);
          setStatus('Authentication successful! Redirecting...');
          redirectTimeoutRef.current = setTimeout(() => {
            clearAuthCallbackFragment();
            const stored = takePostLoginDestination();
            if (stored && isAppPath(stored)) {
              router.replace(stored);
            } else if (stored) {
              window.location.href = stored;
            } else {
              router.replace('/dashboard');
            }
          }, 800);
          return;
        }

        setIsError(true);
        setStatus('Authentication failed');
        setError(errorMessage);

        // Short delay before redirecting on error
        redirectAfterFailure();
      }
    };

    processCallback();
  }, [handleCallback, router, router.isReady, setError]);

  const tone = isError ? 'error' : progress >= 100 ? 'success' : 'processing';
  const pageTitle = isError
    ? 'Sign-in failed - Njangi On-Chain'
    : 'Completing sign in - Njangi On-Chain';
  const lead = isError
    ? 'We could not complete the secure sign-in handoff. The app is keeping the session clean and will send you back to the starting point shortly.'
    : 'We’re validating the provider response, generating your zero-knowledge proof, and restoring the correct destination before returning you to the app.';
  const helperText = isError
    ? 'Redirecting you back to the sign-in entry point.'
    : tone === 'success'
      ? 'Your wallet session is ready. Redirecting you now.'
      : 'Keep this tab open while the secure handoff completes.';
  const chips = ['OAuth callback', 'zkLogin proof', 'Secure redirect'];

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
        chips={chips}
      />
    </>
  );
}
