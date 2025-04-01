import React, { useEffect, ReactNode, useRef, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';

interface ActivityDetectorProps {
  children: ReactNode;
}

// Throttle time in milliseconds to avoid resetting the timer too often
const THROTTLE_TIME = 30000; // 30 seconds

export function ActivityDetector({ children }: ActivityDetectorProps) {
  const { isAuthenticated, resetIdleTimer } = useAuth();
  const lastResetTimeRef = useRef<number>(Date.now());
  
  // Throttled reset function
  const throttledResetTimer = useCallback(() => {
    const now = Date.now();
    const timeSinceLastReset = now - lastResetTimeRef.current;
    
    // Only reset if enough time has passed since the last reset
    if (timeSinceLastReset >= THROTTLE_TIME) {
      console.log('Activity detected, resetting idle timer');
      resetIdleTimer();
      lastResetTimeRef.current = now;
    }
  }, [resetIdleTimer]);
  
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    // Initial reset when component mounts and user is authenticated
    resetIdleTimer();
    lastResetTimeRef.current = Date.now();
    console.log('ActivityDetector initialized and idle timer reset');
    
    // Add event listeners to detect user activity
    events.forEach(event => {
      window.addEventListener(event, throttledResetTimer);
    });
    
    // Cleanup function
    return () => {
      events.forEach(event => {
        window.removeEventListener(event, throttledResetTimer);
      });
    };
  }, [isAuthenticated, throttledResetTimer, resetIdleTimer]);
  
  return <>{children}</>;
} 