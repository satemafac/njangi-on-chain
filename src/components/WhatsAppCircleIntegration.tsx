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
import { ZkLoginClient } from '@/services/zkLoginClient';
import { getCurrentNetwork } from '@/services/network-config';
import ConfirmationModal from './ConfirmationModal';
import BillingUpsellModal, {
  parseUpgradeRequired,
  type UpgradeRequiredDetails,
} from './BillingUpsellModal';
import { humanizeErrorMessage } from '@/lib/user-error-messages';
import PhoneInput, { isValidPhoneNumber } from 'react-phone-number-input';
import 'react-phone-number-input/style.css';

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
const validatePhoneNumber = (phone: string | undefined): { valid: boolean; error?: string } => {
  if (!phone) {
    return { valid: false, error: 'Phone number is required' };
  }
  
  // Use the library's validation
  if (!isValidPhoneNumber(phone)) {
    return { valid: false, error: 'Please enter a valid phone number' };
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
  // WhatsApp linking is a premium feature — a 402 opens the upsell
  // modal instead of toasting the raw UPGRADE_REQUIRED code.
  const [upsell, setUpsell] = useState<UpgradeRequiredDetails | null>(null);

  // Fetch current link status
  useEffect(() => {
    checkLinkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Step 1 — the server encrypts the phone number into Walrus and returns
      // the anchor inputs. It is NOT sent any signing material: this request
      // used to carry `account.ephemeralPrivateKey` (plus zkProofs, salt, sub
      // and aud), which let the server sign anything for this address until
      // the epoch rolled. The key stays in this tab now.
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
        })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('Failed to link circle:', data);
        const upgrade = parseUpgradeRequired(data);
        if (upgrade) {
          setUpsell(upgrade);
          return;
        }
        toast.error(humanizeErrorMessage(data.error, 'Failed to link circle'));
        return;
      }

      // Step 2 — sign the on-chain anchor locally.
      const prepared = data.data as {
        packageId: string;
        registryObjectId: string;
        walrusBlobId: string;
        linkNonceHex: string;
        walrusEndEpoch?: number;
      };
      const linkNonce = Uint8Array.from(
        (prepared.linkNonceHex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
      );

      let anchoredDigest: string;
      try {
        const signed = await new ZkLoginClient().linkCircleToWhatsApp(account, {
          packageId: prepared.packageId,
          registryObjectId: prepared.registryObjectId,
          circleId,
          linkType,
          walrusBlobId: prepared.walrusBlobId,
          linkNonce,
          network: currentNetwork,
        });
        anchoredDigest = signed.digest;
      } catch (signErr) {
        toast.error(
          humanizeErrorMessage(
            signErr instanceof Error ? signErr.message : undefined,
            'Could not sign the on-chain link. Your number was not linked.',
          ),
        );
        return;
      }

      // Step 3 — tell the server the anchor landed so the webhook index is
      // written only for links that actually exist on chain.
      await fetch('/api/whatsapp/admin-link-circle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circleId,
          linkType,
          phoneOrGroup: phoneOrGroup.trim(),
          adminAddress,
          network: currentNetwork,
          anchoredDigest,
          walrusBlobId: prepared.walrusBlobId,
          walrusEndEpoch: prepared.walrusEndEpoch,
        }),
      }).catch((indexErr) => {
        // The link exists on chain; a failed index write degrades routing
        // but must not report failure to the admin.
        console.warn('Link anchored but index confirmation failed', indexErr);
      });

      toast.success('✅ Circle linked to WhatsApp successfully!');
      setShowLinkForm(false);
      setPhoneOrGroup('');
      setValidationError(null);
      onLinked?.(true);
      
      // Wait a bit for blockchain indexing, then refresh status from chain
      console.log('⏳ Waiting for blockchain indexing before refreshing status...');
      setTimeout(() => {
        console.log('🔄 Refreshing WhatsApp link status from blockchain...');
        checkLinkStatus();
      }, 2000);
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

      // Step 1 — ask for the anchor inputs. No signing material is sent.
      const response = await fetch('/api/whatsapp/admin-unlink-circle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          circleId,
          adminAddress,
          network: currentNetwork,
        })
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Failed to unlink circle');
        return;
      }

      // Step 2 — sign the unlink locally, then confirm so the index is dropped.
      const prepared = data.data as { packageId: string; registryObjectId: string };
      let anchoredDigest: string;
      try {
        const signed = await new ZkLoginClient().unlinkCircleFromWhatsApp(account, {
          packageId: prepared.packageId,
          registryObjectId: prepared.registryObjectId,
          circleId,
          network: currentNetwork,
        });
        anchoredDigest = signed.digest;
      } catch (signErr) {
        toast.error(
          humanizeErrorMessage(
            signErr instanceof Error ? signErr.message : undefined,
            'Could not sign the unlink. The circle is still linked.',
          ),
        );
        return;
      }

      await fetch('/api/whatsapp/admin-unlink-circle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circleId,
          adminAddress,
          network: currentNetwork,
          anchoredDigest,
        }),
      }).catch((indexErr) => {
        console.warn('Unlink anchored but index confirmation failed', indexErr);
      });

      toast.success('✅ Circle unlinked from WhatsApp');
      setShowUnlinkConfirm(false);
      onLinked?.(false);
      
      // Wait a bit for blockchain indexing, then refresh status from chain
      console.log('⏳ Waiting for blockchain indexing before refreshing status...');
      setTimeout(() => {
        console.log('🔄 Refreshing WhatsApp link status from blockchain...');
        checkLinkStatus();
      }, 2000);
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
    <div className="space-y-4">
      <div className="mb-3 flex flex-col gap-2 sm:mb-4 sm:flex-row sm:items-center sm:justify-between">
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-[18px] border border-green-200 bg-green-50/70 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-green-700">Link Type</p>
              <p className="mt-2 text-lg font-semibold text-gray-900">
                {linkedStatus.linkType === 1 ? '📱 Individual' : '👥 Group'}
              </p>
            </div>
            <div className="rounded-[18px] border border-stone-200 bg-white p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Recipient</p>
              <p className="mt-2 break-all text-lg font-semibold text-gray-900">{linkedStatus.recipient}</p>
              {linkedStatus.linkedAt && (
                <p className="mt-2 text-xs text-gray-500">
                  Linked on: {new Date(linkedStatus.linkedAt).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>

          <div className="rounded-[18px] bg-gradient-to-r from-green-50 to-emerald-50 p-3">
            <p className="text-sm text-gray-700">
              ✨ This circle will receive WhatsApp notifications for:
            </p>
            <ul className="mt-3 space-y-1 pl-4 text-xs text-gray-600">
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
            <form
              onSubmit={handleLinkCircle}
              className="space-y-3 rounded-[18px] border border-green-200 bg-gradient-to-r from-green-50/70 to-emerald-50/70 p-3 sm:p-4"
            >
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
                {linkType === 1 ? (
                  <div className="phone-input-wrapper">
                    <PhoneInput
                      international
                      countryCallingCodeEditable={false}
                      defaultCountry="US"
                      value={phoneOrGroup}
                      onChange={(value) => {
                        setPhoneOrGroup(value || '');
                        // Real-time validation
                        if (value) {
                          const error = getValidationError(linkType, value);
                          setValidationError(error);
                        } else {
                          setValidationError(null);
                        }
                      }}
                      disabled={linking}
                      className="phone-input-custom"
                    />
                    <style jsx global>{`
                      .phone-input-wrapper .PhoneInput {
                        display: flex;
                        flex-direction: column;
                        align-items: stretch;
                        gap: 10px;
                      }
                      @media (min-width: 640px) {
                        .phone-input-wrapper .PhoneInput {
                          flex-direction: row;
                          align-items: center;
                          gap: 8px;
                        }
                      }
                      .phone-input-wrapper .PhoneInputCountry {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        width: 100%;
                        padding: 8px 12px;
                        background: #f9fafb;
                        border: 1px solid #d1d5db;
                        border-radius: 8px;
                        cursor: pointer;
                        transition: all 0.2s;
                      }
                      @media (min-width: 640px) {
                        .phone-input-wrapper .PhoneInputCountry {
                          justify-content: flex-start;
                          width: auto;
                        }
                      }
                      .phone-input-wrapper .PhoneInputCountry:hover {
                        background: #f3f4f6;
                        border-color: #9ca3af;
                      }
                      .phone-input-wrapper .PhoneInputCountryIcon {
                        width: 24px;
                        height: 18px;
                        border-radius: 2px;
                        overflow: hidden;
                        box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                      }
                      .phone-input-wrapper .PhoneInputCountryIcon--border {
                        background-color: transparent;
                        box-shadow: none;
                      }
                      .phone-input-wrapper .PhoneInputCountrySelectArrow {
                        margin-left: 8px;
                        width: 8px;
                        height: 8px;
                        border-style: solid;
                        border-color: #6b7280;
                        border-width: 0 2px 2px 0;
                        transform: rotate(45deg);
                        opacity: 0.7;
                      }
                      .phone-input-wrapper .PhoneInputInput {
                        flex: 1;
                        width: 100%;
                        min-width: 0;
                        padding: 10px 14px;
                        border: 1px solid #d1d5db;
                        border-radius: 8px;
                        font-size: 15px;
                        outline: none;
                        transition: all 0.2s;
                      }
                      .phone-input-wrapper .PhoneInputInput:focus {
                        border-color: #22c55e;
                        box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.1);
                      }
                      .phone-input-wrapper .PhoneInputInput:disabled {
                        background: #f9fafb;
                        cursor: not-allowed;
                      }
                      .phone-input-wrapper .PhoneInputInput::placeholder {
                        color: #9ca3af;
                      }
                      .phone-input-wrapper .PhoneInputCountrySelect {
                        position: absolute;
                        top: 0;
                        left: 0;
                        height: 100%;
                        width: 100%;
                        z-index: 1;
                        border: 0;
                        opacity: 0;
                        cursor: pointer;
                      }
                      .phone-input-wrapper .PhoneInputCountrySelect option {
                        padding: 8px;
                      }
                    `}</style>
                  </div>
                ) : (
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
                    placeholder="123456789-1234567890@g.us or 120363043968066561@g.us"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                    disabled={linking}
                  />
                )}
                {validationError && (
                  <p className="text-xs text-red-500 mt-1">{validationError}</p>
                )}
              </div>

              <div className="rounded-[16px] bg-blue-50 p-3 text-xs text-blue-700 space-y-1">
                <p>💡 <strong>Tip:</strong> Circle admins will receive WhatsApp notifications for circle events.</p>
                <p className="text-xs text-blue-600">Group ID formats: <code className="bg-blue-100 px-1 rounded">123456789-1234567890@g.us</code> or <code className="bg-blue-100 px-1 rounded">120363043968066561@g.us</code></p>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row">
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

      {/* Premium upsell when WhatsApp linking is not on the caller's plan */}
      <BillingUpsellModal
        open={!!upsell}
        onClose={() => setUpsell(null)}
        feature={upsell?.feature ?? 'whatsappSuite'}
        message={upsell?.message}
      />
    </div>
  );
};

export default WhatsAppCircleIntegration;
