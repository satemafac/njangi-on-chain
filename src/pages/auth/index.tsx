import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { LoginButton } from '../../components/LoginButton';
import { useAuth } from '../../contexts/AuthContext';

export default function AuthPage() {
  const router = useRouter();
  const { isAuthenticated, account } = useAuth();
  const [whatsappPhone, setWhatsappPhone] = useState<string | null>(null);
  const [authState, setAuthState] = useState<{
    status: 'loading' | 'needLogin' | 'authenticated' | 'redirecting';
    message: string;
  }>({
    status: 'loading',
    message: 'Checking authentication status...',
  });

  useEffect(() => {
    const { whatsapp_phone } = router.query;
    
    if (whatsapp_phone) {
      const phoneStr = Array.isArray(whatsapp_phone) ? whatsapp_phone[0] : whatsapp_phone;
      setWhatsappPhone(phoneStr);
      
      // Store phone for later use in callback
      sessionStorage.setItem('whatsapp_phone', phoneStr);
    }

    if (isAuthenticated && account) {
      setAuthState({
        status: 'authenticated',
        message: 'You are already authenticated!',
      });
    } else {
      setAuthState({
        status: 'needLogin',
        message: whatsapp_phone 
          ? `Please authenticate your account for WhatsApp (${whatsapp_phone})`
          : 'Please authenticate your account',
      });
    }
  }, [router.query, isAuthenticated, account]);

  // Handle successful authentication
  useEffect(() => {
    if (isAuthenticated && account) {
      setAuthState({
        status: 'redirecting',
        message: 'Authentication successful! Sending confirmation...',
      });

      // If this was a WhatsApp auth flow, send notification
      const phoneFromSession = sessionStorage.getItem('whatsapp_phone');
      const phoneFromUrl = whatsappPhone;
      const phone = phoneFromUrl || phoneFromSession;

      if (phone) {
        // Send notification to WhatsApp
        fetch('/api/whatsapp/auth/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            token: 'direct-auth', // Simple token since we're not using complex auth bridge
            phone, 
            success: true,
            message: 'Authentication completed successfully! You can now use all Njangi commands.' 
          }),
        }).then(() => {
          // Clear the session storage
          sessionStorage.removeItem('whatsapp_phone');
          
          // Redirect to a success page or dashboard after a delay
          setTimeout(() => {
            router.push('/dashboard');
          }, 3000);
        }).catch(err => {
          console.error('Failed to notify WhatsApp:', err);
          // Still redirect to dashboard even if notification fails
          setTimeout(() => {
            router.push('/dashboard');
          }, 3000);
        });
      } else {
        // Regular auth flow, just redirect to dashboard
        setTimeout(() => {
          router.push('/dashboard');
        }, 2000);
      }
    }
  }, [isAuthenticated, account, whatsappPhone, router]);

  if (authState.status === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-gray-600">{authState.message}</p>
        </div>
      </div>
    );
  }

  if (authState.status === 'authenticated' || authState.status === 'redirecting') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Authentication Successful!</h1>
            <p className="text-gray-600 mb-6">{authState.message}</p>
            
            {whatsappPhone && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <p className="text-sm text-green-800">
                  A confirmation message has been sent to your WhatsApp ({whatsappPhone}).
                  You can now close this page and return to WhatsApp to use all Njangi commands.
                </p>
              </div>
            )}
            
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
                Close Page
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              {whatsappPhone ? (
                <svg className="w-8 h-8 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.885 3.488"/>
                </svg>
              ) : (
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              )}
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {whatsappPhone ? 'WhatsApp Authentication' : 'Account Authentication'}
            </h1>
            <p className="text-gray-600">{authState.message}</p>
          </div>

          {/* Login Section */}
          <div className="space-y-6">
            {whatsappPhone && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <p className="text-sm text-green-800">
                  Authenticating for WhatsApp number: <strong>{whatsappPhone}</strong>
                </p>
                <p className="text-sm text-green-700 mt-1">
                  After logging in, you&apos;ll receive a confirmation in your WhatsApp chat.
                </p>
              </div>
            )}
            
            <div className="text-center">
              <p className="text-gray-600 mb-4">Choose your preferred login method:</p>
              <LoginButton />
            </div>
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