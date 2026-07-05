// sanctions-preflight.ts — Browser-side UX preflight for the OFAC screen.
//
// The client-signed flows (goal-pool create, escrow open via
// useZkLoginSigner) submit straight to Sui RPC, so the server choke
// points never see them. This helper gives those flows a courtesy check
// so a blocked wallet gets a clear message instead of a confusing
// on-chain failure. It is UX ONLY: it returns `false` (allow) on any
// network or parse error, and the server-side screens at the API choke
// points remain the authoritative layer (docs/sanctions-program.md).

export const SANCTIONS_BLOCKED_MESSAGE = "This wallet can't use Njangi On-Chain.";

export async function preflightSanctionsCheck(address: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/sanctions/check?address=${encodeURIComponent(address)}`,
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { blocked?: boolean };
    return body.blocked === true;
  } catch {
    return false;
  }
}
