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

// Assuming we'll need a Member type as well
interface Member {
  address: string;
  joinDate?: number;
  status: 'active' | 'suspended' | 'exited';
}

export default function ManageCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

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
        
        const adminAddress = fields.admin;
        
        // If not admin, redirect to view-only page
        if (adminAddress !== userAddress) {
          toast.error('Only the admin can manage this circle');
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
        
        // This would be a separate call to get members
        // For now, just create a placeholder with the admin
        setMembers([
          {
            address: fields.admin,
            joinDate: Date.now(), // This would be fetched from the chain
            status: 'active'
          }
        ]);
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const shortenAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
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
                Manage Circle
              </h2>
              {loading ? (
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 space-y-8">
                  {/* Circle Details */}
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Circle Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <p className="text-sm text-gray-500">Circle Name</p>
                        <p className="text-lg font-medium">{circle.name}</p>
                      </div>
                      
                      <div>
                        <p className="text-sm text-gray-500">Contribution Amount</p>
                        <p className="text-lg font-medium">{circle.contributionAmount} SUI</p>
                      </div>
                      
                      <div>
                        <p className="text-sm text-gray-500">Security Deposit</p>
                        <p className="text-lg font-medium">{circle.securityDeposit} SUI</p>
                      </div>
                      
                      <div>
                        <p className="text-sm text-gray-500">Members</p>
                        <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Members Management */}
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Members</h3>
                    <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                      <table className="min-w-full divide-y divide-gray-300">
                        <thead className="bg-gray-50">
                          <tr>
                            <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                              Address
                            </th>
                            <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                              Status
                            </th>
                            <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                              Joined
                            </th>
                            <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 bg-white">
                          {members.map((member) => (
                            <tr key={member.address}>
                              <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">
                                {shortenAddress(member.address)} {member.address === circle.admin && <span className="text-xs text-purple-600 ml-2">(Admin)</span>}
                              </td>
                              <td className="whitespace-nowrap px-3 py-4 text-sm">
                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                  member.status === 'active' ? 'bg-green-100 text-green-800' : 
                                  member.status === 'suspended' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
                                }`}>
                                  {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                                {member.joinDate ? formatDate(member.joinDate) : 'Unknown'}
                              </td>
                              <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                                {/* No actions for admin */}
                                {member.address !== circle.admin && (
                                  <button
                                    className="text-red-600 hover:text-red-900"
                                    onClick={() => toast.success('Member removal coming soon')}
                                  >
                                    Remove
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  
                  {/* Invite Members */}
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Invite New Members</h3>
                    <p className="mb-4 text-sm text-gray-500">Send the following link to people you&apos;d like to invite to your circle.</p>
                    
                    <div className="flex items-center space-x-2 bg-gray-50 p-3 rounded-md">
                      <input
                        type="text"
                        readOnly
                        value={`${window.location.origin}/circle/${circle.id}/join`}
                        className="flex-1 p-2 bg-transparent text-gray-800 border-0 focus:ring-0"
                      />
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/circle/${circle.id}/join`);
                          toast.success('Invite link copied to clipboard');
                        }}
                        className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  
                  {/* Circle Management Actions */}
                  <div className="pt-6 border-t border-gray-200">
                    <div className="flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0">
                      <button
                        onClick={() => toast.success('This feature is coming soon')}
                        className="px-4 py-2 bg-yellow-500 text-white rounded-md text-sm hover:bg-yellow-600"
                      >
                        Pause Contributions
                      </button>
                      
                      <button
                        onClick={() => {
                          // Handle delete circle
                          toast.success('This feature is coming soon');
                        }}
                        className="px-4 py-2 bg-red-600 text-white rounded-md text-sm hover:bg-red-700"
                      >
                        Delete Circle
                      </button>
                    </div>
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