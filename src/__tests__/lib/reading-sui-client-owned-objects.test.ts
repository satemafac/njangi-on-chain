/**
 * NJA-3968 (Sui reads 1b): getReadingSuiClient().getOwnedObjects must be
 * served by the working 2.x read layer, not by the pooled client's own
 * JSON-RPC method, which every endpoint now refuses. findRecipientClaim
 * (cycle-escrow-collect.ts), fetchValidAttestations (compliance-gate.ts) and
 * findOwnedAttestorCaps (attestor-cap-discovery.ts) all need it.
 *
 * The pooled client is a stub carrying a 2.x read source; its own
 * getOwnedObjects stands in for the retired JSON-RPC and records whether it
 * was asked. On this commit the reading client hands the call straight to it
 * (reading-sui-client.ts: "Methods not listed here (... getOwnedObjects, ...)
 * are the pooled client's own, still JSON-RPC"). Nothing here reaches the
 * network.
 */

jest.mock('../../services/network-config', () => ({ getCurrentNetwork: () => 'testnet' }));
jest.mock('../../services/sui-rpc-failover', () => ({ getPooledSuiClient: jest.fn() }));
jest.mock('../../lib/v2-sui-client', () => ({ v2TxTransports: jest.fn(), v2Reads: jest.fn() }));
jest.mock('../../lib/sui-read', () => ({
  readObject: jest.fn(),
  readObjects: jest.fn(),
  listDynamicFields: jest.fn(),
  readDynamicFieldObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));

import { getPooledSuiClient } from '../../services/sui-rpc-failover';
import { clearReadingSuiClients, getReadingSuiClient } from '../../lib/reading-sui-client';
import { attachV2ReadSource, type V2ReadSource } from '../../lib/v2-read-source';

const OWNER = `0x${'a1'.repeat(32)}`;
const CLAIM_TYPE = '0xcore::njangi_cycle_escrow::Claim<0x2::sui::SUI>';

beforeEach(() => {
  clearReadingSuiClients();
});

describe("the reading client's getOwnedObjects (NJA-3968)", () => {
  it("is not the pooled client's JSON-RPC getOwnedObjects", async () => {
    // The retired JSON-RPC: every address refuses it.
    const jsonRpcGetOwnedObjects = jest.fn(async () => {
      throw new Error('JSON-RPC is no longer served on this endpoint');
    });
    const pooled = attachV2ReadSource(
      { getObject: jest.fn(), getOwnedObjects: jsonRpcGetOwnedObjects },
      { network: 'testnet' } as V2ReadSource,
    );
    (getPooledSuiClient as jest.Mock).mockReturnValue(pooled);

    // What it answers is NJA-3968's work; WHERE it reads from is this test's.
    await getReadingSuiClient('testnet')
      .getOwnedObjects({
        owner: OWNER,
        filter: { StructType: CLAIM_TYPE },
        options: { showContent: true, showType: true },
      })
      .catch(() => undefined);

    expect(jsonRpcGetOwnedObjects).not.toHaveBeenCalled();
  });
});
