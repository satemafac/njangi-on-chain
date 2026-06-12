import { useEffect, useRef } from 'react';

// Default timeout of 15 minutes (in milliseconds)
const DEFAULT_IDLE_TIMEOUT = 15 * 60 * 1000;

interface IdleTimerOptions {
  onIdle: () => void;
  idleTime?: number;
  events?: string[];
}

export function useIdleTimer({
  onIdle,
  idleTime = DEFAULT_IDLE_TIMEOUT,
  events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click']
}: IdleTimerOptions) {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const resetTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(onIdle, idleTime);
  };

  useEffect(() => {
    // Setup event listeners
    const handleActivity = () => {
      resetTimer();
    };

    // Add event listeners for all specified events
    events.forEach(event => {
      window.addEventListener(event, handleActivity);
    });

    // Initialize timer
    resetTimer();

    // Cleanup function
    return () => {
      // Remove all event listeners
      events.forEach(event => {
        window.removeEventListener(event, handleActivity);
      });
      
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
    // `resetTimer` is recreated on every render; including it would
    // re-attach the event listeners continuously. It's safe to skip
    // because the handler closes over the same `idleTime` / `onIdle`
    // we already track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleTime, onIdle, events]);

  return {
    resetTimer
  };
} 