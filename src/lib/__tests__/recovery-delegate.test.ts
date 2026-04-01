import {
  getRecoveryDelegateValidationError,
  normalizeRecoveryDelegateAddress,
} from '@/lib/recovery-delegate';

const VALID_DELEGATE_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000abc';
const VALID_ADMIN_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000123';

describe('recovery delegate helpers', () => {
  it('normalizes a delegate wallet address when valid', () => {
    expect(normalizeRecoveryDelegateAddress(VALID_DELEGATE_ADDRESS)).toBe(VALID_DELEGATE_ADDRESS);
  });

  it('allows an empty delegate when the field is not required', () => {
    expect(
      getRecoveryDelegateValidationError({
        value: '',
        adminAddress: VALID_ADMIN_ADDRESS,
        required: false,
      }),
    ).toBeNull();
  });

  it('requires a delegate when auto-release is enabled', () => {
    expect(
      getRecoveryDelegateValidationError({
        value: '',
        adminAddress: VALID_ADMIN_ADDRESS,
        required: true,
      }),
    ).toBe('Next-in-command wallet address is required when admin liveness fallback is enabled.');
  });

  it('rejects invalid delegate addresses', () => {
    expect(
      getRecoveryDelegateValidationError({
        value: 'not-an-address',
        adminAddress: VALID_ADMIN_ADDRESS,
        required: true,
      }),
    ).toBe('Enter a valid Sui wallet address for the next in command.');
  });

  it('rejects reusing the admin address as delegate', () => {
    expect(
      getRecoveryDelegateValidationError({
        value: VALID_DELEGATE_ADDRESS,
        adminAddress: VALID_DELEGATE_ADDRESS,
        required: true,
      }),
    ).toBe('Next in command must be a different wallet from the admin.');
  });
});
