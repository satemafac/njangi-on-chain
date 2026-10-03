// custody-wallet-balance.ts — A custody wallet's coin balance, and the
// contract's refusal to delete a circle whose wallet still holds funds.
//
// Sui JSON-RPC renders a `0x2::balance::Balance<T>` field as a plain string
// of base units (testnet, 2026-10-02: `"balance": "0"`), not the
// `{ fields: { value } }` of an ordinary struct. The delete-circle pre-check
// read only the nested form, so it saw no balance on any wallet and its
// "withdraw all funds first" refusal never fired. The contract refuses anyway
// (below), so nothing could be lost, but the admin got a raw abort instead.

/**
 * The value of a `Balance<T>` field in base units, accepting the plain form
 * JSON-RPC returns and the nested struct form. Null when it does not read as
 * a balance: unknown, never zero.
 */
export function readBalanceField(raw: unknown): bigint | null {
  let value = raw;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as { fields?: { value?: unknown }; value?: unknown };
    value = record.fields?.value ?? record.value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/**
 * True when a failed transaction is `njangi_circles::delete_circle` refusing
 * because the custody wallet still holds SUI or a stablecoin. Both checks
 * abort with EInsufficientDeposit (6), in the current source and in the
 * original package's on-chain bytecode alike, so this cannot tell which.
 */
export function isDeleteCircleWalletFundsAbort(message: string): boolean {
  return (
    message.includes('Identifier("njangi_circles")') &&
    /function_name:\s*Some\("delete_circle"\)\s*\},\s*6\)/.test(message)
  );
}
