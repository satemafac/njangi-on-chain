import React, { useRef, useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Instrument_Serif } from 'next/font/google';
import { useAuth } from '@/contexts/AuthContext';
import { Bell, Crown, User, Menu, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useRouter } from 'next/router';
import type { JoinRequest } from '@/services/database-service';
import LocaleSwitcher from '@/components/ui/LocaleSwitcher';

const wordmarkFont = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

// Billing kill switch (same one-line read as entitlement-gate's
// isBillingEnabled — inline so Next substitutes the build-time value in
// the client bundle). While false, no plan badge is shown at all.
const BILLING_ENABLED =
  (process.env.NEXT_PUBLIC_BILLING_ENABLED || 'false').toLowerCase() === 'true';

export const Navbar: React.FC = () => {
  const { logout, account } = useAuth();
  const router = useRouter();
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lastFetchTime, setLastFetchTime] = useState<number>(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState(false);
  const [billingPlan, setBillingPlan] = useState<'free' | 'premium' | null>(null);

  // Debounce mechanism to prevent infinite loops
  const FETCH_DEBOUNCE_MS = 5000; // 5 seconds minimum between fetches
  const MAX_RETRIES = 3;
  const retryCount = useRef(0);

  // Fetch pending requests with debounce and error handling
  const fetchPendingRequests = useCallback(async () => {
    if (!account) return;

    // Debounce: prevent too frequent calls
    const now = Date.now();
    if (now - lastFetchTime < FETCH_DEBOUNCE_MS) {
      console.log('[Navbar] Fetch debounced, too recent');
      return;
    }

    // Prevent infinite retries
    if (retryCount.current >= MAX_RETRIES) {
      console.log('[Navbar] Max retries reached, stopping fetch attempts');
      setFetchError('Max retries reached. Please refresh the page.');
      return;
    }
    
    try {
      setLoading(true);
      setFetchError(null);
      setLastFetchTime(now);
      
      console.log('[Navbar] Fetching join requests...');
      
      // Check if we're on localhost for debugging
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (isLocalhost) {
        console.log('[Navbar] Running on localhost - will use local fallback if API fails');
      }
      
      // Get only admin circles from localStorage
      const storedCircles = localStorage.getItem('adminCircles');
      let adminCircleIds: string[] = [];
      
      if (storedCircles) {
        try {
          adminCircleIds = JSON.parse(storedCircles);
        } catch (e) {
          console.error('[Navbar] Error parsing stored admin circles:', e);
        }
      }
      
      console.log('[Navbar] Admin circle IDs:', adminCircleIds);
      
      // Only fetch requests for circles where the user is an admin
      const allRequests: JoinRequest[] = [];
      
      // If we have admin circles to check, use them
      if (adminCircleIds.length > 0) {
        for (const circleId of adminCircleIds) {
          try {
            console.log(`[Navbar] Fetching requests for admin circle: ${circleId}`);
            
            // Use relative path for localhost, absolute for production
            const apiUrl = isLocalhost 
              ? `/api/join-requests/pending/${circleId}`
              : `/api/join-requests/pending/${circleId}`;
            
            const response = await fetch(apiUrl, {
              // Add timeout to prevent hanging requests
              signal: AbortSignal.timeout(10000) // 10 second timeout
            });
            
            if (!response.ok) {
              console.error(`[Navbar] Error response from API for circle ${circleId}:`, response.status, response.statusText);
              continue;
            }
            
            const data = await response.json();
            console.log(`[Navbar] API response for circle ${circleId}:`, data);
            
            if (data.success && Array.isArray(data.data)) {
              console.log(`[Navbar] Received ${data.data.length} requests for circle ${circleId}`);
              allRequests.push(...data.data);
            } else {
              console.error(`[Navbar] Invalid response format for circle ${circleId}:`, data);
            }
          } catch (error) {
            console.error(`[Navbar] Failed to fetch requests for circle ${circleId}:`, error);
            retryCount.current++;
            
            // Don't try service fallback anymore to prevent loops
            if (isLocalhost) {
              console.log(`[Navbar] Skipping service fallback to prevent loops`);
            }
          }
        }
      } 
      // Fallback approach: Try to use the circle ID from the URL ONLY if we're on a circle management page
      else if (router.pathname.includes('/circle') && router.pathname.includes('/manage') && router.query.id && typeof router.query.id === 'string') {
        const circleId = router.query.id;
        console.log(`[Navbar] Fallback: Fetching requests for circle from URL: ${circleId}`);
        try {
          const apiUrl = isLocalhost 
            ? `/api/join-requests/pending/${circleId}`
            : `/api/join-requests/pending/${circleId}`;
            
          const response = await fetch(apiUrl, {
            signal: AbortSignal.timeout(10000) // 10 second timeout
          });
          
          if (!response.ok) {
            console.error(`[Navbar] Error response from API for circle ${circleId}:`, response.status, response.statusText);
          } else {
            const data = await response.json();
            console.log(`[Navbar] API response for circle ${circleId}:`, data);
            
            if (data.success && Array.isArray(data.data)) {
              console.log(`[Navbar] Received ${data.data.length} requests for circle ${circleId}`);
              allRequests.push(...data.data);
            } else {
              console.error(`[Navbar] Invalid response format for circle ${circleId}:`, data);
            }
          }
        } catch (error) {
          console.error(`[Navbar] Failed to fetch requests for circle ${circleId}:`, error);
          retryCount.current++;
        }
      }
      
      // Sort by request date, newest first
      allRequests.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        return dateB - dateA;
      });
      
      console.log('[Navbar] Final pending requests:', allRequests);
      setPendingRequests(allRequests);
      
      // Reset retry count on successful fetch
      retryCount.current = 0;
      
    } catch (error) {
      console.error('[Navbar] Failed to fetch pending requests:', error);
      retryCount.current++;
      setFetchError('Failed to fetch notifications');
    } finally {
      setLoading(false);
    }
  }, [account, router.query.id, router.pathname, lastFetchTime]);

  // Clear all notifications
  const clearAllNotifications = useCallback(async () => {
    if (!account) return;
    
    try {
      setLoading(true);
      console.log('[Navbar] Clearing all notifications...');
      
      // Check if we're on localhost
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      
      if (isLocalhost) {
        // For localhost, call the clear API for any circle (the API will clear all)
        const response = await fetch('/api/join-requests/pending/mock-circle-1?clear=all', {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.ok) {
          console.log('[Navbar] Successfully cleared all notifications');
          setPendingRequests([]);
          setShowNotifications(false);
        } else {
          console.error('[Navbar] Failed to clear notifications');
          setFetchError('Failed to clear notifications');
        }
      } else {
        // For production, you might want to implement actual clearing logic
        console.log('[Navbar] Clear function not implemented for production');
        setFetchError('Clear function not available in production');
      }
      
    } catch (error) {
      console.error('[Navbar] Error clearing notifications:', error);
      setFetchError('Failed to clear notifications');
    } finally {
      setLoading(false);
    }
  }, [account]);

  // Reset retry count when account changes
  useEffect(() => {
    retryCount.current = 0;
    setFetchError(null);
  }, [account]);

  // Plan badge (Free/Premium) — only when billing is enabled. Resolved via
  // the session-authenticated /api/billing/status endpoint; hidden on any
  // failure (the badge is informational, server gates stay authoritative).
  useEffect(() => {
    if (!BILLING_ENABLED || !account) {
      setBillingPlan(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/billing/status', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled && body?.success) {
          setBillingPlan(body.data?.plan === 'premium' ? 'premium' : 'free');
        }
      } catch {
        /* keep badge hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    // Only fetch if we have an account and haven't hit max retries
    if (account && retryCount.current < MAX_RETRIES) {
      fetchPendingRequests();
      
      // Set up interval to fetch pending requests every 60 seconds (instead of every minute to reduce load)
      const interval = setInterval(() => {
        if (retryCount.current < MAX_RETRIES) {
          fetchPendingRequests();
        }
      }, 60000);
      
      return () => clearInterval(interval);
    }
  }, [fetchPendingRequests, account]);

  // Handle clicking outside notifications panel
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Close mobile menu when route changes
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [router.pathname]);

  return (
    <nav className="sticky top-0 z-40 border-b border-stone-200/80 bg-[#f6f3ee]/90 backdrop-blur-xl">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-[60px] items-center justify-between gap-4 sm:h-16">
          <div className="flex min-w-0 items-center">
            <Link href="/dashboard" className="group flex min-w-0 items-center gap-2.5 sm:gap-3">
              {!logoError ? (
                <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-stone-200 bg-white shadow-[0_12px_30px_-22px_rgba(15,23,42,0.42)] sm:h-10 sm:w-10">
                  <Image
                    src="/njangi-on-chain-logo.png"
                    alt="Njangi On-Chain"
                    width={80}
                    height={80}
                    className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105"
                    priority
                    unoptimized
                    onError={(e) => {
                      console.error('Logo failed to load:', e);
                      setLogoError(true);
                    }}
                    onLoad={() => {
                      console.log('Logo loaded successfully');
                    }}
                  />
                </div>
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-stone-100 sm:h-10 sm:w-10">
                  <span className={`${wordmarkFont.className} text-xs text-slate-700 sm:text-sm`}>N</span>
                </div>
              )}
              <div className="min-w-0 pb-0.5">
                <span
                  className={`${wordmarkFont.className} block truncate text-[1.32rem] leading-[0.86] tracking-[-0.05em] text-slate-950 sm:text-[1.58rem]`}
                >
                  Njangi
                </span>
                <span className="mt-0.5 block truncate text-[10px] font-semibold uppercase tracking-[0.34em] text-slate-500 sm:text-[11px]">
                  On-chain
                </span>
              </div>
            </Link>
          </div>

          {account && (
            <div className="flex items-center gap-2 md:hidden">
              <LocaleSwitcher compact />
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-white text-slate-600 transition hover:border-stone-300 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2"
              >
                <span className="sr-only">{mobileMenuOpen ? 'Close menu' : 'Open menu'}</span>
                {mobileMenuOpen ? (
                  <X className="block h-5 w-5" aria-hidden="true" />
                ) : (
                  <Menu className="block h-5 w-5" aria-hidden="true" />
                )}
              </button>
            </div>
          )}

          {account && (
            <div className="hidden items-center gap-3 md:flex">
              {billingPlan && (
                <Link
                  href="/pricing"
                  title={
                    billingPlan === 'premium'
                      ? 'Premium plan — manage your subscription'
                      : 'Free plan — see Premium features'
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-semibold transition ${
                    billingPlan === 'premium'
                      ? 'border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300 hover:bg-amber-100'
                      : 'border-stone-200 bg-white text-slate-600 hover:border-stone-300 hover:bg-stone-50'
                  }`}
                >
                  {billingPlan === 'premium' && (
                    <Crown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {billingPlan === 'premium' ? 'Premium' : 'Free plan'}
                </Link>
              )}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-stone-200 bg-white transition hover:border-stone-300 hover:bg-stone-50"
                      onClick={() => router.push('/dashboard')}
                    >
                      {account.picture ? (
                        <Image
                          src={account.picture}
                          alt="Profile"
                          width={40}
                          height={40}
                          className="h-full w-full object-cover"
                          priority={true}
                          onError={() => {
                            console.error('Error loading profile picture');
                          }}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-stone-100">
                          <User className="h-4 w-4 text-slate-600" />
                        </div>
                      )}
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="rounded bg-gray-800 px-2 py-1 text-xs text-white"
                      sideOffset={5}
                    >
                      {account.name || 'My Profile'}
                      <Tooltip.Arrow className="fill-gray-800" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>

              <LocaleSwitcher />

              <div className="relative" ref={notificationsRef}>
                <button
                  onClick={() => setShowNotifications(!showNotifications)}
                  className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-white text-slate-600 transition hover:border-stone-300 hover:bg-stone-50"
                >
                  <Bell className={`h-5 w-5 ${loading ? 'animate-pulse' : ''}`} />
                  {pendingRequests.length > 0 && (
                    <span className="absolute right-0 top-0 inline-flex h-5 min-w-[1.25rem] -translate-y-1/3 translate-x-1/4 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold leading-none text-white">
                      {pendingRequests.length}
                    </span>
                  )}
                </button>

                {showNotifications && (
                  <div className="absolute right-0 z-50 mt-3 w-80 overflow-hidden rounded-[24px] border border-stone-200 bg-white shadow-[0_24px_60px_-32px_rgba(15,23,42,0.35)] sm:w-96">
                    <div className="flex items-center justify-between border-b border-stone-200 px-4 py-4">
                      <div>
                        <h3 className="text-base font-semibold text-slate-950">Notifications</h3>
                        <p className="text-xs text-slate-500 sm:text-sm">Join requests for your circles</p>
                      </div>
                      <div className="flex items-center gap-1">
                        {pendingRequests.length > 0 && (
                          <button
                            onClick={clearAllNotifications}
                            disabled={loading}
                            className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                              loading
                                ? 'text-stone-300'
                                : 'text-red-500 hover:bg-red-50 hover:text-red-600'
                            }`}
                            title="Clear all notifications"
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1H8a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                        <button
                          onClick={() => fetchPendingRequests()}
                          disabled={loading}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                            loading
                              ? 'text-stone-300'
                              : 'text-slate-500 hover:bg-stone-100 hover:text-slate-700'
                          }`}
                          title="Refresh notifications"
                        >
                          <svg
                            className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                      {loading ? (
                        <div className="p-5 text-center text-slate-500">
                          <svg className="mx-auto mb-2 h-5 w-5 animate-spin text-slate-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span className="text-sm">Loading notifications...</span>
                        </div>
                      ) : fetchError ? (
                        <div className="p-5 text-center text-red-500">
                          <div className="text-sm">{fetchError}</div>
                          <button
                            onClick={() => {
                              retryCount.current = 0;
                              setFetchError(null);
                              fetchPendingRequests();
                            }}
                            className="mt-3 inline-flex items-center justify-center rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
                          >
                            Retry
                          </button>
                        </div>
                      ) : pendingRequests.length > 0 ? (
                        <div className="divide-y divide-stone-200">
                          {pendingRequests.map((request) => (
                            <div
                              key={`${request.circle_id}-${request.user_address}`}
                              className="cursor-pointer p-4 transition-colors hover:bg-stone-50"
                              onClick={() => {
                                router.push(`/circle/${request.circle_id}`);
                                setShowNotifications(false);
                              }}
                            >
                              <div className="flex items-start">
                                <div className="flex h-11 w-11 items-center justify-center rounded-full border border-stone-200 bg-stone-50">
                                  <Image
                                    src="/njangi-on-chain-logo.png"
                                    alt="Circle Logo"
                                    width={48}
                                    height={48}
                                    className="h-8 w-8 object-contain"
                                  />
                                </div>
                                <div className="ml-3">
                                  <p className="text-xs font-medium text-slate-900 sm:text-sm">
                                    <span className="font-semibold text-slate-950">{request.user_name}</span> wants to join
                                    <span className="font-semibold text-slate-700"> {request.circle_name}</span>
                                  </p>
                                  <div className="mt-2 text-xs text-slate-500">
                                    {new Date(request.created_at || 0).toLocaleDateString('en-US', {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric',
                                    })}
                                  </div>

                                  <div className="mt-3 flex">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        router.push(`/circle/${request.circle_id}/manage`);
                                        setShowNotifications(false);
                                      }}
                                      className="inline-flex items-center justify-center rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-stone-300 hover:bg-stone-100"
                                    >
                                      Review
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-5 text-center text-xs text-slate-500 sm:text-sm">
                          No pending join requests
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={logout}
                      className="inline-flex items-center justify-center rounded-full border border-stone-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-stone-300 hover:bg-stone-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2"
                    >
                      <svg
                        className="mr-2 h-4 w-4 text-slate-400 transition-colors"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                        />
                      </svg>
                      Sign Out
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="rounded bg-gray-800 px-2 py-1 text-xs text-white"
                      sideOffset={5}
                    >
                      Sign out of your account
                      <Tooltip.Arrow className="fill-gray-800" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            </div>
          )}
        </div>

        {mobileMenuOpen && account && (
          <div className="border-t border-stone-200/80 pb-4 pt-3 md:hidden">
            <div className="space-y-2">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-[20px] border border-stone-200 bg-white px-4 py-3 text-left shadow-[0_14px_30px_-28px_rgba(15,23,42,0.35)] transition hover:bg-stone-50"
                onClick={() => {
                  router.push('/dashboard');
                  setMobileMenuOpen(false);
                }}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-stone-200 bg-stone-100">
                  {account.picture ? (
                    <Image
                      src={account.picture}
                      alt="Profile"
                      width={40}
                      height={40}
                      className="h-full w-full object-cover"
                      priority={true}
                    />
                  ) : (
                    <User className="h-4 w-4 text-slate-600" />
                  )}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-slate-950">{account.name || 'My Account'}</span>
                  <span className="text-xs text-slate-500">View dashboard</span>
                </div>
              </button>

              <button
                type="button"
                className="flex w-full items-center justify-between rounded-[20px] border border-stone-200 bg-white px-4 py-3 text-left shadow-[0_14px_30px_-28px_rgba(15,23,42,0.35)] transition hover:bg-stone-50"
                onClick={(e) => {
                  e.preventDefault();
                  if (pendingRequests.length > 0) {
                    router.push(`/circle/${pendingRequests[0].circle_id}/manage`);
                    setMobileMenuOpen(false);
                  }
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-stone-200 bg-stone-100">
                    <Bell className="h-4 w-4 text-slate-600" />
                    {pendingRequests.length > 0 && (
                      <span className="absolute right-0 top-0 flex h-4 w-4 translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                        {pendingRequests.length}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-medium text-slate-950">Notifications</span>
                </div>
                <span className="text-xs font-medium text-slate-500">
                  {pendingRequests.length ? `${pendingRequests.length} new` : 'None'}
                </span>
              </button>

              {billingPlan && (
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-[20px] border border-stone-200 bg-white px-4 py-3 text-left shadow-[0_14px_30px_-28px_rgba(15,23,42,0.35)] transition hover:bg-stone-50"
                  onClick={() => {
                    router.push('/pricing');
                    setMobileMenuOpen(false);
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-stone-200 bg-stone-100">
                      <Crown
                        className={`h-4 w-4 ${
                          billingPlan === 'premium' ? 'text-amber-600' : 'text-slate-600'
                        }`}
                      />
                    </div>
                    <span className="text-sm font-medium text-slate-950">Your plan</span>
                  </div>
                  <span
                    className={`text-xs font-semibold ${
                      billingPlan === 'premium' ? 'text-amber-700' : 'text-slate-500'
                    }`}
                  >
                    {billingPlan === 'premium' ? 'Premium' : 'Free'}
                  </span>
                </button>
              )}

              <button
                onClick={logout}
                className="inline-flex w-full items-center rounded-[20px] border border-stone-200 bg-white px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-stone-50 hover:text-red-600"
              >
                <svg
                  className="mr-3 h-4 w-4 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                Sign Out
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}; 
