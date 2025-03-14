import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  securityDeposit: number;
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
}

// Define a type for the fields from the SUI object
interface CircleFields {
  name: string;
  admin: string;
  contribution_amount: string;
  security_deposit: string;
  cycle_length: string;
  cycle_day: string;
  max_members: string;
  current_members: string;
  next_payout_time: string;
  [key: string]: string | number | boolean | object;
}

export default function JoinCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [isMember, setIsMember] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    // Fetch circle details when ID is available
    if (id && userAddress) {
      fetchCircleDetails();
    }
  }, [id, userAddress]);

  const fetchCircleDetails = async () => {
    if (!id) return;
    
    setLoading(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get circle object
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true }
      });
      
      if (objectData.data?.content && 'fields' in objectData.data.content) {
        const fields = objectData.data.content.fields as CircleFields;
        
        // Check if user is already a member (simplified check)
        const isAdmin = fields.admin === userAddress;
        
        // This is a simplified check - in reality you'd check members array from the contract
        const checkMembership = isAdmin; // For now, only admin is confirmed to be a member
        setIsMember(checkMembership);
        
        // If already a member, redirect to circle view
        if (checkMembership) {
          toast('You are already a member of this circle');
          router.push(`/circle/${id}`);
          return;
        }
        
        setCircle({
          id: id as string,
          name: fields.name,
          admin: fields.admin,
          contributionAmount: Number(fields.contribution_amount) / 1e9,
          securityDeposit: Number(fields.security_deposit) / 1e9,
          cycleLength: Number(fields.cycle_length),
          cycleDay: Number(fields.cycle_day),
          maxMembers: Number(fields.max_members),
          currentMembers: Number(fields.current_members),
          nextPayoutTime: Number(fields.next_payout_time),
        });
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinCircle = async () => {
    if (!circle || !userAddress) return;
    
    setIsJoining(true);
    try {
      toast.success('This page is under construction! Join functionality coming soon.');
      // Implementation will go here in the future
    } catch (error) {
      console.error('Error joining circle:', error);
      toast.error('Failed to join the circle');
    } finally {
      setIsJoining(false);
    }
  };

  // Format cycle info
  const formatCycleInfo = (cycleLength: number, cycleDay: number) => {
    // Cycle length: 0 = weekly, 1 = monthly, 2 = quarterly
    let cyclePeriod = '';
    let dayFormat = '';
    
    switch (cycleLength) {
      case 0: // Weekly
        cyclePeriod = 'Weekly';
        // The Move contract uses 0 = Sunday, 1 = Monday, etc.
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        dayFormat = weekdays[cycleDay % 7]; // Ensure we don't go out of bounds
        break;
      case 1: // Monthly
        cyclePeriod = 'Monthly';
        // In your specific case, default to 1st day when we see 0
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

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
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
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <button
              onClick={() => router.push('/dashboard')}
              className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back to Dashboard
            </button>
          </div>

          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">
                Join Circle
              </h2>
              {loading ? (
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 space-y-6">
                  <div>
                    <p className="text-sm text-gray-500">Circle Name</p>
                    <p className="text-lg font-medium">{circle.name}</p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <p className="text-sm text-gray-500">Contribution Amount</p>
                      <p className="text-lg font-medium">{circle.contributionAmount} SUI</p>
                    </div>
                    
                    <div>
                      <p className="text-sm text-gray-500">Security Deposit</p>
                      <p className="text-lg font-medium">{circle.securityDeposit} SUI</p>
                    </div>
                    
                    <div>
                      <p className="text-sm text-gray-500">Contribution Schedule</p>
                      <p className="text-lg font-medium">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                    </div>
                    
                    <div>
                      <p className="text-sm text-gray-500">Members</p>
                      <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                    </div>
                  </div>
                  
                  <div className="border-t border-gray-200 pt-6 mt-6">
                    <div className="bg-yellow-50 p-4 rounded-md mb-6">
                      <p className="text-sm text-yellow-800">
                        By joining this circle, you agree to contribute {circle.contributionAmount} SUI {formatCycleInfo(circle.cycleLength, circle.cycleDay).toLowerCase()}. You will also need to pay a security deposit of {circle.securityDeposit} SUI.
                      </p>
                    </div>
                    
                    <button
                      onClick={handleJoinCircle}
                      disabled={isJoining || isMember}
                      className={`w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${(isJoining || isMember) ? 'opacity-70 cursor-not-allowed' : ''}`}
                    >
                      {isJoining ? 'Processing...' : isMember ? 'Already a Member' : 'Join Circle'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center">
                  <p className="text-gray-500">Circle not found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
} 