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
        console.log('Processing authentication callback');
        
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

        setStatus('Generating zero-knowledge proof...');
        
        // Complete the zkLogin flow
        await handleCallback(idToken);
        
        // Set progress to 100% when done
        setProgress(100);
        setStatus('Authentication successful! Redirecting...');
        
        // Short delay before redirecting to show completion
        setTimeout(() => {
          router.push('/dashboard');
        }, 500);
      } catch (err) {
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