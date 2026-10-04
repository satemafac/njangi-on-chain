import {
  GENERIC_USER_ERROR,
  humanizeErrorMessage,
  looksLikeMachineCode,
  moveAbortUserMessage,
} from '@/lib/user-error-messages';

describe('looksLikeMachineCode', () => {
  it('flags SCREAMING_SNAKE codes', () => {
    expect(looksLikeMachineCode('UPGRADE_REQUIRED')).toBe(true);
    expect(looksLikeMachineCode('OBJECT_ALREADY_DELETED')).toBe(true);
  });

  it('flags Move-style abort names and dumps', () => {
    expect(looksLikeMachineCode('EWalletHasBalance')).toBe(true);
    expect(
      looksLikeMachineCode(
        'MoveAbort(MoveLocation { module: ModuleId { address: 0x1, name: Identifier("njangi_circles") }, function: 3, instruction: 9, function_name: Some("admin_set_max_members") }, 29)',
      ),
    ).toBe(true);
  });

  it('does not flag human sentences', () => {
    expect(looksLikeMachineCode('Circle activation failed: not enough members.')).toBe(false);
    expect(looksLikeMachineCode('Session has expired. Please login again.')).toBe(false);
  });
});

describe('humanizeErrorMessage', () => {
  it('maps known codes to real copy', () => {
    expect(humanizeErrorMessage('UPGRADE_REQUIRED')).toMatch(/Premium plan/);
    expect(humanizeErrorMessage('EWalletHasBalance')).toMatch(/Withdraw/);
  });

  it('collapses unknown machine codes to the generic message', () => {
    expect(humanizeErrorMessage('SOME_NEW_CODE')).toBe(GENERIC_USER_ERROR);
    expect(humanizeErrorMessage('ESomethingUnmapped')).toBe(GENERIC_USER_ERROR);
  });

  it('passes human sentences through untouched', () => {
    const sentence = 'Only the circle admin can perform this action.';
    expect(humanizeErrorMessage(sentence)).toBe(sentence);
  });

  it('falls back on empty input and honors a custom fallback', () => {
    expect(humanizeErrorMessage('')).toBe(GENERIC_USER_ERROR);
    expect(humanizeErrorMessage(undefined)).toBe(GENERIC_USER_ERROR);
    expect(humanizeErrorMessage('WEIRD_CODE', 'Could not update the member limit.')).toBe(
      'Could not update the member limit.',
    );
  });
});

describe('moveAbortUserMessage — contract refusals with copy of their own', () => {
  /** A failed transaction's message, as the wallet adapter and RPC report it. */
  const abortIn = (moduleName: string, code: number, fn = 'open_cycle_stable_indexed') =>
    `MoveAbort(MoveLocation { module: ModuleId { address: 0x1ff046483db11f813be67f76bf29b2d2c54311e07a2b898135478ec260e80d3d, name: Identifier("${moduleName}") }, function: 12, instruction: 34, function_name: Some("${fn}") }, ${code}) in command 0`;

  it.each([
    ['njangi_cycle_escrow', 236, /isn't running/],
    ['njangi_cycle_escrow', 237, /paused between laps/],
    ['njangi_cycle_escrow', 239, /isn't this circle's coin/],
    ['njangi_cycle_escrow', 243, /coin settings/],
    ['njangi_circles', 92, /one-time update/],
    ['njangi_circles', 85, /coin and amounts are fixed/],
  ])('%s %d has its own copy', (moduleName, code, copy) => {
    expect(moveAbortUserMessage(abortIn(moduleName, code))).toMatch(copy);
    expect(moveAbortUserMessage(new Error(abortIn(moduleName, code)))).toMatch(copy);
  });

  it('reads the deprecation code from any njangi module', () => {
    for (const moduleName of ['njangi_circles', 'njangi_payments', 'njangi_custody', 'njangi_price_validator', 'njangi_members']) {
      expect(moveAbortUserMessage(abortIn(moduleName, 89, 'create_circle'))).toMatch(/retired.*Refresh/);
    }
  });

  it('trusts a code only with its own module', () => {
    expect(moveAbortUserMessage(abortIn('njangi_circles', 236))).toBeNull();
    expect(moveAbortUserMessage(abortIn('njangi_cycle_escrow', 85))).toBeNull();
    expect(moveAbortUserMessage(abortIn('njangi_cycle_escrow', 92))).toBeNull();
    expect(moveAbortUserMessage(abortIn('dynamic_field', 89))).toBeNull();
    expect(moveAbortUserMessage(abortIn('balance', 2))).toBeNull();
  });

  it('answers null for codes and messages it does not explain', () => {
    expect(moveAbortUserMessage(abortIn('njangi_cycle_escrow', 234))).toBeNull();
    expect(moveAbortUserMessage('Insufficient gas')).toBeNull();
    expect(moveAbortUserMessage(undefined)).toBeNull();
  });

  it('humanizeErrorMessage uses the same copy, and still collapses other aborts', () => {
    expect(humanizeErrorMessage(abortIn('njangi_cycle_escrow', 237))).toMatch(/paused between laps/);
    expect(humanizeErrorMessage(abortIn('njangi_circles', 89, 'member_deposit_security_deposit'))).toMatch(/retired/);
    expect(humanizeErrorMessage(abortIn('njangi_circles', 29))).toBe(GENERIC_USER_ERROR);
  });
});
