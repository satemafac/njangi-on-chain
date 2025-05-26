import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';

export default function AuthCallback() {
  const router = useRouter();
  const { handleCallback, setError } = useAuth();
  const [status, setStatus] = useState('Processing authentication...');
  const [progress, setProgress] = useState(0);
  const [isError, setIsError] = useState(false);
  
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
    const processCallback = async () => {
      try {
        console.log('=== CALLBACK START ===');
        console.log('Processing authentication callback');
        console.log('Current URL:', window.location.href);
        console.log('localStorage before processing:', {
          redirectAfterLogin: localStorage.getItem('redirectAfterLogin'),
          allKeys: Object.keys(localStorage)
        });
        
        // Try to get the ID token from different places
        let idToken = null;
        let appleUserData = null;
        
        // 1. Try URL hash (fragment)
        const hash = window.location.hash.substring(1);
        const hashParams = new URLSearchParams(hash);
        idToken = hashParams.get('id_token');
        
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

        console.log('=== STARTING ZKLOGIN PROCESS ===');
        setStatus('Generating zero-knowledge proof...');
        
        // Complete the zkLogin flow
        console.log('About to call handleCallback...');
        await handleCallback(idToken);
        console.log('handleCallback completed successfully!');
        
        // Set progress to 100% when done
        setProgress(100);
        setStatus('Authentication successful! Redirecting...');
        
        console.log('=== CHECKING REDIRECT URL ===');
        // Check if there's a stored redirect URL
        const redirectUrl = localStorage.getItem('redirectAfterLogin');
        console.log('Checking for stored redirect URL after auth success:', redirectUrl);
        console.log('Current localStorage keys after auth:', Object.keys(localStorage));
        
        // Short delay before redirecting to show completion
        setTimeout(() => {
          console.log('=== STARTING REDIRECT PROCESS ===');
          if (redirectUrl) {
            console.log('Found redirect URL, processing redirect to:', redirectUrl);
            
            // Check if the redirect URL is for the same domain
            try {
              const redirectUrlObj = new URL(redirectUrl);
              const currentUrlObj = new URL(window.location.href);
              
              console.log('Redirect URL analysis:', {
                redirectOrigin: redirectUrlObj.origin,
                currentOrigin: currentUrlObj.origin,
                isSameOrigin: redirectUrlObj.origin === currentUrlObj.origin,
                redirectPath: redirectUrlObj.pathname + redirectUrlObj.search + redirectUrlObj.hash
              });
              
              if (redirectUrlObj.origin === currentUrlObj.origin) {
                // Same origin, use router.push for better navigation
                const redirectPath = redirectUrlObj.pathname + redirectUrlObj.search + redirectUrlObj.hash;
                console.log('Same origin redirect, using router.push to:', redirectPath);
                
                // Clear the stored redirect URL BEFORE navigating
                localStorage.removeItem('redirectAfterLogin');
                console.log('Cleared redirect URL from localStorage before navigation');
                
                console.log('Executing router.push...');
                router.push(redirectPath);
              } else {
                // Different origin, use window.location.href
                console.log('Different origin redirect, using window.location.href to:', redirectUrl);
                
                // Clear the stored redirect URL BEFORE navigating
                localStorage.removeItem('redirectAfterLogin');
                console.log('Cleared redirect URL from localStorage before navigation');
                
                window.location.href = redirectUrl;
              }
            } catch (error) {
              console.error('Error parsing redirect URL:', error);
              // Clear the stored redirect URL
              localStorage.removeItem('redirectAfterLogin');
              // Fallback to window.location.href
              window.location.href = redirectUrl;
            }
          } else {
            console.log('No stored redirect URL found, redirecting to dashboard');
            // Default redirect to dashboard
            router.push('/dashboard');
          }
        }, 500);
      } catch (err) {
        console.error('=== CALLBACK ERROR ===');
        console.error('Auth callback error:', err);
        setIsError(true);
        setStatus('Authentication failed');
        setError(err instanceof Error ? err.message : 'Authentication failed');
        
        // Short delay before redirecting on error
        setTimeout(() => {
          router.push('/');
        }, 2000);
      }
    };

    processCallback();
  }, [handleCallback, router, setError]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white shadow-lg rounded-lg p-8 text-center">
        {!isError ? (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent mx-auto mb-4"></div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">{status}</h2>
            <p className="text-sm text-gray-500 mb-4">This may take up to 20 seconds...</p>
            
            {/* Progress bar */}
            <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
              <div 
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-in-out"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">{status}</h2>
            <p className="text-sm text-gray-500">Redirecting to login page...</p>
          </>
        )}
      </div>
    </div>
  );
} 