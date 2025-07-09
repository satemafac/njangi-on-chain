import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { CheckCircle, AlertTriangle, Clock } from 'lucide-react';
import { toast } from 'react-hot-toast';

interface PayoutDetails {
  circleId: string;
  circleName: string;
  currentCycle: number;
  contributionAmount: number;
  currency: string;
  nextRecipient: string;
  overdueTime: string;
  memberCount: number;
  allMembersContributed: boolean;
}

/**
 * 🔐 Admin Payout Approval Page
 * 
 * Secure page for circle admins to approve overdue payouts
 * Accessed via one-click WhatsApp notification links
 */
export default function AdminPayoutApproval() {
  const router = useRouter();
  const { isAuthenticated, userAddress } = useAuth();
  const { id: circleId } = router.query;
  
  const [payoutDetails, setPayoutDetails] = useState<PayoutDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [adminVerified, setAdminVerified] = useState(false);
  const [payoutOverdue, setPayoutOverdue] = useState(false);

  useEffect(() => {
    if (circleId && isAuthenticated && userAddress) {
      verifyAdminAndLoadDetails();
    }
  }, [circleId, isAuthenticated, userAddress]);

  const verifyAdminAndLoadDetails = async () => {
    try {
      setLoading(true);
      
      // 🔗 Step 1: Verify user is admin of this circle (blockchain verification)
      const adminResponse = await fetch(`/api/circles/${circleId}/verify-admin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userAddress
        })
      });

      const adminResult = await adminResponse.json();
      const isAdmin = adminResult.success && adminResult.isAdmin;
      setAdminVerified(isAdmin);
      
      if (!isAdmin) {
        toast.error('You are not the admin of this circle');
        return;
      }

      // 🔗 Step 2: Check if payout is actually overdue (blockchain verification)
      const overdueResponse = await fetch(`/api/circles/${circleId}/payout-status`);
      const overdueResult = await overdueResponse.json();
      const isOverdue = overdueResult.success && overdueResult.isOverdue;
      setPayoutOverdue(isOverdue);
      
      if (!isOverdue) {
        toast.error('This circle does not have an overdue payout');
        return;
      }

      // ✅ Step 3: Both conditions met - load circle details
      const circleResponse = await fetch(`/api/circles/${circleId}`);
      const circleData = await circleResponse.json();
      
      if (circleData.success) {
        setPayoutDetails({
          circleId: circleId as string,
          circleName: circleData.circle.name || `Circle ${circleId}`,
          currentCycle: circleData.circle.current_cycle || 1,
          contributionAmount: 100, // TODO: Get from circle data
          currency: 'USDC',
          nextRecipient: 'Next Member', // TODO: Get actual recipient
          overdueTime: overdueResult.overdueTime || '2 hours',
          memberCount: circleData.circle.member_count || 0,
          allMembersContributed: overdueResult.allMembersContributed || true
        });
        
        setCanApprove(true);
      }
      
    } catch (error) {
      console.error('Error verifying admin and circle status:', error);
      toast.error('Error loading payout information');
      setAdminVerified(false);
      setPayoutOverdue(false);
      setCanApprove(false);
    } finally {
      setLoading(false);
    }
  };

  const handleApprovePayoutxecute = async () => {
    if (!payoutDetails || !userAddress) {
      toast.error('Missing required information for payout approval');
      return;
    }

    try {
      setProcessing(true);
      toast.loading('Processing payout approval...');

      // Call the existing circle management API to trigger payout
      const response = await fetch(`/api/circles/${circleId}/trigger-payout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          adminAddress: userAddress
        })
      });

      const result = await response.json();
      
      if (result.success) {
        toast.dismiss();
        toast.success('✅ Payout approved and executed successfully!');
        
        // Show success details
        setTimeout(() => {
          router.push(`/circle/${circleId}?payout=success&tx=${result.transactionHash}`);
        }, 2000);
        
      } else {
        toast.dismiss();
        toast.error(`Failed to execute payout: ${result.error}`);
      }
      
    } catch (error) {
      toast.dismiss();
      console.error('Error executing payout:', error);
      toast.error('Error processing payout approval');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeny = () => {
    toast.success('Payout approval denied');
    router.push(`/circle/${circleId}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 text-center">Verifying admin status and payout requirements...</p>
        </div>
      </div>
    );
  }

  if (!loading && (!adminVerified || !payoutOverdue)) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md mx-auto">
          <div className="text-center">
            <AlertTriangle className="h-16 w-16 text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {!adminVerified ? 'Access Denied' : 'No Overdue Payout'}
            </h1>
            <p className="text-gray-600 mb-6">
              {!adminVerified 
                ? 'You are not the admin of this circle or need to authenticate with your wallet.'
                : 'This circle does not currently have an overdue payout that requires approval.'
              }
            </p>
            <button
              onClick={() => router.push('/dashboard')}
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg shadow-md max-w-md mx-auto">
          <div className="text-center">
            <Clock className="h-16 w-16 text-orange-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Authentication Required</h1>
            <p className="text-gray-600 mb-6">
              Please log in with your Sui wallet to approve this payout.
            </p>
            <button
              onClick={() => router.push('/auth')}
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Login with Wallet
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-md p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="bg-orange-100 rounded-full p-3 w-16 h-16 mx-auto mb-4">
              <Clock className="w-10 h-10 text-orange-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              Payout Approval Required
            </h1>
            <p className="text-gray-600">
              Your circle has an overdue payout that needs your approval
            </p>
          </div>

          {/* Payout Details */}
          {payoutDetails && (
            <div className="space-y-6 mb-8">
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                <div className="flex items-center mb-2">
                  <AlertTriangle className="h-5 w-5 text-orange-600 mr-2" />
                  <span className="text-orange-800 font-semibold">
                    Payout is {payoutDetails.overdueTime} overdue
                  </span>
                </div>
                <p className="text-orange-700 text-sm">
                  This payout was scheduled to happen automatically but requires your manual approval.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-50 p-4 rounded-lg">
                  <h3 className="font-semibold text-gray-900 mb-2">Circle Details</h3>
                  <div className="space-y-1 text-sm text-gray-600">
                    <p><span className="font-medium">Name:</span> {payoutDetails.circleName}</p>
                    <p><span className="font-medium">Cycle:</span> {payoutDetails.currentCycle}</p>
                    <p><span className="font-medium">Members:</span> {payoutDetails.memberCount}</p>
                  </div>
                </div>

                <div className="bg-gray-50 p-4 rounded-lg">
                  <h3 className="font-semibold text-gray-900 mb-2">Payout Details</h3>
                  <div className="space-y-1 text-sm text-gray-600">
                    <p><span className="font-medium">Amount:</span> {payoutDetails.contributionAmount} {payoutDetails.currency}</p>
                    <p><span className="font-medium">Recipient:</span> {payoutDetails.nextRecipient}</p>
                    <p><span className="font-medium">All Contributed:</span> {payoutDetails.allMembersContributed ? '✅ Yes' : '❌ No'}</p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="border-t pt-6">
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <button
                    onClick={handleApprovePayoutxecute}
                    disabled={processing || !canApprove}
                    className="bg-green-600 text-white px-8 py-3 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    <CheckCircle className="h-5 w-5 mr-2" />
                    {processing ? 'Processing...' : 'Approve & Execute Payout'}
                  </button>
                  
                  <button
                    onClick={handleDeny}
                    disabled={processing}
                    className="bg-gray-500 text-white px-8 py-3 rounded-lg hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Deny Approval
                  </button>
                </div>
                
                <p className="text-xs text-gray-500 text-center mt-4">
                  This approval will trigger the payout using your connected wallet
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 