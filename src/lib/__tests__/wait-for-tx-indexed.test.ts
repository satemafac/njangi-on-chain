import { waitForTxIndexed } from '@/lib/wait-for-tx-indexed';

describe('waitForTxIndexed', () => {
  it('waits on the given digest and reports it indexed', async () => {
    const waitForTransaction = jest.fn(async () => ({ digest: 'D1' }));
    await expect(waitForTxIndexed({ waitForTransaction } as never, 'D1', 5_000)).resolves.toBe(true);
    expect(waitForTransaction).toHaveBeenCalledWith({ digest: 'D1', timeout: 5_000, pollInterval: 1_000 });
  });

  it('never throws: a timeout lets the caller refresh anyway', async () => {
    const waitForTransaction = jest.fn(async () => {
      throw new Error('timed out');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(waitForTxIndexed({ waitForTransaction } as never, 'D1')).resolves.toBe(false);
  });

  it('does nothing without a digest', async () => {
    const waitForTransaction = jest.fn();
    await expect(waitForTxIndexed({ waitForTransaction } as never, undefined)).resolves.toBe(false);
    expect(waitForTransaction).not.toHaveBeenCalled();
  });
});
