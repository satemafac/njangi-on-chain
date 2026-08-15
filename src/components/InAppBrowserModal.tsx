import React, { useState } from 'react';

interface InAppBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  browserName: string;
  provider: string;
}

/**
 * Prompts the user to leave an in-app webview (Instagram, Facebook, …) and
 * finish signing in from a real browser.
 *
 * This deliberately hands off a link to OUR OWN app, not a pre-generated OAuth
 * URL. The OAuth nonce is bound to an ephemeral key that lives in the
 * originating context's sessionStorage; sending the user to that URL in a
 * different browser would leave the key stranded in the webview and the login
 * could never complete. The destination browser must run `beginLogin` itself,
 * so it mints its own key.
 *
 * Do not reintroduce a `loginUrl` prop.
 */
export function InAppBrowserModal({
  isOpen,
  onClose,
  browserName,
  provider,
}: InAppBrowserModalProps) {
  const [copyFeedback, setCopyFeedback] = useState(false);

  if (!isOpen) return null;

  // Land on the app itself; the user taps sign-in again in the real browser,
  // which starts a fresh login in that context.
  const handoffUrl =
    typeof window !== 'undefined' ? window.location.origin : '';

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(handoffUrl);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (error) {
      console.error('Failed to copy URL:', error);
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = handoffUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  };

  const handleOpenInBrowser = () => {
    const userAgent = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(userAgent);
    const isAndroid = /Android/.test(userAgent);
    
    try {
      if (isIOS) {
        // iOS: Try multiple approaches
        if (userAgent.includes('Instagram')) {
          // For Instagram on iOS, try to trigger the "Open in Safari" prompt
          // Create a link that might trigger the browser selector
          const link = document.createElement('a');
          link.href = handoffUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          
          // Try to trigger a right-click context menu that shows "Open in Safari"
          const event = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0
          });
          
          document.body.appendChild(link);
          link.dispatchEvent(event);
          document.body.removeChild(link);
        } else {
          // Fallback for other iOS browsers
          window.open(handoffUrl, '_blank');
        }
      } else if (isAndroid) {
        // Android: Use intent URLs to force external browser
        if (userAgent.includes('Instagram')) {
          // Try Chrome intent first
          window.location.href = `intent://${handoffUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(handoffUrl)};end`;
        } else {
          // Generic Android intent
          window.location.href = `intent://${handoffUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;action=android.intent.action.VIEW;end`;
        }
      } else {
        // Desktop or other platforms
        window.open(handoffUrl, '_blank');
      }
    } catch (error) {
      console.error('Failed to open in browser:', error);
      // If all else fails, copy to clipboard
      handleCopyUrl();
    }
  };

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center mb-4">
          <div className="flex-shrink-0">
            <svg className="h-8 w-8 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="ml-3 text-lg font-medium text-gray-900">
            Open in Browser Required
          </h3>
        </div>
        
        <p className="text-gray-600 mb-6">
          {provider} doesn&apos;t allow login from {browserName}&apos;s browser for security reasons. 
          Please use your default browser to continue:
        </p>
        
        <div className="space-y-4">
          {/* Copy URL Button - Make this the primary action */}
          <button
            onClick={handleCopyUrl}
            className={`w-full px-4 py-3 rounded-lg font-medium transition-all duration-200 text-lg ${
              copyFeedback 
                ? 'bg-green-600 text-white' 
                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg'
            }`}
          >
            {copyFeedback ? '✓ Copied to Clipboard!' : '📋 Copy App Link'}
          </button>
          
          {/* Platform-specific instructions */}
          <div className="text-sm bg-blue-50 p-4 rounded-lg border-l-4 border-blue-400">
            {isIOS && (
              <div>
                <p className="font-medium text-blue-800 mb-2">📱 iOS Instructions:</p>
                <ol className="list-decimal list-inside space-y-1 text-blue-700">
                  <li>Tap &quot;Copy App Link&quot; above</li>
                  <li>Press your home button or swipe up</li>
                  <li>Open Safari (or your preferred browser)</li>
                  <li>Tap the address bar and paste the link</li>
                  <li>Tap Sign in with {provider} again there</li>
                </ol>
              </div>
            )}
            {isAndroid && (
              <div>
                <p className="font-medium text-blue-800 mb-2">🤖 Android Instructions:</p>
                <ol className="list-decimal list-inside space-y-1 text-blue-700">
                  <li>Tap &quot;Copy App Link&quot; above</li>
                  <li>Open Chrome or your default browser</li>
                  <li>Paste the link in the address bar</li>
                  <li>Tap Sign in with {provider} again there</li>
                </ol>
                <p className="mt-2 text-xs text-blue-600">Or try the &quot;Try Opening in Browser&quot; button below</p>
              </div>
            )}
            {!isIOS && !isAndroid && (
              <div>
                <p className="font-medium text-blue-800 mb-2">💻 Instructions:</p>
                <ol className="list-decimal list-inside space-y-1 text-blue-700">
                  <li>Copy the app link above</li>
                  <li>Open your default browser</li>
                  <li>Paste and visit the link</li>
                  <li>Tap Sign in with {provider} again there</li>
                </ol>
              </div>
            )}
          </div>
          
          {/* Try Open in Browser Button - Secondary action */}
          <button
            onClick={handleOpenInBrowser}
            className="w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors border border-gray-300"
          >
            {isAndroid ? '🔗 Try Opening in Browser' : '🔗 Attempt External Open'}
          </button>
          
          {/* Share/Send to yourself option for mobile */}
          {(isIOS || isAndroid) && navigator.share && (
            <button
              onClick={() => {
                if (navigator.share) {
                  navigator.share({
                    title: `Sign in with ${provider}`,
                    text: `Open this in your browser, then tap Sign in with ${provider}:`,
                    url: handoffUrl
                  }).catch(err => {
                    console.log('Share failed:', err);
                    // Fallback to copy
                    handleCopyUrl();
                  });
                }
              }}
              className="w-full px-4 py-2 bg-purple-100 hover:bg-purple-200 text-purple-700 rounded-lg font-medium transition-colors border border-purple-300"
            >
              📤 Share Login Link
            </button>
          )}
          
          {/* Success message */}
          <div className="text-xs text-gray-500 bg-green-50 p-3 rounded-lg">
            <p className="font-medium text-green-800">✨ After completing login:</p>
            <p className="text-green-700">You&apos;ll be automatically redirected back to this app!</p>
          </div>
        </div>
        
        <button
          onClick={onClose}
          className="mt-6 w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
} 