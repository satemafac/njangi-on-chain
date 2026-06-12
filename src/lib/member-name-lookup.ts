// member-name-lookup.ts — Resolve Sui addresses to display names for a
// circle's members. Names come from the join-requests database (populated
// when members apply) and are cached in-memory for the session so we don't
// hammer the lookup endpoint on every re-render.

const inMemoryCache = new Map<string, string>();

function cacheKey(circleId: string, address: string): string {
  return `${circleId.toLowerCase()}::${address.toLowerCase()}`;
}

function apiBase(): string {
  if (typeof window !== 'undefined') return '';
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.NODE_ENV === 'production'
    ? 'https://njangionchain.com'
    : 'http://localhost:3000';
}

export async function lookupMemberName(
  circleId: string,
  address: string,
): Promise<string | null> {
  if (!address) return null;
  const key = cacheKey(circleId, address);
  if (inMemoryCache.has(key)) {
    return inMemoryCache.get(key) ?? null;
  }
  try {
    const response = await fetch(
      `${apiBase()}/api/join-requests/lookup-user?circleId=${encodeURIComponent(circleId)}&userAddress=${encodeURIComponent(address)}`,
    );
    if (!response.ok) return null;
    const body = await response.json();
    const name = body?.data?.userName;
    if (typeof name === 'string' && name.trim()) {
      inMemoryCache.set(key, name.trim());
      return name.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bulk variant: returns a map keyed by lowercase address so UI components
 * can render "It's Aminata's turn" with a single object lookup. Failed
 * lookups are omitted from the result (caller should fall back to a
 * shortened address for missing names).
 */
export async function lookupMemberNames(
  circleId: string,
  addresses: string[],
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(addresses.filter(Boolean)));
  const out: Record<string, string> = {};
  await Promise.all(
    unique.map(async (addr) => {
      const name = await lookupMemberName(circleId, addr);
      if (name) {
        out[addr.toLowerCase()] = name;
      }
    }),
  );
  return out;
}
