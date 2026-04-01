import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

export function normalizeRecoveryDelegateAddress(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const lowercaseValue = trimmedValue.toLowerCase();
  const prefixedValue = lowercaseValue.startsWith('0x') ? lowercaseValue : `0x${lowercaseValue}`;

  if (!isValidSuiAddress(prefixedValue)) {
    return null;
  }

  return normalizeSuiAddress(prefixedValue);
}

export function getRecoveryDelegateValidationError(args: {
  value: string | null | undefined;
  adminAddress?: string | null | undefined;
  required: boolean;
}): string | null {
  const { value, adminAddress, required } = args;
  const trimmedValue = typeof value === 'string' ? value.trim() : '';

  if (!trimmedValue) {
    return required
      ? 'Next-in-command wallet address is required when admin liveness fallback is enabled.'
      : null;
  }

  const normalizedDelegate = normalizeRecoveryDelegateAddress(trimmedValue);
  if (!normalizedDelegate) {
    return 'Enter a valid Sui wallet address for the next in command.';
  }

  const normalizedAdmin = normalizeRecoveryDelegateAddress(adminAddress ?? null);
  if (normalizedAdmin && normalizedDelegate === normalizedAdmin) {
    return 'Next in command must be a different wallet from the admin.'
  }

  return null;
}
