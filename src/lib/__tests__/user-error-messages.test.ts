import {
  GENERIC_USER_ERROR,
  humanizeErrorMessage,
  looksLikeMachineCode,
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
