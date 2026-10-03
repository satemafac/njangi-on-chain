import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { LoginButton } from '../../components/LoginButton';
import { useAuth } from '../../contexts/AuthContext';
import { LocaleSwitcher } from '../../components/ui/LocaleSwitcher';
import { useTranslation } from '../../hooks/useTranslation';

export default function AuthPage() {
  const router = useRouter();
  const { isAuthenticated, account } = useAuth();
  const { t } = useTranslation();
  const [authState, setAuthState] = useState<{
    status: 'loading' | 'needLogin' | 'authenticated' | 'redirecting';
    message: string;
  }>({
    status: 'loading',
    message: 'Checking authentication status...',
  });

  useEffect(() => {
    if (isAuthenticated && account) {
      setAuthState({
        status: 'authenticated',
        message: t('auth.alreadyAuthenticated'),
      });
    } else {
      setAuthState({
        status: 'needLogin',
        message: t('auth.pleaseAuthenticate'),
      });
    }
  }, [isAuthenticated, account, t]);

  // Handle successful authentication
  useEffect(() => {
    if (isAuthenticated && account) {
      setAuthState({
        status: 'redirecting',
        message: t('auth.redirecting'),
      });

      setTimeout(() => {
        router.push('/dashboard');
      }, 2000);
    }
  }, [isAuthenticated, account, router, t]);

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
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{t('auth.successTitle')}</h1>
            <p className="text-gray-600 mb-6">{authState.message}</p>

            <div className="flex space-x-3">
              <button
                onClick={() => router.push('/dashboard')}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors text-sm"
              >
                {t('auth.goToDashboard')}
              </button>
              <button
                onClick={() => window.close()}
                className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded-lg hover:bg-gray-300 transition-colors text-sm"
              >
                {t('auth.closePage')}
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
        <div className="mb-4 flex justify-end">
          <LocaleSwitcher compact />
        </div>
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {t('auth.title')}
            </h1>
            <p className="text-gray-600">{authState.message}</p>
          </div>

          {/* Login Section */}
          <div className="space-y-6">
            <div className="text-center">
              <p className="text-gray-600 mb-4">{t('auth.chooseMethod')}</p>
              <LoginButton />
            </div>
          </div>

          {/* Footer */}
          <div className="mt-8 pt-6 border-t border-gray-200 text-center">
            <p className="text-xs text-gray-500">
              {t('auth.poweredByZkLogin')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}