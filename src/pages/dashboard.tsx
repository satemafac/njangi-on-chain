import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { Tab } from '@headlessui/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import { priceService } from '../services/price-service';
import { toast } from 'react-hot-toast';
import { Eye, Settings, Trash2, CreditCard, RefreshCw, Users, X, Copy, Link } from 'lucide-react';
import { ZkLoginError } from '../services/zkLoginClient';

// Circle type definition
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  contributionAmountUsd: number;
  securityDeposit: number;
  securityDepositUsd: number;
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
  memberStatus: 'active' | 'suspended' | 'exited';
  isAdmin: boolean;
}

// Type definitions for SUI event payloads
interface CircleCreatedEvent {
  circle_id: string;
  admin: string;
  name: string;
  contribution_amount: string;
  contribution_amount_usd: string;
  security_deposit_usd: string;
  max_members: string;
  cycle_length: string;
}

interface MemberJoinedEvent {
  circle_id: string;
  member: string;
  position?: number;
  // These fields may or may not be present in the event payload
  contribution_amount_usd?: string;
  security_deposit_usd?: string;
}

// Add these type definitions at the top of the file with other interfaces
interface TransactionBlock {
  transactions?: Array<{
    kind: string;
    target: string;
    arguments: Array<{
      kind: string;
      index: number;
      type: string;
      value: string;
    }>;
  }>;
  moveCall?: {
    packageObjectId: string;
    module: string;
    function: string;
    typeArguments: string[];
    arguments: string[];
  };
}

interface TransactionOptions {
  showEffects: boolean;
  showEvents: boolean;
}

interface TransactionBlockPayload {
  transactionBlock: TransactionBlock;
  options: TransactionOptions;
}

// Declare global wallet type - updated to include all possible wallet objects
declare global {
  interface Window {
    suiWallet?: {
      // Original API methods
      constructTransaction?: (txData: {
        kind: string;
        data: {
          packageObjectId: string;
          module: string;
          function: string;
          typeArguments: string[];
          arguments: string[];
          gasBudget: number;
        }
      }) => unknown;
      
      signAndExecuteTransaction?: (tx: {
        transaction: unknown;
      }) => Promise<Record<string, unknown>>;
      
      // New API methods
      signAndExecuteTransactionBlock?: (tx: TransactionBlockPayload) => Promise<Record<string, unknown>>;
      
      signTransactionBlock?: (tx: {
        transactionBlock: TransactionBlock;
        options?: {
          showEffects?: boolean;
          showEvents?: boolean;
        };
      }) => Promise<unknown>;
      
      // General connection methods that might be required
      hasPermissions?: () => Promise<boolean>;
      requestPermissions?: () => Promise<boolean>;
      getAccounts?: () => Promise<string[]>;
    };
    
    // Alternative wallet object names used by different SUI wallet versions
    sui?: typeof Window.prototype.suiWallet;
    suix?: typeof Window.prototype.suiWallet;
    ethos?: typeof Window.prototype.suiWallet;
    suiet?: typeof Window.prototype.suiWallet;
    martian?: typeof Window.prototype.suiWallet;
  }
}

export default function Dashboard() {
  const router = useRouter();
  const { isAuthenticated, userAddress, account, logout, deleteCircle: authDeleteCircle } = useAuth();
  const [balance, setBalance] = useState<string>('0');
  const [showFullAddress, setShowFullAddress] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
  const [deleteableCircles, setDeleteableCircles] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false);
  const [circleIdInput, setCircleIdInput] = useState('');
  const [copiedCircleId, setCopiedCircleId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      console.log("User not authenticated, redirecting to home");
      router.push('/');
    } else {
      console.log("User is authenticated:", userAddress);
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    const fetchBalance = async () => {
      if (userAddress) {
        const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
        const balance = await client.getBalance({
          owner: userAddress,
          coinType: '0x2::sui::SUI'
        });
        setBalance(balance.totalBalance);
      }
    };
    fetchBalance();
  }, [userAddress]);

  // Fetch SUI price - only on page load, no interval
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        setSuiPrice(price);
        
        // Show error toast if price fetching failed but we're using cached data
        if (priceService.getFetchStatus() === 'error') {
          toast.error(
            'Unable to fetch latest SUI price. Using last known price.',
            {
              duration: 4000,
              position: 'bottom-center',
              icon: '⚠️',
              style: {
                border: '1px solid #F87171',
                padding: '16px',
                color: '#991B1B',
              },
            }
          );
        }
      } catch (error) {
        console.error('Error in price fetch flow:', error);
        // Keep using the default price
      }
    };

    fetchPrice();
    // Removed interval to avoid excessive API calls
  }, []);

  // Use useCallback to memoize the fetchUserCircles function
  const fetchUserCircles = useCallback(async () => {
    console.log('fetchUserCircles starting...');
    
    if (!userAddress) {
      console.log('No user address, skipping fetch');
      return;
    }
    
    console.log('Fetching circles for user:', userAddress);
    
    setLoading(true);
    setError('');
    
    try {
      // Create the Sui client
      const client = new SuiClient({
        url: 'https://fullnode.testnet.sui.io:443'
      });
      
      console.log('Using package ID:', process.env.NEXT_PUBLIC_PACKAGE_ID);
      
      // Define package ID where njangi_circle module is deployed
      const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID;
      
      // Note: We use the old package ID for event types but new package ID for direct object queries
      
      // Step 1: Find circles created by this user (admin)
      let createdCircles;
      try {
        createdCircles = await client.queryEvents({
          query: {
            MoveEventType: `0xaf572e4479bb18e1e501ec18d766909789a636ebee2b27fae2a228355b84512b::njangi_circle::CircleCreated`
          },
          order: 'descending',
          limit: 50, // Limit to 50 most recent circles
        });
      } catch (error) {
        console.error('Error fetching created circles:', error);
        createdCircles = { data: [] }; // Provide default empty data
      }
      
      // Step 2: Find circles this user has joined - using the correct filter structure
      // Instead of trying to filter by sender directly, we'll fetch all MemberJoined events
      // and filter them in our code
      let joinedCircles;
      try {
        joinedCircles = await client.queryEvents({
          query: {
            MoveEventType: `0xaf572e4479bb18e1e501ec18d766909789a636ebee2b27fae2a228355b84512b::njangi_circle::MemberJoined`
          },
          order: 'descending',
          limit: 100, // Limit to 100 most recent joins
        });
      } catch (error) {
        console.error('Error fetching joined circles:', error);
        joinedCircles = { data: [] }; // Provide default empty data
      }
      
      // Process both result sets
      const circleMap = new Map<string, Circle>();
      
      // Process created circles (admin)
      for (const event of createdCircles.data) {
        const parsedEvent = event.parsedJson as CircleCreatedEvent;
        if (parsedEvent?.admin === userAddress) {
          try {
            // First verify if the circle still exists (hasn't been deleted)
            const objectExists = await client.getObject({
              id: parsedEvent.circle_id,
              options: { showType: true, showOwner: true }
            });
            
            // Add logging to see object type and package information
            console.log(`Circle ${parsedEvent.circle_id} belongs to package: ${packageId}`);
            
            // Skip this circle if it doesn't exist or is not accessible
            if (!objectExists.data || objectExists.error) {
              console.log(`Circle ${parsedEvent.circle_id} no longer exists, skipping...`);
              continue;
            }
            
            // Get the detailed circle data to retrieve USD values
            const objectData = await client.getObject({
              id: parsedEvent.circle_id,
              options: { showContent: true }
            });
            
            // Log the entire object to better understand its structure
            console.log('Full circle object data:', JSON.stringify(objectData.data, null, 2));
            
            const content = objectData.data?.content;
            if (content && 'fields' in content) {
              // Log the entire fields object to see what properties are available
              console.log('Circle fields:', JSON.stringify(content.fields, null, 2));
              
              const fields = content.fields as {
                name: string;
                admin: string;
                contribution_amount: string;
                contribution_amount_usd: string;
                security_deposit: string;
                security_deposit_usd: string;
                cycle_length: string;
                cycle_day: string;
                max_members: string;
                current_members: string;
                next_payout_time: string;
                // Try to look for nested USD amounts
                usd_amounts?: {
                  contribution_amount?: string;
                  security_deposit?: string;
                  target_amount?: string;
                };
              };
              
              // Get the USD amounts, checking all possible structures for USD values
              let contributionAmountUsd = 0;
              let securityDepositUsd = 0;
              
              // Check for direct fields first
              if (fields.contribution_amount_usd) {
                contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
                console.log('Found direct contribution_amount_usd:', fields.contribution_amount_usd);
              } 
              // Then check for nested usd_amounts structure
              else if (fields.usd_amounts && fields.usd_amounts.contribution_amount) {
                contributionAmountUsd = Number(fields.usd_amounts.contribution_amount) / 100;
                console.log('Found usd_amounts.contribution_amount:', fields.usd_amounts.contribution_amount);
              }
              // Finally, check if it's in the parsedEvent directly
              else if (parsedEvent.contribution_amount_usd) {
                contributionAmountUsd = Number(parsedEvent.contribution_amount_usd) / 100;
                console.log('Using event contribution_amount_usd:', parsedEvent.contribution_amount_usd);
              }
              
              // Same for security deposit
              if (fields.security_deposit_usd) {
                securityDepositUsd = Number(fields.security_deposit_usd) / 100;
                console.log('Found direct security_deposit_usd:', fields.security_deposit_usd);
              }
              else if (fields.usd_amounts && fields.usd_amounts.security_deposit) {
                securityDepositUsd = Number(fields.usd_amounts.security_deposit) / 100;
                console.log('Found usd_amounts.security_deposit:', fields.usd_amounts.security_deposit);
              }
              else if (parsedEvent.security_deposit_usd) {
                securityDepositUsd = Number(parsedEvent.security_deposit_usd) / 100;
                console.log('Using event security_deposit_usd:', parsedEvent.security_deposit_usd);
              }
              
              // Log data for debugging
              console.log('Circle USD values after processing:', {
                circleId: parsedEvent.circle_id,
                contributionUSD: contributionAmountUsd,
                securityDepositUSD: securityDepositUsd,
                directFieldsPresent: {
                  contribution_amount_usd: !!fields.contribution_amount_usd,
                  security_deposit_usd: !!fields.security_deposit_usd
                },
                usdAmountsPresent: !!fields.usd_amounts,
                parsedEventFields: {
                  contribution_amount_usd: !!parsedEvent.contribution_amount_usd,
                  security_deposit_usd: !!parsedEvent.security_deposit_usd
                }
              });
              
              // Convert SUI values from MIST to SUI
              const contributionAmountSui = Number(fields.contribution_amount) / 1e9;
              const securityDepositSui = Number(fields.security_deposit) / 1e9;
              
              // Use contribution_amount_usd and security_deposit_usd from event if they exist
              if (parsedEvent.contribution_amount_usd && contributionAmountUsd === 0) {
                contributionAmountUsd = Number(parsedEvent.contribution_amount_usd) / 100;
                console.log('Using contribution_amount_usd from event:', contributionAmountUsd);
              }
              
              if (parsedEvent.security_deposit_usd && securityDepositUsd === 0) {
                securityDepositUsd = Number(parsedEvent.security_deposit_usd) / 100;
                console.log('Using security_deposit_usd from event:', securityDepositUsd);
              }
              
              // Debug log the values we've loaded
              console.log('Final USD values for circle:', {
                contributionUSD: contributionAmountUsd,
                securityDepositUSD: securityDepositUsd
              });
              
              circleMap.set(parsedEvent.circle_id, {
                id: parsedEvent.circle_id,
                name: fields.name,
                admin: fields.admin,
                contributionAmount: contributionAmountSui,
                contributionAmountUsd: contributionAmountUsd || 0,
                securityDeposit: securityDepositSui,
                securityDepositUsd: securityDepositUsd || 0,
                cycleLength: Number(fields.cycle_length),
                cycleDay: Number(fields.cycle_day),
                maxMembers: Number(fields.max_members),
                currentMembers: Number(fields.current_members),
                nextPayoutTime: Number(fields.next_payout_time),
                memberStatus: 'active',
                isAdmin: true
              });
            } else {
              // Handle case where we can't get full content but can use event data
              // Check for USD amounts in the event
              let contributionAmountUsd = 0;
              let securityDepositUsd = 0;
              
              if (parsedEvent.contribution_amount_usd) {
                contributionAmountUsd = Number(parsedEvent.contribution_amount_usd) / 100;
              }
              
              if (parsedEvent.security_deposit_usd) {
                securityDepositUsd = Number(parsedEvent.security_deposit_usd) / 100;
              }
              
              // Log event data for debugging
              console.log('Circle USD values from event:', {
                circleId: parsedEvent.circle_id,
                contributionUSD: contributionAmountUsd,
                securityDepositUSD: securityDepositUsd,
                rawContributionUSD: parsedEvent.contribution_amount_usd,
                rawSecurityDepositUSD: parsedEvent.security_deposit_usd,
                fullParsedEvent: JSON.stringify(parsedEvent)
              });
              
              // Try to get SUI values
              const contributionRaw = Number(parsedEvent.contribution_amount) / 1e9;
              const isUnreasonableAmount = contributionRaw > 1_000_000_000;
              
              circleMap.set(parsedEvent.circle_id, {
                id: parsedEvent.circle_id,
                name: parsedEvent.name,
                admin: parsedEvent.admin,
                contributionAmount: isUnreasonableAmount ? 0 : contributionRaw,
                contributionAmountUsd: contributionAmountUsd || 0,
                securityDeposit: 0,
                securityDepositUsd: securityDepositUsd || 0,
                cycleLength: Number(parsedEvent.cycle_length),
                cycleDay: 0,
                maxMembers: Number(parsedEvent.max_members),
                currentMembers: 0,
                nextPayoutTime: 0,
                memberStatus: 'active',
                isAdmin: parsedEvent.admin === userAddress
              });
            }
          } catch (error) {
            console.error(`Error fetching circle details for ${parsedEvent.circle_id}:`, error);
          }
        }
      }
      
      // Process joined circles (member)
      for (const event of joinedCircles.data) {
        const parsedEvent = event.parsedJson as MemberJoinedEvent;
        if (parsedEvent?.member === userAddress) {
          // Check if we already have this circle as admin
          if (!circleMap.has(parsedEvent.circle_id)) {
            // Need to fetch more details about this circle
            try {
              const objectData = await client.getObject({
                id: parsedEvent.circle_id,
                options: { showContent: true }
              });
              
              // Log the entire object to better understand its structure
              console.log('Member circle object data:', JSON.stringify(objectData.data, null, 2));
              
              const content = objectData.data?.content;
              if (content && 'fields' in content) {
                // Log the entire fields object to see what properties are available
                console.log('Member circle fields:', JSON.stringify(content.fields, null, 2));
                
                const fields = content.fields as {
                  name: string;
                  admin: string;
                  contribution_amount: string;
                  contribution_amount_usd: string;
                  security_deposit: string;
                  security_deposit_usd: string;
                  cycle_length: string;
                  cycle_day: string;
                  max_members: string;
                  current_members: string;
                  next_payout_time: string;
                  // Try to look for nested USD amounts
                  usd_amounts?: {
                    contribution_amount?: string;
                    security_deposit?: string;
                    target_amount?: string;
                  };
                };
                
                // Get the USD amounts, checking both direct fields and potentially nested usd_amounts
                let contributionAmountUsd = 0;
                let securityDepositUsd = 0;
                
                // Check for direct fields first
                if (fields.contribution_amount_usd) {
                  contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
                } 
                // Then check for nested usd_amounts structure
                else if (fields.usd_amounts && fields.usd_amounts.contribution_amount) {
                  contributionAmountUsd = Number(fields.usd_amounts.contribution_amount) / 100;
                }
                
                // Same for security deposit
                if (fields.security_deposit_usd) {
                  securityDepositUsd = Number(fields.security_deposit_usd) / 100;
                  console.log('Found direct security_deposit_usd:', fields.security_deposit_usd);
                }
                else if (fields.usd_amounts && fields.usd_amounts.security_deposit) {
                  securityDepositUsd = Number(fields.usd_amounts.security_deposit) / 100;
                  console.log('Found usd_amounts.security_deposit:', fields.usd_amounts.security_deposit);
                }
                else if (parsedEvent.security_deposit_usd) {
                  securityDepositUsd = Number(parsedEvent.security_deposit_usd) / 100;
                  console.log('Using event security_deposit_usd:', parsedEvent.security_deposit_usd);
                }
                
                // Log data for debugging
                console.log('Member circle USD values after processing:', {
                  circleId: parsedEvent.circle_id,
                  contributionUSD: contributionAmountUsd,
                  securityDepositUSD: securityDepositUsd,
                  directFieldsPresent: {
                    contribution_amount_usd: !!fields.contribution_amount_usd,
                    security_deposit_usd: !!fields.security_deposit_usd
                  },
                  usdAmountsPresent: !!fields.usd_amounts
                });
                
                // We'll use the SUI amounts directly from the contract
                const contributionAmountSui = Number(fields.contribution_amount) / 1e9;
                const securityDepositSui = Number(fields.security_deposit) / 1e9;
                
                // Debug log the final values we'll use
                console.log('Final USD values for member circle:', {
                  contributionUSD: contributionAmountUsd,
                  securityDepositUSD: securityDepositUsd
                });
                
                circleMap.set(parsedEvent.circle_id, {
                  id: parsedEvent.circle_id,
                  name: fields.name,
                  admin: fields.admin,
                  contributionAmount: contributionAmountSui,
                  contributionAmountUsd: contributionAmountUsd || 0, 
                  securityDeposit: securityDepositSui,
                  securityDepositUsd: securityDepositUsd || 0,
                  cycleLength: Number(fields.cycle_length),
                  cycleDay: Number(fields.cycle_day),
                  maxMembers: Number(fields.max_members),
                  currentMembers: Number(fields.current_members),
                  nextPayoutTime: Number(fields.next_payout_time),
                  memberStatus: 'active', // Default, will update if needed
                  isAdmin: fields.admin === userAddress
                });
              }
            } catch (err) {
              console.error(`Error fetching circle details for ${parsedEvent.circle_id}:`, err);
            }
          }
        }
      }
      
      // Convert map to array and set state
      setCircles(Array.from(circleMap.values()));
    } catch (error) {
      console.error('Error fetching circles:', error);
      setError('An error occurred while fetching circles. Please try again later.');
    } finally {
      setLoading(false);
    }
  }, [userAddress]);

  useEffect(() => {
    fetchUserCircles();
  }, [userAddress, fetchUserCircles]);

  // Check which circles can be deleted - only for admin circles
  useEffect(() => {
    const checkDeleteableCircles = async () => {
      if (!userAddress || circles.length === 0) return;
      
      try {
        const deleteable = new Set<string>();
        
        // For each circle where user is admin, check if it can be deleted
        for (const circle of circles.filter(c => c.isAdmin)) {
          try {
            // For simplicity, we'll check if it meets the basic criteria:
            // 1. Is admin
            // 2. Has 0 or 1 members (only admin)
            if (circle.currentMembers <= 1) {
              deleteable.add(circle.id);
            }
          } catch (error) {
            console.error(`Error checking if circle ${circle.id} can be deleted:`, error);
          }
        }
        
        setDeleteableCircles(deleteable);
      } catch (error) {
        console.error('Error checking deleteable circles:', error);
      }
    };
    
    checkDeleteableCircles();
  }, [circles, userAddress]);
  
  // Check for wallet availability on component mount
  useEffect(() => {
    const checkWalletAvailability = async () => {
      // If using zkLogin, we don't need to check for wallet availability
      if (isAuthenticated && account) {
        console.log("Using zkLogin authentication, skipping wallet check");
        return;
      }

      // Check for wallet extensions
      const hasWallet = !!(
        window.suiWallet || 
        window.sui || 
        window.suix || 
        window.ethos || 
        window.suiet || 
        window.martian
      );
      
      if (!hasWallet) {
        console.log("No wallet extension detected");
        // Only show toast if not using zkLogin
        if (!isAuthenticated) {
          toast.error('No SUI wallet extension detected. Please install a SUI wallet or use zkLogin authentication.');
        }
      }
    };
    
    checkWalletAvailability();
  }, [isAuthenticated, account]);

  // New function to delete circle with zkLogin
  const deleteCircleWithZkLogin = async (circleId: string) => {
    try {
      console.log("Deleting circle with zkLogin:", circleId);
      setIsDeleting(circleId);

      // Use the AuthContext's deleteCircle method
      const digest = await authDeleteCircle(circleId);
      
      console.log('Transaction succeeded with digest:', digest);
      toast.success('Circle deleted successfully');
      
      // Update the UI - remove the deleted circle
      setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
      setDeleteableCircles(prev => {
        const updated = new Set(prev);
        updated.delete(circleId);
        return updated;
      });
      
    } catch (error: unknown) {
      console.error('Error deleting circle with zkLogin:', error);
      
      // Check if this is a ZkLoginError with requireRelogin flag
      if (error instanceof ZkLoginError && error.requireRelogin) {
        toast.error(
          <div className="flex flex-col">
            <div>Authentication issue: Please login again</div>
            <button 
              onClick={() => window.location.href = '/'} 
              className="mt-2 bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-sm flex items-center justify-center"
            >
              <RefreshCw className="w-3 h-3 mr-1" /> Re-authenticate
            </button>
          </div>,
          { duration: 10000 }
        );
        return;
      }
      
      // Show appropriate error message based on the error
      if (error instanceof Error) {
        // Log the full error for debugging
        console.error('Full error details:', {
          message: error.message,
          stack: error.stack,
          name: error.name,
          isZkLoginError: error instanceof ZkLoginError
        });
        
        if (error.message.includes('ECircleHasActiveMembers') || 
            error.message.includes('Cannot delete: Circle has active members')) {
          toast.error('Cannot delete: Circle has active members');
        } else if (error.message.includes('ECircleHasContributions') || 
                  error.message.includes('Cannot delete: Circle has received contributions')) {
          toast.error('Cannot delete: Circle has received contributions');
        } else if (error.message.includes('EOnlyCircleAdmin') || 
                  error.message.includes('Only the circle admin')) {
          toast.error('Cannot delete: Only the circle admin can delete this circle');
        } else if (error.message.includes('not found') || 
                  error.message.includes('not accessible')) {
          toast.error('Circle not found or not accessible');
        } else if (error.message.includes('Session') || 
                  error.message.includes('authentication') || 
                  error.message.includes('expired')) {
          toast.error(
            <div className="flex flex-col">
              <div>Authentication issue: {error.message}</div>
              <button 
                onClick={() => window.location.href = '/'} 
                className="mt-2 bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-sm flex items-center justify-center"
              >
                <RefreshCw className="w-3 h-3 mr-1" /> Re-authenticate
              </button>
            </div>,
            { duration: 10000 }
          );
        } else {
          toast.error(`Error: ${error.message}`, {
            duration: 5000
          });
        }
      } else {
        toast.error('Error deleting circle', {
          duration: 5000
        });
      }
    } finally {
      setIsDeleting(null);
    }
  };

  const deleteCircle = async (circleId: string) => {
    console.log("deleteCircle function called with circleId:", circleId);
    
    // Check if using zkLogin authentication
    if (isAuthenticated && account) {
      console.log("Using zkLogin authentication for deletion");
      return deleteCircleWithZkLogin(circleId);
    }
    
    // Check for wallet availability - expanded to check multiple wallet objects
    const walletDetectionDetails = {
      suiWallet: !!window.suiWallet,
      sui: !!window.sui,
      suix: !!window.suix,
      ethos: !!window.ethos,
      suiet: !!window.suiet,
      martian: !!window.martian
    };
    
    console.log("Wallet detection results:", walletDetectionDetails);
    
    // Try to find an available wallet
    let wallet = null;
    if (window.suiWallet) {
      console.log("Using standard SUI wallet");
      wallet = window.suiWallet;
    } else if (window.sui) {
      console.log("Using 'sui' wallet object");
      wallet = window.sui;
    } else if (window.suix) {
      console.log("Using 'suix' wallet object");
      wallet = window.suix;
    } else if (window.ethos) {
      console.log("Using Ethos wallet");
      wallet = window.ethos;
    } else if (window.suiet) {
      console.log("Using Suiet wallet");
      wallet = window.suiet;
    } else if (window.martian) {
      console.log("Using Martian wallet");
      wallet = window.martian;
    }
    
    if (!wallet) {
      console.log("No compatible SUI wallet found");
      toast.error('No wallet detected. Please install a SUI wallet extension or use zkLogin authentication.');
      return;
    }
    
    // Log available methods on the wallet object
    console.log("Available wallet methods:", Object.keys(wallet));
    
    // Updated package ID to the newly published contract
    const packageId = "0xaf572e4479bb18e1e501ec18d766909789a636ebee2b27fae2a228355b84512b";
    console.log("Using packageId:", packageId);
    
    setIsDeleting(circleId);
    console.log("Set isDeleting state to:", circleId);
    
    try {
      // Check for wallet features/capabilities
      const hasSignAndExecuteTransactionBlock = typeof wallet.signAndExecuteTransactionBlock === 'function';
      const hasSignTransactionBlock = typeof wallet.signTransactionBlock === 'function';
      const hasSignAndExecuteTransaction = typeof wallet.signAndExecuteTransaction === 'function';
      const hasConstructTransaction = typeof wallet.constructTransaction === 'function';
      const hasSignAndExecuteTransactionV2 = typeof wallet.signAndExecuteTransaction === 'function';
      
      console.log("Wallet capabilities:", {
        signAndExecuteTransactionBlock: hasSignAndExecuteTransactionBlock,
        signTransactionBlock: hasSignTransactionBlock,
        signAndExecuteTransaction: hasSignAndExecuteTransaction,
        constructTransaction: hasConstructTransaction,
        signAndExecuteTransactionV2: hasSignAndExecuteTransactionV2
      });
      
      let result: Record<string, unknown> | null = null;
      
      // Try newer wallet API first (preferred)
      if (hasSignAndExecuteTransactionBlock && wallet.signAndExecuteTransactionBlock) {
        console.log("Using signAndExecuteTransactionBlock API");
        
        // Create a transaction block for the newer API format
        const txb: TransactionBlockPayload = {
          transactionBlock: {
            // Modern format for transaction block
            transactions: [
              {
                kind: 'MoveCall',
                target: `${packageId}::njangi_circle::delete_circle`,
                arguments: [
                  { kind: 'Input', index: 0, type: 'object', value: circleId }
                ]
              }
            ]
          },
          options: {
            showEffects: true,
            showEvents: true,
          }
        };
        
        console.log("Transaction block created:", txb);
        result = await wallet.signAndExecuteTransactionBlock(txb);
      }
      // Try alternative format for signAndExecuteTransactionBlock
      else if (hasSignAndExecuteTransactionBlock && wallet.signAndExecuteTransactionBlock) {
        console.log("Using alternative signAndExecuteTransactionBlock format");
        
        const txb: TransactionBlockPayload = {
          transactionBlock: {
            // Alternative format
            moveCall: {
              packageObjectId: packageId,
              module: 'njangi_circle',
              function: 'delete_circle',
              typeArguments: [],
              arguments: [circleId]
            }
          },
          options: {
            showEffects: true,
            showEvents: true,
          }
        };
        
        console.log("Transaction block created (alternative format):", txb);
        result = await wallet.signAndExecuteTransactionBlock(txb);
      }
      // Fall back to older wallet API
      else if (hasConstructTransaction && hasSignAndExecuteTransaction && 
               wallet.constructTransaction && wallet.signAndExecuteTransaction) {
        console.log("Using legacy transaction flow");
        const transaction = wallet.constructTransaction({
          kind: 'moveCall',
          data: {
            packageObjectId: packageId,
            module: 'njangi_circle',
            function: 'delete_circle',
            typeArguments: [],
            arguments: [circleId],
            gasBudget: 10000000,
          }
        });
        
        console.log("Transaction constructed:", transaction);
        result = await wallet.signAndExecuteTransaction({
          transaction: transaction,
        });
      }
      else {
        console.error("No compatible wallet API methods found");
        toast.error('Your wallet does not support the required transaction methods. Please try a different wallet.');
        setIsDeleting(null);
        return;
      }
      
      console.log("Transaction execution result:", result);
      
      if (result) {
        toast.success('Circle deleted successfully');
        
        // Update the UI - remove the deleted circle
        setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
        setDeleteableCircles(prev => {
          const updated = new Set(prev);
          updated.delete(circleId);
          return updated;
        });
      }
    } catch (error) {
      console.error('Error deleting circle:', error);
      
      // Show error toast with appropriate message
      if (error instanceof Error) {
        if (error.message.includes('ECircleHasActiveMembers')) {
          toast.error('Cannot delete: Circle has active members');
        } else if (error.message.includes('ECircleHasContributions')) {
          toast.error('Cannot delete: Circle has received contributions');
        } else {
          toast.error('Error deleting circle: ' + error.message);
        }
      } else {
        toast.error('Error deleting circle');
      }
    } finally {
      setIsDeleting(null);
    }
  };

  const shortenAddress = (address: string | undefined) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const copyToClipboard = async (text: string, type: 'address' | 'circleId' = 'address') => {
    try {
      await navigator.clipboard.writeText(text);
      
      if (type === 'address') {
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2000);
      } else if (type === 'circleId') {
        setCopiedCircleId(text);
        toast.success('Circle ID copied to clipboard!');
        setTimeout(() => setCopiedCircleId(null), 2000);
      }
    } catch (err) {
      console.error(`Failed to copy ${type}:`, err);
      toast.error(`Failed to copy ${type === 'address' ? 'address' : 'circle ID'}`);
    }
  };

  const copyShareLink = async (circleId: string) => {
    try {
      const shareLink = `${window.location.origin}/circle/${circleId}/join`;
      await navigator.clipboard.writeText(shareLink);
      toast.success('Invite link copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy share link:', err);
      toast.error('Failed to copy invite link');
    }
  };

  // Format cycle lengths and days for display
  const formatCycleInfo = (cycleLength: number, cycleDay: number) => {
    // Cycle length: 0 = weekly, 1 = monthly, 2 = quarterly
    let cyclePeriod = '';
    let dayFormat = '';
    
    switch (cycleLength) {
      case 0: // Weekly
        cyclePeriod = 'Weekly';
        // For weekly, cycleDay is 0-6 (Sunday-Saturday)
        // The Move contract uses 0 = Sunday, 1 = Monday, etc.
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        dayFormat = weekdays[cycleDay % 7]; // Ensure we don't go out of bounds
        break;
      case 1: // Monthly
        cyclePeriod = 'Monthly';
        // In your specific case, 0th day was shown for Monthly cycle
        // Let's handle this special case and just default to 1st day when we see 0
        const adjustedDay = cycleDay === 0 ? 1 : cycleDay;
        dayFormat = getOrdinalSuffix(adjustedDay);
        break;
      case 2: // Quarterly
        cyclePeriod = 'Quarterly';
        // Same fix for quarterly
        const adjustedQuarterlyDay = cycleDay === 0 ? 1 : cycleDay;
        dayFormat = getOrdinalSuffix(adjustedQuarterlyDay);
        break;
      default:
        cyclePeriod = 'Unknown';
        dayFormat = `Day ${cycleDay === 0 ? 1 : cycleDay}`;
    }
    
    return `${cyclePeriod} (${dayFormat})`;
  };

  // Helper to format dates with ordinal suffix
  const getOrdinalSuffix = (day: number) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const relevantDigits = (day % 100);
    const suffix = (relevantDigits >= 11 && relevantDigits <= 13) ? 'th' : suffixes[Math.min(relevantDigits % 10, 3)];
    return `${day}${suffix} day`;
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Format USD value
  const formatUSD = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  // Currency display component
  const CurrencyDisplay = ({ usd, sui, className = "" }: { usd?: number; sui?: number; className?: string }) => {
    const isPriceStale = priceService.getFetchStatus() === 'error';
    
    console.log('CurrencyDisplay inputs:', { usd, sui, suiPrice });
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('CurrencyDisplay: both usd and sui values are invalid, defaulting to 0');
      usd = 0;
      sui = 0;
    }
    
    // Calculate values based on which parameter is provided
    let calculatedSui: number;
    let calculatedUsd: number;
    
    if (usd !== undefined && !isNaN(usd)) {
      // If USD is provided and valid, calculate SUI based on current price
      calculatedUsd = usd;
      calculatedSui = suiPrice > 0 ? usd / suiPrice : 0;
      console.log('CurrencyDisplay: using USD value to calculate SUI:', { 
        usd: calculatedUsd, 
        sui: calculatedSui,
        suiPrice 
      });
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = sui * suiPrice;
      console.log('CurrencyDisplay: using SUI value to calculate USD:', { 
        sui: calculatedSui, 
        usd: calculatedUsd,
        suiPrice 
      });
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
      console.log('CurrencyDisplay: using default values:', { 
        sui: calculatedSui, 
        usd: calculatedUsd 
      });
    }
    
    // Format SUI with appropriate precision
    const formattedSui = calculatedSui >= 1000 
      ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
      : calculatedSui >= 100 
        ? calculatedSui.toFixed(1) 
        : calculatedSui.toFixed(2);
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {formatUSD(calculatedUsd)} <span className="text-gray-500 mr-1">({formattedSui} SUI)</span>
              {isPriceStale && <span title="Using cached price">⚠️</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>SUI Conversion Rate:</p>
                <p>1 SUI = {formatUSD(suiPrice)}</p>
                <p className="text-xs text-gray-400">
                  {isPriceStale 
                    ? "Using cached price - service temporarily unavailable" 
                    : "Updated price data from CoinGecko"}
                </p>
              </div>
              <Tooltip.Arrow className="fill-gray-900" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  };

  const handleJoinCircle = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Simple validation - make sure the input isn't empty
    if (!circleIdInput.trim()) {
      toast.error('Please enter a valid circle ID');
      return;
    }
    
    // Extract just the ID if the user pasted the full URL
    let circleId = circleIdInput.trim();
    
    // If the input contains a URL path, extract just the circle ID
    if (circleId.includes('/circle/')) {
      const match = circleId.match(/\/circle\/([^\/]+)/);
      if (match && match[1]) {
        circleId = match[1];
      }
    }
    
    // Navigate to the join page for this circle
    router.push(`/circle/${circleId}/join`);
    
    // Reset the input and close the dialog
    setCircleIdInput('');
    setIsJoinDialogOpen(false);
  };

  const shortenId = (id: string) => {
    if (!id) return '';
    return `${id.slice(0, 10)}...${id.slice(-6)}`;
  };

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toast Notification */}
      {showToast && (
        <div className="fixed top-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg transition-opacity duration-200 flex items-center space-x-2 z-50">
          <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>Address copied to clipboard!</span>
        </div>
      )}

      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Image
                src="/njangi-on-chain-logo.png"
                alt="Njangi on-chain"
                width={48}
                height={48}
                className="mr-3"
                priority
              />
              <h1 className="text-xl font-semibold text-blue-600">Njangi on-chain</h1>
            </div>
            <div className="flex items-center space-x-4">
              <button
                onClick={logout}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors duration-200"
              >
                <svg 
                  className="w-4 h-4 mr-2" 
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          {/* Profile and Balance Card */}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="p-6">
              <div className="flex items-center space-x-4">
                <div className="h-16 w-16 rounded-full overflow-hidden bg-gray-200 flex-shrink-0 relative">
                  {account.picture ? (
                    // Use Next.js Image for Google profile pictures
                    <Image
                      src={account.picture}
                      alt="Profile"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority={true}
                      onError={() => {
                        console.error('Error loading Google profile picture');
                      }}
                    />
                  ) : (
                    // Use Next.js Image for fallback avatar
                    <Image
                      src={`https://api.dicebear.com/7.x/micah/svg?seed=${account.sub}`}
                      alt="Profile"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority={true}
                      unoptimized={true} // Required for SVGs
                    />
                  )}
                </div>
                <div className="flex-grow">
                  <h2 className="text-xl font-semibold text-gray-900">
                    Welcome Back{account.name ? `, ${account.name}` : ''}!
                  </h2>
                </div>
              </div>
            </div>
            
            <div className="border-t border-gray-200">
              <div className="grid grid-cols-2 divide-x divide-gray-200">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-500">Wallet Address</p>
                    <button
                      onClick={() => copyToClipboard(userAddress)}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                      title="Copy address"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                        />
                      </svg>
                    </button>
                  </div>
                  <div className="group relative">
                    <p className="mt-1 text-sm text-gray-900 break-all font-mono">
                      {showFullAddress ? userAddress : shortenAddress(userAddress)}
                    </p>
                    <button
                      onClick={() => setShowFullAddress(!showFullAddress)}
                      className="mt-1 text-xs text-blue-600 hover:text-blue-700"
                    >
                      {showFullAddress ? 'Show less' : 'Show more'}
                    </button>
                  </div>
                </div>
                <div className="p-6">
                  <p className="text-sm font-medium text-gray-500">Balance</p>
                  <p className="mt-1 text-2xl font-semibold text-blue-600">{Number(balance) / 1000000000} SUI</p>
                </div>
              </div>
            </div>
          </div>

          {/* Njangi Circles Section */}
          <div className="mt-8">
            <div className="bg-white shadow rounded-lg p-6">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-medium text-gray-900">My Njangi Circles</h3>
                <div className="flex space-x-3">
                  <button
                    type="button"
                    onClick={() => setIsJoinDialogOpen(true)}
                    className="inline-flex items-center px-4 py-2 border border-blue-600 text-sm font-medium rounded-md shadow-sm text-blue-600 bg-white hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                  >
                    <Users className="w-5 h-5 mr-2" />
                    Join Circle
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push('/create-circle')}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                  >
                    <svg
                      className="w-5 h-5 mr-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                    Create New Circle
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex justify-center items-center py-12">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : error ? (
                <div className="bg-red-50 rounded-lg p-8 text-center">
                  <svg
                    className="mx-auto h-12 w-12 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-red-900">{error}</h3>
                  <p className="mt-1 text-sm text-red-500">Please try again later.</p>
                  <div className="mt-6">
                    <button
                      type="button"
                      onClick={() => fetchUserCircles()}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors duration-200"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              ) : circles.length > 0 ? (
                <div>
                  <Tab.Group>
                    <Tab.List className="flex space-x-1 rounded-xl bg-blue-50 p-1 mb-6">
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        All Circles ({circles.length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        Administering ({circles.filter(c => c.isAdmin).length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        Member Only ({circles.filter(c => !c.isAdmin).length})
                      </Tab>
                    </Tab.List>
                    <Tab.Panels>
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {circles.map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isAdmin ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"}`}>
                                    {circle.isAdmin ? "Admin" : "Member"}
                                  </span>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                  
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => copyShareLink(circle.id)}
                                            className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                                            aria-label="Copy Invite Link"
                                          >
                                            <Link size={14} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Copy Invite Link
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.contributionAmountUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.securityDepositUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">{formatDate(circle.nextPayoutTime)}</p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => {
                                              console.log("Delete button clicked for circle:", circle.id);
                                              try {
                                                deleteCircle(circle.id);
                                              } catch (e) {
                                                console.error("Error in delete button click handler:", e);
                                                toast.error("Error processing delete request");
                                              }
                                            }}
                                            disabled={isDeleting === circle.id}
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Tab.Panel>
                      
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {circles.filter(c => c.isAdmin).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <span className="text-xs font-medium px-2 py-1 rounded-full bg-purple-100 text-purple-800">
                                    Admin
                                  </span>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyShareLink(circle.id)}
                                          className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                                          aria-label="Copy Invite Link"
                                        >
                                          <Link size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Copy Invite Link
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.contributionAmountUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.securityDepositUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">{formatDate(circle.nextPayoutTime)}</p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => {
                                              console.log("Delete button clicked for circle:", circle.id);
                                              try {
                                                deleteCircle(circle.id);
                                              } catch (e) {
                                                console.error("Error in delete button click handler:", e);
                                                toast.error("Error processing delete request");
                                              }
                                            }}
                                            disabled={isDeleting === circle.id}
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Tab.Panel>
                      
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {circles.filter(c => !c.isAdmin).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <span className="text-xs font-medium px-2 py-1 rounded-full bg-blue-100 text-blue-800">
                                    Member
                                  </span>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.contributionAmountUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.securityDepositUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">{formatDate(circle.nextPayoutTime)}</p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => {
                                              console.log("Delete button clicked for circle:", circle.id);
                                              try {
                                                deleteCircle(circle.id);
                                              } catch (e) {
                                                console.error("Error in delete button click handler:", e);
                                                toast.error("Error processing delete request");
                                              }
                                            }}
                                            disabled={isDeleting === circle.id}
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Tab.Panel>
                    </Tab.Panels>
                  </Tab.Group>
                </div>
              ) : (
              <div className="bg-gray-50 rounded-lg p-8 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <h3 className="mt-2 text-sm font-medium text-gray-900">No circles yet</h3>
                <p className="mt-1 text-sm text-gray-500">Get started by creating a new circle or joining an existing one.</p>
                <div className="mt-6 flex justify-center space-x-4">
                  <button
                    type="button"
                    onClick={() => setIsJoinDialogOpen(true)}
                    className="inline-flex items-center justify-center p-3 rounded-full text-blue-600 bg-white border border-blue-600 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    title="Join Existing Circle"
                  >
                    <Users className="w-6 h-6" />
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push('/create-circle')}
                    className="inline-flex items-center justify-center p-3 rounded-full text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    title="Create New Circle"
                  >
                    <svg
                      className="w-6 h-6"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      </main>
      
      {/* Join Circle Dialog */}
      <Dialog.Root open={isJoinDialogOpen} onOpenChange={setIsJoinDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-lg p-6 w-full max-w-md focus:outline-none">
            <div className="flex justify-between items-center mb-4">
              <Dialog.Title className="text-lg font-medium text-gray-900">
                Join a Circle
              </Dialog.Title>
              <Dialog.Close className="text-gray-400 hover:text-gray-500">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>
            
            <form onSubmit={handleJoinCircle}>
              <div className="mt-2">
                <label htmlFor="circleId" className="block text-sm font-medium text-gray-700 mb-1">
                  Enter Circle ID or Invite Link
                </label>
                <input
                  type="text"
                  id="circleId"
                  value={circleIdInput}
                  onChange={(e) => setCircleIdInput(e.target.value)}
                  placeholder="0x123... or full invite link"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Paste the circle ID or the complete invite link to join
                </p>
              </div>
              
              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsJoinDialogOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Join Circle
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
} 