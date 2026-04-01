import {
  buildBatchHeartbeatAdminLivenessTx,
  buildCreateCircleTx,
  buildExecuteRecoveryTx,
  buildHeartbeatAdminLivenessTx,
  buildProposeEmergencyStopTx,
  buildTriggerAutoReleaseTx,
  buildUpdateNextInCommandTx,
  buildVoteEmergencyStopTx,
  type CreateCircleTransactionData,
} from '@/lib/zklogin-tx-builders';

const VALID_DELEGATE_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000123';

const createCircleData = (): CreateCircleTransactionData => ({
  name: 'Njangi Prime',
  contribution_amount: '1000000000',
  contribution_amount_local: 2500,
  contribution_amount_usd: 2500,
  currency_type: 'USD',
  security_deposit: '1500000000',
  security_deposit_local: 3750,
  security_deposit_usd: 3750,
  cycle_length: 1,
  cycle_day: 12,
  circle_type: 0,
  max_members: 10,
  rotation_style: 0,
  penalty_rules: [true, false],
  goal_type: { none: null },
  target_amount: { none: null },
  target_amount_local: { none: null },
  target_date: { none: null },
  verification_required: false,
  auto_release_enabled: true,
  auto_release_delay_ms: `${31 * 24 * 60 * 60 * 1000}`,
  next_in_command: VALID_DELEGATE_ADDRESS,
});

describe('zklogin transaction builders', () => {
  it('builds the create-circle transaction with recovery params in the correct order', () => {
    const tx = buildCreateCircleTx({
      packageId: '0xabc',
      circleData: createCircleData(),
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.gasConfig.budget).toBe('50000000');
    expect(serialized.transactions).toHaveLength(1);
    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::create_circle',
    );
    expect(serialized.transactions[0].arguments).toHaveLength(23);
    expect(serialized.inputs[0].value.Pure).toBeDefined();
    expect(serialized.inputs[18].value.Pure).toEqual([0]);
    expect(serialized.inputs[19].value.Pure).toEqual([1]);
    expect(serialized.inputs[21].value.Pure).toBeDefined();
  });

  it('rejects create-circle recovery delays that do not exceed the cycle length', () => {
    expect(() =>
      buildCreateCircleTx({
        packageId: '0xabc',
        circleData: {
          ...createCircleData(),
          auto_release_delay_ms: `${30 * 24 * 60 * 60 * 1000}`,
        },
      }),
    ).toThrow('Auto-release delay must be greater than the selected cycle length.');
  });

  it('allows create-circle transactions without a next-in-command', () => {
    const tx = buildCreateCircleTx({
      packageId: '0xabc',
      circleData: {
        ...createCircleData(),
        next_in_command: null,
      },
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::create_circle',
    );
  });

  it('rejects invalid next-in-command addresses', () => {
    expect(() =>
      buildCreateCircleTx({
        packageId: '0xabc',
        circleData: {
          ...createCircleData(),
          next_in_command: 'not-an-address',
        },
      }),
    ).toThrow('Next-in-command wallet address is invalid.');
  });

  it('builds the emergency stop proposal transaction', () => {
    const tx = buildProposeEmergencyStopTx({
      packageId: '0xabc',
      circleId: '0x123',
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.gasConfig.budget).toBe('50000000');
    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::propose_emergency_stop',
    );
    expect(serialized.transactions[0].arguments).toHaveLength(2);
  });

  it('builds the emergency stop vote transaction with the approval flag', () => {
    const tx = buildVoteEmergencyStopTx({
      packageId: '0xabc',
      circleId: '0x123',
      yesVote: true,
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::vote_emergency_stop',
    );
    expect(serialized.inputs[1].value.Pure).toEqual([1]);
  });

  it('builds the execute-recovery transaction with wallet and type arg', () => {
    const tx = buildExecuteRecoveryTx({
      packageId: '0xabc',
      circleId: '0x123',
      walletId: '0x456',
      stablecoinType: '0xdef::usdc::USDC',
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.gasConfig.budget).toBe('100000000');
    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::execute_recovery',
    );
    expect(serialized.transactions[0].typeArguments).toEqual(['0xdef::usdc::USDC']);
    expect(serialized.transactions[0].arguments).toHaveLength(3);
  });

  it('builds the trigger-auto-release transaction with wallet and type arg', () => {
    const tx = buildTriggerAutoReleaseTx({
      packageId: '0xabc',
      circleId: '0x123',
      walletId: '0x456',
      stablecoinType: '0xdef::usdc::USDC',
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::trigger_auto_release',
    );
    expect(serialized.transactions[0].typeArguments).toEqual(['0xdef::usdc::USDC']);
  });

  it('builds the update-next-in-command transaction', () => {
    const tx = buildUpdateNextInCommandTx({
      packageId: '0xabc',
      circleId: '0x123',
      nextInCommand: VALID_DELEGATE_ADDRESS,
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::update_next_in_command',
    );
    expect(serialized.transactions[0].arguments).toHaveLength(3);
  });

  it('rejects invalid next-in-command addresses for update builder', () => {
    expect(() =>
      buildUpdateNextInCommandTx({
        packageId: '0xabc',
        circleId: '0x123',
        nextInCommand: 'not-an-address',
      }),
    ).toThrow('Next-in-command wallet address is invalid.');
  });

  it('builds the heartbeat-admin-liveness transaction', () => {
    const tx = buildHeartbeatAdminLivenessTx({
      packageId: '0xabc',
      circleId: '0x123',
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000abc::njangi_circles::heartbeat_admin_liveness',
    );
    expect(serialized.transactions[0].arguments).toHaveLength(2);
  });

  it('builds a batch heartbeat transaction across multiple circles', () => {
    const tx = buildBatchHeartbeatAdminLivenessTx({
      circles: [
        { packageId: '0xaaa', circleId: '0x111' },
        { packageId: '0xbbb', circleId: '0x222' },
      ],
    });
    const serialized = JSON.parse(tx.serialize());

    expect(serialized.transactions).toHaveLength(2);
    expect(serialized.transactions[0].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000aaa::njangi_circles::heartbeat_admin_liveness',
    );
    expect(serialized.transactions[1].target).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000bbb::njangi_circles::heartbeat_admin_liveness',
    );
  });

  it('rejects empty batch heartbeat transactions', () => {
    expect(() => buildBatchHeartbeatAdminLivenessTx({ circles: [] })).toThrow(
      'At least one circle target is required.',
    );
  });

  it('rejects invalid object ids for recovery builders', () => {
    expect(() =>
      buildExecuteRecoveryTx({
        packageId: '0xabc',
        circleId: '',
        walletId: '0x456',
        stablecoinType: '0xdef::usdc::USDC',
      }),
    ).toThrow('Circle ID is required.');

    expect(() =>
      buildTriggerAutoReleaseTx({
        packageId: '0xabc',
        circleId: '0x123',
        walletId: '',
        stablecoinType: '0xdef::usdc::USDC',
      }),
    ).toThrow('Custody wallet ID is required.');

    expect(() =>
      buildHeartbeatAdminLivenessTx({
        packageId: '0xabc',
        circleId: '',
      }),
    ).toThrow('Circle ID is required.');
  });
});
