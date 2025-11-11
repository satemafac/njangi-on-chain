/**
 * 📱 WhatsApp Circle Integration Component
 * 
 * Seamlessly integrated WhatsApp management for circle admins
 * - Link/unlink circles to WhatsApp
 * - Select individual or group chat
 * - View WhatsApp status
 * - No additional login required
 */

import React, { useState, useEffect } from 'react';
import { MessageCircle, Link as LinkIcon, Unlink, Loader } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { AccountData } from '@/services/zkLoginService';
import { getCurrentNetwork } from '@/services/network-config';
import ConfirmationModal from './ConfirmationModal';

interface WhatsAppIntegrationProps {
  circleId: string;
  adminAddress: string;
  account: AccountData;  // Full zkLogin account data
  onLinked?: (status: boolean) => void;
}

interface LinkedStatus {
  isLinked: boolean;
  linkType?: 1 | 2; // 1 = individual, 2 = group
  recipient?: string;
  linkedAt?: string;
}

// Validation functions
const validatePhoneNumber = (phone: string): { valid: boolean; error?: string } => {
  const trimmed = phone.trim();
  
  // Check if empty
  if (!trimmed) {
    return { valid: false, error: 'Phone number is required' };
  }
  
  // Must start with +
  if (!trimmed.startsWith('+')) {
    return { valid: false, error: 'Phone number must start with + (e.g., +1234567890)' };
  }
  
  // Remove + for digit check
  const digitsOnly = trimmed.substring(1);
  
  // Must contain only digits
  if (!/^\d+$/.test(digitsOnly)) {
    return { valid: false, error: 'Phone number must contain only digits after +' };
  }
  
  // Check length (most E.164 numbers are 7-15 digits)
  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    return { valid: false, error: 'Phone number must be 7-15 digits long' };
  }
  
  return { valid: true };
};

const validateGroupId = (groupId: string): { valid: boolean; error?: string } => {
  const trimmed = groupId.trim();
  
  // Check if empty
  if (!trimmed) {
    return { valid: false, error: 'Group ID is required' };
  }
  
  // Must end with @g.us (WhatsApp group format - universal across all regions)
  if (!trimmed.endsWith('@g.us')) {
    return { valid: false, error: 'Group ID must end with @g.us' };
  }
  
  // Extract the part before @g.us
  const groupPart = trimmed.substring(0, trimmed.length - 5);
  
  // WhatsApp supports two formats:
  // Format 1: XXXXXXXXXX-XXXXXXXXXX@g.us (timestamp-creation ID)
  // Format 2: XXXXXXXXXXXXXXXXX@g.us (single long ID)
  
  // Check if it's format 1 (with hyphen)
  if (groupPart.includes('-')) {
    // Must be numbers-numbers
    if (!/^\d+-\d+$/.test(groupPart)) {
      return { valid: false, error: 'Group ID format should be: numbers-numbers@g.us' };
    }
    
    const parts = groupPart.split('-');
    const [part1, part2] = parts;
    
    // Each part should be reasonably sized
    if (part1.length < 5 || part1.length > 20 || part2.length < 5 || part2.length > 20) {
      return { valid: false, error: 'Group ID parts should be 5-20 digits each' };
    }
  } else {
    // Format 2: single long ID (must be all digits)
    if (!/^\d+$/.test(groupPart)) {
      return { valid: false, error: 'Group ID must contain only digits' };
    }
    
    // Should be 10-20 digits for a single format
    if (groupPart.length < 10 || groupPart.length > 20) {
      return { valid: false, error: 'Group ID should be 10-20 digits (or use timestamp-ID format)' };
    }
  }
  
  return { valid: true };
};

const getValidationError = (linkType: 1 | 2, value: string): string | null => {
  if (linkType === 1) {
    const result = validatePhoneNumber(value);
    return result.error || null;
  } else {
    const result = validateGroupId(value);
    return result.error || null;
  }
};

const WhatsAppCircleIntegration: React.FC<WhatsAppIntegrationProps> = ({
  circleId,
  adminAddress,
  account,
  onLinked
}) => {
  const [linkedStatus, setLinkedStatus] = useState<LinkedStatus>({ isLinked: false });
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  
  const [linkType, setLinkType] = useState<1 | 2>(1);
  const [phoneOrGroup, setPhoneOrGroup] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Fetch current link status
  useEffect(() => {
    checkLinkStatus();
  }, [circleId]);

  const checkLinkStatus = async () => {
    try {
      setLoading(true);
      
      // Get current network selection
      const currentNetwork = getCurrentNetwork();
      
      // Query the API to check if circle is linked on blockchain
      const response = await fetch(`/api/whatsapp/admin-link-circle?circleId=${circleId}&network=${currentNetwork}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.data?.isLinked) {
          setLinkedStatus({
            isLinked: true,
            linkType: data.data.linkType,
            recipient: data.data.recipient,
            linkedAt: data.data.linkedAt
          });
        } else {
          setLinkedStatus({ isLinked: false });
        }
      } else {
        // Assume not linked if query fails
        setLinkedStatus({ isLinked: false });
      }
    } catch (error) {
      console.error('Error checking link status:', error);
      // Default to not linked on error
      setLinkedStatus({ isLinked: false });
    } finally {
      setLoading(false);
    }
  };

  const handleLinkCircle = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      setValidationError(null);
      setLinking(true);

      if (!phoneOrGroup.trim()) {
        const error = `${linkType === 1 ? 'Phone number' : 'Group ID'} is required`;
        setValidationError(error);
        toast.error(error);
        setLinking(false);
        return;
      }

      // Validate input
      const error = getValidationError(linkType, phoneOrGroup);
      if (error) {
        setValidationError(error);
        toast.error(error);
        setLinking(false);
        return;
      }

      // Get current network selection
      const currentNetwork = getCurrentNetwork();

      // Call admin-link-circle endpoint with full zkLogin account for transaction signing
      const response = await fetch('/api/whatsapp/admin-link-circle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          circleId,
          linkType,
          phoneOrGroup: phoneOrGroup.trim(),
          adminAddress,
          network: currentNetwork,
          account: {
            provider: account.provider,
            userAddr: account.userAddr,
            zkProofs: account.zkProofs,
            ephemeralPrivateKey: account.ephemeralPrivateKey,
            userSalt: account.userSalt,
            sub: account.sub,
            aud: account.aud,
            maxEpoch: account.maxEpoch
          }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Failed to link circle');
        return;
      }

      toast.success('✅ Circle linked to WhatsApp successfully!');
      setLinkedStatus({
        isLinked: true,
        linkType,
        recipient: phoneOrGroup,
        linkedAt: new Date().toISOString()
      });
      setShowLinkForm(false);
      setPhoneOrGroup('');
      setValidationError(null);
      onLinked?.(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to link circle');
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkCircle = async () => {
    try {
      setLinking(true);

      // Get current network selection
      const currentNetwork = getCurrentNetwork();

      // Call unlink endpoint
      const response = await fetch('/api/whatsapp/admin-unlink-circle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          circleId,
          adminAddress,
          network: currentNetwork,
          account: {
            provider: account.provider,
            userAddr: account.userAddr,
            zkProofs: account.zkProofs,
            ephemeralPrivateKey: account.ephemeralPrivateKey,
            userSalt: account.userSalt,
            sub: account.sub,
            aud: account.aud,
            maxEpoch: account.maxEpoch
          }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Failed to unlink circle');
        return;
      }

      toast.success('✅ Circle unlinked from WhatsApp');
      setLinkedStatus({ isLinked: false });
      setShowUnlinkConfirm(false);
      onLinked?.(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to unlink circle');
    } finally {
      setLinking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-4">
        <Loader className="animate-spin w-5 h-5 text-blue-600" />
        <span className="ml-2 text-sm text-gray-600">Checking WhatsApp status...</span>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg p-4 border border-green-200">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <MessageCircle className="w-5 h-5 text-green-600" />
          <h3 className="font-semibold text-gray-900">WhatsApp Integration</h3>
        </div>
        {linkedStatus.isLinked && (
          <span className="bg-green-100 text-green-800 px-3 py-1 rounded-full text-xs font-medium">
            ✅ Linked
          </span>
        )}
      </div>

      {linkedStatus.isLinked ? (
        // Show linked status
        <div className="space-y-3">
          <div className="bg-white rounded p-3 space-y-2">
            <p className="text-sm text-gray-600">
              <strong>Link Type:</strong> {linkedStatus.linkType === 1 ? '📱 Individual' : '👥 Group'}
            </p>
            <p className="text-sm text-gray-600">
              <strong>Recipient:</strong> {linkedStatus.recipient}
            </p>
            {linkedStatus.linkedAt && (
              <p className="text-xs text-gray-500">
                Linked on: {new Date(linkedStatus.linkedAt).toLocaleDateString()}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm text-gray-700">
              ✨ This circle will receive WhatsApp notifications for:
            </p>
            <ul className="text-xs text-gray-600 space-y-1 ml-4">
              <li>✓ New cycle started</li>
              <li>✓ Member contributions</li>
              <li>✓ Deadline reminders</li>
              <li>✓ Payout notifications</li>
            </ul>
          </div>

          <button
            onClick={() => setShowUnlinkConfirm(true)}
            disabled={linking}
            className="w-full px-4 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 transition flex items-center justify-center text-sm font-medium disabled:opacity-60"
          >
            {linking ? (
              <>
                <Loader className="w-4 h-4 mr-2 animate-spin" />
                Unlinking...
              </>
            ) : (
              <>
                <Unlink className="w-4 h-4 mr-2" />
                Unlink from WhatsApp
              </>
            )}
          </button>
        </div>
      ) : (
        // Show link form
        <div className="space-y-3">
          {!showLinkForm ? (
            <button
              onClick={() => setShowLinkForm(true)}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center justify-center text-sm font-medium"
            >
              <LinkIcon className="w-4 h-4 mr-2" />
              Link to WhatsApp
            </button>
          ) : (
            <form onSubmit={handleLinkCircle} className="space-y-3 bg-white p-3 rounded">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Chat Type
                </label>
                <select
                  value={linkType}
                  onChange={(e) => {
                    setLinkType(parseInt(e.target.value) as 1 | 2);
                    setPhoneOrGroup('');
                    setValidationError(null);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value={1}>📱 Individual (Phone Number)</option>
                  <option value={2}>👥 Group Chat (Group ID)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {linkType === 1 ? 'Phone Number' : 'Group ID'}
                </label>
                <input
                  type="text"
                  value={phoneOrGroup}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setPhoneOrGroup(newValue);
                    // Real-time validation
                    if (newValue.trim()) {
                      const error = getValidationError(linkType, newValue);
                      setValidationError(error);
                    } else {
                      setValidationError(null);
                    }
                  }}
                  placeholder={linkType === 1 ? '+1234567890' : '123456789-1234567890@g.us or 120363043968066561@g.us'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                  disabled={linking}
                />
                {validationError && (
                  <p className="text-xs text-red-500 mt-1">{validationError}</p>
                )}
              </div>

              <div className="bg-blue-50 border border-blue-200 p-2 rounded text-xs text-blue-700 space-y-1">
                <p>💡 <strong>Tip:</strong> Circle admins will receive WhatsApp notifications for circle events.</p>
                <p className="text-xs text-blue-600">Group ID formats: <code className="bg-blue-100 px-1 rounded">123456789-1234567890@g.us</code> or <code className="bg-blue-100 px-1 rounded">120363043968066561@g.us</code></p>
              </div>

              <div className="flex space-x-2">
                <button
                  type="submit"
                  disabled={linking || !phoneOrGroup.trim() || !!validationError}
                  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center"
                >
                  {linking ? (
                    <>
                      <Loader className="w-4 h-4 mr-2 animate-spin" />
                      Linking...
                    </>
                  ) : (
                    <>
                      <LinkIcon className="w-4 h-4 mr-2" />
                      Link Circle
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLinkForm(false);
                    setPhoneOrGroup('');
                    setValidationError(null);
                  }}
                  disabled={linking}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm font-medium disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      <ConfirmationModal
        isOpen={showUnlinkConfirm}
        onClose={() => setShowUnlinkConfirm(false)}
        onConfirm={handleUnlinkCircle}
        title="Confirm Unlink"
        message="Are you sure you want to unlink this circle from WhatsApp? This action cannot be undone."
        confirmText="Unlink"
        cancelText="Cancel"
      />
    </div>
  );
};

export default WhatsAppCircleIntegration;
