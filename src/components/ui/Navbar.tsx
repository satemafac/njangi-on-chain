import React, { useRef, useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { Bell, User, Menu, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useRouter } from 'next/router';
import type { JoinRequest } from '@/services/database-service';

export const Navbar: React.FC = () => {
  const { logout, account } = useAuth();
  const router = useRouter();
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Fetch pending requests
  const fetchPendingRequests = useCallback(async () => {
    if (!account) return;
    
    try {
      setLoading(true);
      console.log('[Navbar] Fetching join requests...');
      
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
            const response = await fetch(`/api/join-requests/pending/${circleId}`);
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
          }
        }
      } 
      // Fallback approach: Try to use the circle ID from the URL ONLY if we're on a circle management page
      else if (router.pathname.includes('/circle') && router.pathname.includes('/manage') && router.query.id && typeof router.query.id === 'string') {
        const circleId = router.query.id;
        console.log(`[Navbar] Fallback: Fetching requests for circle from URL: ${circleId}`);
        try {
          const response = await fetch(`/api/join-requests/pending/${circleId}`);
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
      
    } catch (error) {
      console.error('[Navbar] Failed to fetch pending requests:', error);
    } finally {
      setLoading(false);
    }
  }, [account, router.query.id, router.pathname]);

  useEffect(() => {
    fetchPendingRequests();
    // Set up interval to fetch pending requests every minute
    const interval = setInterval(fetchPendingRequests, 60000);
    return () => clearInterval(interval);
  }, [fetchPendingRequests]);

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
    <nav className="bg-white shadow-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex justify-between h-14 sm:h-16">
          <div className="flex items-center">
            <Link href="/dashboard" className="flex items-center">
              <Image
                src="/njangi-on-chain-logo.png"
                alt="Njangi on-chain"
                width={64}
                height={64}
                className="mr-2 sm:mr-3 w-12 h-12 sm:w-16 sm:h-16 object-contain"
                priority
              />
              <h1 className="text-base sm:text-xl font-semibold text-blue-600">Njangi on-chain</h1>
            </Link>
          </div>
          
          {/* Mobile menu button */}
          {account && (
            <div className="flex md:hidden items-center">
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="p-2 rounded-md text-gray-600 hover:text-blue-600 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <span className="sr-only">{mobileMenuOpen ? 'Close menu' : 'Open menu'}</span>
                {mobileMenuOpen ? (
                  <X className="block h-6 w-6" aria-hidden="true" />
                ) : (
                  <Menu className="block h-6 w-6" aria-hidden="true" />
                )}
              </button>
            </div>
          )}
          
          {/* Desktop nav items */}
          {account && (
            <div className="hidden md:flex items-center space-x-4">
              {/* User Profile Picture */}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <div 
                      className="w-8 h-8 rounded-full overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-300 transition-all"
                      onClick={() => router.push('/dashboard')}
                    >
                      {account.picture ? (
                        <Image
                          src={account.picture}
                          alt="Profile"
                          width={32}
                          height={32}
                          className="object-cover"
                          priority={true}
                          onError={() => {
                            console.error('Error loading profile picture');
                          }}
                        />
                      ) : (
                        <div className="w-full h-full bg-blue-100 flex items-center justify-center">
                          <User className="w-5 h-5 text-blue-600" />
                        </div>
                      )}
                    </div>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                      sideOffset={5}
                    >
                      {account.name || 'My Profile'}
                      <Tooltip.Arrow className="fill-gray-800" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>

              {/* Notifications Panel */}
              <div className="relative" ref={notificationsRef}>
                <button
                  onClick={() => setShowNotifications(!showNotifications)}
                  className="relative p-2 text-gray-600 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-colors duration-200"
                >
                  <Bell className={`w-6 h-6 ${loading ? 'animate-pulse' : ''}`} />
                  {pendingRequests.length > 0 && (
                    <span className="absolute top-0 right-0 inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-white transform translate-x-1/2 -translate-y-1/2 bg-red-600 rounded-full">
                      {pendingRequests.length}
                    </span>
                  )}
                </button>

                {/* Notifications Dropdown */}
                {showNotifications && (
                  <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-lg shadow-lg ring-1 ring-black ring-opacity-5 z-50">
                    <div className="p-3 sm:p-4 border-b border-gray-100 flex justify-between items-center">
                      <div>
                        <h3 className="text-base sm:text-lg font-medium text-gray-900">Notifications</h3>
                        <p className="text-xs sm:text-sm text-gray-500">Join requests for your circles</p>
                      </div>
                      <button 
                        onClick={() => fetchPendingRequests()}
                        disabled={loading}
                        className={`p-2 rounded-full transition-colors ${loading ? 'text-gray-400' : 'text-gray-500 hover:text-blue-600 hover:bg-blue-50'}`}
                        title="Refresh notifications"
                      >
                        <svg 
                          className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} 
                          fill="none" 
                          stroke="currentColor" 
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                      {loading ? (
                        <div className="p-4 text-center text-gray-500">
                          <svg className="animate-spin h-5 w-5 mx-auto mb-2 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span className="text-sm">Loading notifications...</span>
                        </div>
                      ) : pendingRequests.length > 0 ? (
                        <div className="divide-y divide-gray-100">
                          {pendingRequests.map((request) => (
                            <div 
                              key={`${request.circle_id}-${request.user_address}`}
                              className="cursor-pointer p-3 sm:p-4 hover:bg-gray-50 dark:hover:bg-blue-800/20"
                              onClick={() => {
                                router.push(`/circle/${request.circle_id}`);
                                setShowNotifications(false);
                              }}
                            >
                              <div className="flex items-start">
                                <Image
                                  src="/njangi-on-chain-logo.png"
                                  alt="Circle Logo"
                                  width={48}
                                  height={48}
                                  className="rounded-full w-10 h-10 sm:w-12 sm:h-12 object-contain"
                                />
                                <div className="ml-3">
                                  <p className="font-medium text-xs sm:text-sm text-gray-900">
                                    <span className="font-semibold text-blue-600">{request.user_name}</span> wants to join
                                    <span className="font-bold text-gray-800"> {request.circle_name}</span>
                                  </p>
                                  <div className="mt-1 sm:mt-2 text-xs text-gray-500">
                                    {new Date(request.created_at || 0).toLocaleDateString('en-US', {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric',
                                    })}
                                  </div>
                                  
                                  <div className="mt-2 flex space-x-2">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        router.push(`/circle/${request.circle_id}/manage`);
                                        setShowNotifications(false);
                                      }}
                                      className="px-3 py-1 text-xs rounded font-medium bg-blue-100 text-blue-700 hover:bg-blue-200"
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
                        <div className="p-4 text-center text-gray-500 text-xs sm:text-sm">
                          No pending join requests
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Sign Out Button */}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={logout}
                      className="group relative inline-flex items-center justify-center px-3 sm:px-4 py-1.5 sm:py-2 bg-white border border-gray-200 rounded-full shadow-sm text-xs sm:text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-red-100 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-all duration-200"
                    >
                      <span className="absolute inset-0 rounded-full bg-gradient-to-r from-red-50 to-red-50 opacity-0 group-hover:opacity-100 transition-opacity duration-200"></span>
                      <svg 
                        className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1 sm:mr-2 text-gray-400 group-hover:text-red-500 transition-colors duration-200" 
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
                      <span className="relative">Sign Out</span>
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
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
        
        {/* Mobile menu, show/hide based on menu state */}
        {mobileMenuOpen && account && (
          <div className="md:hidden">
            <div className="pt-2 pb-4 space-y-2 px-2 border-t border-gray-200">
              {/* Mobile User Profile */}
              <div 
                className="flex items-center space-x-3 px-3 py-2 rounded-md hover:bg-blue-50"
                onClick={() => {
                  router.push('/dashboard');
                  setMobileMenuOpen(false);
                }}
              >
                <div className="flex-shrink-0 w-9 h-9 rounded-full overflow-hidden bg-blue-100">
                  {account.picture ? (
                    <Image
                      src={account.picture}
                      alt="Profile"
                      width={36}
                      height={36}
                      className="object-cover"
                      priority={true}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <User className="w-5 h-5 text-blue-600" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-gray-900">{account.name || 'My Account'}</span>
                  <span className="text-xs text-gray-500">View dashboard</span>
                </div>
              </div>
              
              {/* Mobile Notifications */}
              <div
                className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-blue-50"
                onClick={(e) => {
                  e.preventDefault();
                  // Toggle a focused mobile view of notifications or navigate to a dedicated page
                  if (pendingRequests.length > 0) {
                    // Navigate to first circle with pending requests
                    router.push(`/circle/${pendingRequests[0].circle_id}/manage`);
                    setMobileMenuOpen(false);
                  }
                }}
              >
                <div className="flex items-center space-x-3">
                  <div className="relative flex-shrink-0 rounded-full p-1 bg-gray-100">
                    <Bell className="w-5 h-5 text-gray-600" />
                    {pendingRequests.length > 0 && (
                      <span className="absolute top-0 right-0 block h-4 w-4 rounded-full bg-red-600 text-white text-xs font-bold flex items-center justify-center transform translate-x-1/4 -translate-y-1/4">
                        {pendingRequests.length}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-medium text-gray-900">Notifications</span>
                </div>
                <span className="text-xs font-medium text-blue-600">
                  {pendingRequests.length ? `${pendingRequests.length} new` : 'None'}
                </span>
              </div>
              
              {/* Mobile Sign Out */}
              <button
                onClick={logout}
                className="w-full flex items-center px-3 py-2 text-sm font-medium text-gray-900 hover:text-red-600 rounded-md hover:bg-red-50"
              >
                <svg 
                  className="mr-3 h-5 w-5 text-gray-400" 
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