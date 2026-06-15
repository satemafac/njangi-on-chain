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
    if (!router.isReady) {
      return;
    }

    if (hasProcessedCallbackRef.current) {
      return;
    }

    hasProcessedCallbackRef.current = true;

    const processCallback = async () => {
      try {
        console.log('Processing authentication callback');
        
        // Try to get the ID token from different places
        let idToken = null;
        let appleUserData = null;
        
        // 1. Try URL hash (fragment)
        const hash = window.location.hash.substring(1);
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
          setIsError(true);
          setStatus('Authentication failed');
          setError('No ID token found in callback URL. Check the OAuth redirect configuration and try again.');
          redirectTimeoutRef.current = setTimeout(() => {
            router.replace('/');
          }, 2000);
          return;
        }

        setStatus('Generating zero-knowledge proof...');
        
        // Complete the zkLogin flow
        await handleCallback(idToken);
        
        // Set progress to 100% when done
        setProgress(100);
        setStatus('Authentication successful! Redirecting...');
        
        // Check if this is a WhatsApp authentication
        const whatsappToken = localStorage.getItem('whatsappAuthToken');
        const whatsappPhone = localStorage.getItem('whatsappAuthPhone');
        
        if (whatsappToken && whatsappPhone) {
          // This is a WhatsApp authentication - notify WhatsApp of success
          try {
            // Ensure phone number has + prefix for international format
            const formattedPhone = whatsappPhone.startsWith('+') ? whatsappPhone : `+${whatsappPhone}`;
            
            await fetch('/api/whatsapp/auth/notify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                token: whatsappToken, 
                phone: formattedPhone, 
                success: true,
                message: 'Authentication completed successfully! You can now use all Njangi On-Chain commands.'
              }),
            });
            
            // Clear WhatsApp auth data
            localStorage.removeItem('whatsappAuthToken');
            localStorage.removeItem('whatsappAuthPhone');
            
            setStatus('Success! You can now return to WhatsApp.');
            
            // Don't auto-redirect for WhatsApp users - let them manually return
            return;
          } catch (error) {
            console.warn('Failed to notify WhatsApp of auth success:', error);
          }
        }
        
        // Check if there's a stored redirect URL for non-WhatsApp users
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
        }, 1000);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Authentication failed';
        console.warn('Auth callback error:', errorMessage);
        setIsError(true);
        setStatus('Authentication failed');
        setError(errorMessage);
        
        // Check if this is a WhatsApp authentication failure
        const whatsappToken = localStorage.getItem('whatsappAuthToken');
        const whatsappPhone = localStorage.getItem('whatsappAuthPhone');
        
        if (whatsappToken && whatsappPhone) {
          // Notify WhatsApp of failure
          try {
            // Ensure phone number has + prefix for international format
            const formattedPhone = whatsappPhone.startsWith('+') ? whatsappPhone : `+${whatsappPhone}`;
            
            await fetch('/api/whatsapp/auth/notify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                token: whatsappToken, 
                phone: formattedPhone, 
                success: false,
                message: errorMessage 
              }),
            });
          } catch (notifyError) {
            console.warn('Failed to notify WhatsApp of auth failure:', notifyError);
          }
          
          // Clear WhatsApp auth data
          localStorage.removeItem('whatsappAuthToken');
          localStorage.removeItem('whatsappAuthPhone');
        }
        
        // Short delay before redirecting on error
        redirectTimeoutRef.current = setTimeout(() => {
          router.replace('/');
        }, 2000);
      }
    };

    processCallback();
  }, [handleCallback, router, router.isReady, setError]);

  const tone = isError ? 'error' : progress >= 100 ? 'success' : 'processing';
  const isWhatsAppReady = !isError && status.includes('return to WhatsApp');
  const pageTitle = isError
    ? 'Sign-in failed - Njangi On-Chain'
    : 'Completing sign in - Njangi On-Chain';
  const lead = isError
    ? 'We could not complete the secure sign-in handoff. The app is keeping the session clean and will send you back to the starting point shortly.'
    : isWhatsAppReady
      ? 'Your wallet session is ready. Return to WhatsApp and continue using Njangi On-Chain commands there.'
      : 'We’re validating the provider response, generating your zero-knowledge proof, and restoring the correct destination before returning you to the app.';
  const helperText = isError
    ? 'Redirecting you back to the sign-in entry point.'
    : isWhatsAppReady
      ? 'You can switch back to WhatsApp once you are ready.'
      : tone === 'success'
        ? 'Your wallet session is ready. Redirecting you now.'
        : 'Keep this tab open while the secure handoff completes.';
  const chips = isWhatsAppReady
    ? ['WhatsApp handoff', 'zkLogin proof', 'Wallet ready']
    : ['OAuth callback', 'zkLogin proof', 'Secure redirect'];

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
