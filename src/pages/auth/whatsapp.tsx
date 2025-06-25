import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { LoginButton } from '../../components/LoginButton';
import { useAuth } from '../../contexts/AuthContext';

export default function WhatsAppAuth() {
  const router = useRouter();
  const { handleCallback } = useAuth();
  const [authState, setAuthState] = useState<{
    status: 'loading' | 'authenticating' | 'success' | 'error';
    message: string;
    token?: string;
    phone?: string;
  }>({
    status: 'loading',
    message: 'Initializing authentication...',
  });

  useEffect(() => {
    const { token, phone, error, jwt } = router.query;

    // Handle error from URL parameters
    if (error) {
      setAuthState({
        status: 'error',
        message: Array.isArray(error) ? error[0] : error,
      });
      return;
    }

    // Validate required parameters
    if (!token || !phone) {
      setAuthState({
        status: 'error',
        message: 'Missing authentication parameters. Please request a new authentication link from WhatsApp.',
      });
      return;
    }

    // Store token and phone for authentication
    const tokenStr = Array.isArray(token) ? token[0] : token;
    const phoneStr = Array.isArray(phone) ? phone[0] : phone;

    setAuthState({
      status: 'authenticating',
      message: `Preparing authentication for ${phoneStr}...`,
      token: tokenStr,
      phone: phoneStr,
    });

    // If JWT is present, complete authentication
    if (jwt) {
      completeAuthentication(tokenStr, phoneStr, Array.isArray(jwt) ? jwt[0] : jwt);
    }
  }, [router.query]);

  const completeAuthentication = async (token: string, phone: string, jwtToken: string) => {
    try {
      setAuthState(prev => ({
        ...prev,
        status: 'authenticating',
        message: 'Completing authentication...',
      }));

      // Follow the same flow as LoginButton.tsx - just call handleCallback with the JWT
      // This will process the zkLogin authentication normally
      await handleCallback(jwtToken);

      // After successful authentication, notify WhatsApp
      await fetch('/api/whatsapp/auth/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token, 
          phone, 
          success: true,
          message: 'Authentication completed successfully! You can now use all Njangi commands.' 
        }),
      }).catch(err => {
        console.warn('Failed to notify WhatsApp of auth success:', err);
      });

      setAuthState({
        status: 'success',
        message: `Authentication successful! You can now return to WhatsApp and manage your Njangi circles.`,
        token,
        phone,
      });

      // Don't auto-redirect to dashboard for WhatsApp users
      // Let them manually return to WhatsApp

    } catch (error) {
      console.error('Authentication completion failed:', error);
      
      // Notify WhatsApp of failure
      await fetch('/api/whatsapp/auth/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token, 
          phone, 
          success: false,
          message: error instanceof Error ? error.message : 'Authentication failed' 
        }),
      }).catch(err => {
        console.warn('Failed to notify WhatsApp of auth failure:', err);
      });

      setAuthState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Authentication failed',
        token,
        phone,
      });
    }
  };

  const retryAuthentication = () => {
    if (authState.token && authState.phone) {
      // Redirect to initiate new authentication
      window.location.href = `/api/whatsapp/auth/initiate?phone=${encodeURIComponent(authState.phone)}&provider=Google`;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.885 3.488"/>
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">WhatsApp Authentication</h1>
            <p className="text-gray-600">Complete your Njangi account setup</p>
          </div>

          {/* Status Content */}
          <div className="space-y-6">
            {authState.status === 'loading' && (
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-600">{authState.message}</p>
              </div>
            )}

            {authState.status === 'authenticating' && (
              <div className="text-center">
                <div className="inline-block animate-pulse rounded-full h-8 w-8 bg-blue-600 mb-4"></div>
                <p className="text-gray-600">{authState.message}</p>
                <div className="mt-4">
                  <p className="text-sm text-gray-500">This may take a few moments...</p>
                </div>
              </div>
            )}

            {authState.status === 'success' && (
              <div className="text-center">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-green-600 font-medium mb-2">Authentication Successful!</p>
                <p className="text-gray-600 text-sm mb-4">{authState.message}</p>
                
                <div className="space-y-4">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <div className="flex items-start">
                      <div className="flex-shrink-0">
                        <svg className="w-5 h-5 text-green-600 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.885 3.488"/>
                        </svg>
                      </div>
                      <div className="ml-3">
                        <p className="text-sm font-medium text-green-800">
                          Return to WhatsApp
                        </p>
                        <p className="text-sm text-green-700 mt-1">
                          You can now close this page and return to your WhatsApp conversation. 
                          A confirmation message has been sent to your chat.
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex space-x-3">
                    <button
                      onClick={() => router.push('/dashboard')}
                      className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors text-sm"
                    >
                      Go to Dashboard
                    </button>
                    <button
                      onClick={() => window.close()}
                      className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded-lg hover:bg-gray-300 transition-colors text-sm"
                    >
                      Close Tab
                    </button>
                  </div>
                </div>
              </div>
            )}

            {authState.status === 'error' && (
              <div className="text-center">
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p className="text-red-600 font-medium mb-2">Authentication Failed</p>
                <p className="text-gray-600 text-sm mb-4">{authState.message}</p>
                
                <div className="space-y-3">
                  <button
                    onClick={retryAuthentication}
                    className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Try Again
                  </button>
                  
                  <div className="text-sm text-gray-500">
                    Or authenticate with a social provider:
                  </div>
                  
                  <LoginButton />
                </div>
              </div>
            )}

            {authState.status === 'authenticating' && !router.query.jwt && (
              <div className="border rounded-lg p-4 bg-blue-50">
                <p className="text-sm text-blue-800 mb-3">
                  Please complete your authentication by signing in with one of the following providers:
                </p>
                <LoginButton />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="mt-8 pt-6 border-t border-gray-200 text-center">
            <p className="text-xs text-gray-500">
              Secure authentication powered by zkLogin
            </p>
          </div>
        </div>
      </div>
    </div>
  );
} 