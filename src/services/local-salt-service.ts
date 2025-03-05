/**
 * A simplified salt service for Next.js API routes
 * 
 * This service generates and stores salts in memory for development purposes.
 * For production, consider using a database-backed solution.
 */

import { randomBytes } from 'crypto';

// In-memory store for salts (for development only)
const saltStore = new Map<string, string>();

// Maximum allowed salt value (matches Sui zkLogin requirements)
const MAX_SALT = 2n ** 128n - 1n;

/**
 * Generate a cryptographically secure random salt
 */
function generateSecureRandomSalt(): string {
  // Generate a random 16-byte value
  const randomValue = randomBytes(16);
  // Convert to a BigInt
  const salt = BigInt(`0x${randomValue.toString('hex')}`);
  // Ensure it's within the valid range
  const validSalt = salt % MAX_SALT;
  // Return as a decimal string
  return validSalt.toString();
}

/**
 * Create a unique key for a user based on sub (user ID) and aud (client ID)
 */
function createUserKey(sub: string, aud: string): string {
  return `${sub}:${aud}`;
}

/**
 * Get a salt for a user, creating one if it doesn't exist
 */
async function getSalt(sub: string, aud: string): Promise<string> {
  const userKey = createUserKey(sub, aud);
  
  // If a salt already exists for this user, return it
  if (saltStore.has(userKey)) {
    return saltStore.get(userKey)!;
  }
  
  // Otherwise, generate a new salt
  const salt = generateSecureRandomSalt();
  saltStore.set(userKey, salt);
  
  return salt;
}

/**
 * Reset a user's salt (for testing or account recovery)
 */
async function resetSalt(sub: string, aud: string): Promise<string> {
  const userKey = createUserKey(sub, aud);
  const salt = generateSecureRandomSalt();
  saltStore.set(userKey, salt);
  return salt;
}

/**
 * Clear all salts (for testing)
 */
function clearAll(): void {
  saltStore.clear();
}

// Export the service functions
export default {
  getSalt,
  resetSalt,
  clearAll
}; 