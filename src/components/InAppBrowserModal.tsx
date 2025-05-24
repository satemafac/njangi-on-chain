import React, { useState } from 'react';

interface InAppBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  loginUrl: string;
  browserName: string;
  provider: string;
}

export function InAppBrowserModal({ 
  isOpen, 
  onClose, 
  loginUrl, 
  browserName, 
  provider 
}: InAppBrowserModalProps) {
  const [copyFeedback, setCopyFeedback] = useState(false);

  if (!isOpen) return null;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (error) {
      console.error('Failed to copy URL:', error);
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = loginUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  };

  const handleOpenInBrowser = () => {
    // Try multiple methods to open in default browser
    const userAgent = navigator.userAgent;
    
    if (userAgent.includes('Instagram')) {
      // Instagram specific - try intent URL for Android
      if (userAgent.includes('Android')) {
        window.location.href = `intent://${loginUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
      } else {
        window.open(loginUrl, '_blank');
      }
    } else {
      window.open(loginUrl, '_blank');
    }
  };

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
          To continue, please open this link in your default browser:
        </p>
        
        <div className="space-y-4">
          {/* Copy URL Button */}
          <button
            onClick={handleCopyUrl}
            className={`w-full px-4 py-2 rounded-lg font-medium transition-all duration-200 ${
              copyFeedback 
                ? 'bg-green-600 text-white' 
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {copyFeedback ? '✓ Copied!' : 'Copy Login Link'}
          </button>
          
          {/* Open in Browser Button */}
          <button
            onClick={handleOpenInBrowser}
            className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
          >
            Open in Browser
          </button>
          
          {/* Instructions */}
          <div className="text-sm text-gray-500 bg-gray-50 p-3 rounded-lg">
            <p className="font-medium mb-2">📱 Step-by-step:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Tap &quot;Copy Login Link&quot; above</li>
              <li>Open Safari, Chrome, or your default browser</li>
              <li>Paste the link in the address bar</li>
              <li>Complete {provider} login</li>
              <li>You&apos;ll be redirected back automatically</li>
            </ol>
          </div>
          
          {/* Alternative method for iOS */}
          {navigator.userAgent.includes('iPhone') && (
            <div className="text-xs text-gray-400 bg-blue-50 p-2 rounded border-l-4 border-blue-400">
              <p className="font-medium text-blue-800">iOS tip:</p>
              <p className="text-blue-700">
                You can also tap and hold the &quot;Open in Browser&quot; button and select &quot;Open in Safari&quot;
              </p>
            </div>
          )}
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