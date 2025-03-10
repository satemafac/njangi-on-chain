import React, { useEffect, ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';

interface ActivityDetectorProps {
  children: ReactNode;
}

export function ActivityDetector({ children }: ActivityDetectorProps) {
  const { isAuthenticated, resetIdleTimer } = useAuth();
  
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    const handleUserActivity = () => {
      resetIdleTimer();
    };
    
    // Add event listeners to detect user activity
    events.forEach(event => {
      window.addEventListener(event, handleUserActivity);
    });
    
    // Cleanup function
    return () => {
      events.forEach(event => {
        window.removeEventListener(event, handleUserActivity);
      });
    };
  }, [isAuthenticated, resetIdleTimer]);
  
  return <>{children}</>;
} 