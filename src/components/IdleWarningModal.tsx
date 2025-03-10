import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

// Warning will show 1 minute before auto-logout
const WARNING_TIME = 14 * 60 * 1000; // 14 minutes in milliseconds
const COUNTDOWN_INTERVAL = 1000; // 1 second

export function IdleWarningModal() {
  const [showModal, setShowModal] = useState(false);
  const [countdown, setCountdown] = useState(60); // 60 seconds countdown
  const { isAuthenticated, logout, resetIdleTimer } = useAuth();
  
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const warningTimeout = setTimeout(() => {
      setShowModal(true);
      
      // Start countdown
      let secondsLeft = 60;
      setCountdown(secondsLeft);
      
      const countdownInterval = setInterval(() => {
        secondsLeft -= 1;
        setCountdown(secondsLeft);
        
        // If countdown reaches 0, log the user out
        if (secondsLeft <= 0) {
          clearInterval(countdownInterval);
          logout();
        }
      }, COUNTDOWN_INTERVAL);
      
      // Cleanup countdown interval when component unmounts
      return () => clearInterval(countdownInterval);
    }, WARNING_TIME);
    
    // Cleanup warning timeout
    return () => {
      clearTimeout(warningTimeout);
    };
  }, [isAuthenticated, logout]);
  
  const handleContinueSession = () => {
    resetIdleTimer();
    setShowModal(false);
  };
  
  if (!showModal) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-96 bg-white rounded-lg shadow-lg p-6">
        <h3 className="text-xl font-semibold mb-4">Session Timeout Warning</h3>
        <p className="mb-4">
          Your session is about to expire due to inactivity. You will be automatically logged out in {countdown} seconds.
        </p>
        <div className="flex justify-end">
          <button 
            onClick={handleContinueSession}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Continue Session
          </button>
        </div>
      </div>
    </div>
  );
} 