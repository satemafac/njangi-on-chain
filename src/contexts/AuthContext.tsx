import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AccountData, OAuthProvider } from '@/services/zkLoginService';
import { ZkLoginClient } from '@/services/zkLoginClient';
import { LegalAcceptanceGate } from '@/components/LegalAcceptanceModal';
import { AddressDriftGate } from '@/components/AddressDriftModal';
import { useIdleTimer } from '@/hooks/useIdleTimer';
import { getCurrentNetwork, getNetworkConfig } from '@/services/network-config';
import { refreshAdminHeartbeatsAfterAuth } from '@/lib/admin-heartbeat-refresh';
import {
  accountToSignerSession,
  clearSignerSession,
  loadSignerSession,
  saveSignerSession,
} from '@/lib/zklogin-client-signer';


// Define the interface for the context
interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean; 
  login: (provider: OAuthProvider) => Promise<void>;
  userAddress: string | null;
  logout: () => void;
  account: AccountData | null;
  error: string | null;
  pendingAction: string | null;
  setPendingAction: (action: string | null) => void;
  isLocalDevMode: boolean;
  setLocalDevMode: (mode: boolean) => void;
  deleteCircle: (circleId: string, walletId?: string, packageId?: string) => Promise<{ 
    success: boolean; 
    digest?: string; 
    error?: string; 
    errorType?: string; 
    walletId?: string 
  }>;
  withdrawWalletFunds: (walletId: string, amount?: string) => Promise<string>;
  handleCallback: (jwt: string) => Promise<AccountData>;
  setUserAddress: (address: string) => void;
  setIsAuthenticated: (value: boolean) => void;
  setError: (error: string | null) => void;
  resetIdleTimer: () => void;
  activateCircle: (circleId: string) => Promise<string>;
  sendTokens: (transferData: {
    recipientAddress: string;
    amount: string;
    coinType: string;
    memo?: string;
  }) => Promise<{
    success: boolean;
    digest?: string;
  }>;
}

// localStorage is readable by any script on the origin, so the persisted
// account must never include signing material (ephemeral key, zk proofs,
// salt) — a single XSS would otherwise allow signing as the user until
// maxEpoch. Only display/identity fields are persisted; key material lives
// in React state and the sessionStorage signer session (tab-scoped), and a
// full reload without either requires re-authentication before signing.
type PersistedAccount = Omit<AccountData, 'ephemeralPrivateKey' | 'zkProofs' | 'userSalt'>;

function toPersistedAccount(account: AccountData): PersistedAccount {
  return {
    provider: account.provider,
    userAddr: account.userAddr,
    sub: account.sub,
    aud: account.aud,
    maxEpoch: account.maxEpoch,
    picture: account.picture,
    name: account.name,
  };
}

// Create the context with default values
const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  isLoading: false,
  login: async () => {},
  userAddress: null,
  logout: () => {},
  account: null,
  error: null,
  pendingAction: null,
  setPendingAction: () => {},
  isLocalDevMode: false,
  setLocalDevMode: () => {},
  deleteCircle: async () => ({ success: false, error: 'Not implemented' }),
  withdrawWalletFunds: async () => '',
  handleCallback: async () => ({} as AccountData),
  setUserAddress: () => {},
  setIsAuthenticated: () => {},
  setError: () => {},
  resetIdleTimer: () => {},
  activateCircle: async () => '',
  sendTokens: async () => ({ success: false }),
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [userAddress, setUserAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isLocalDevMode, setIsLocalDevMode] = useState(false);
  const [hasHydratedAuth, setHasHydratedAuth] = useState(false);
  const zkLogin = ZkLoginClient.getInstance();

  const handleAutoLogout = () => {
    if (isAuthenticated) {
      console.log('Auto-logout triggered after 15 minutes of inactivity');
      logout();
    }
  };

  const { resetTimer: resetIdleTimer } = useIdleTimer({
    onIdle: handleAutoLogout,
    idleTime: 15 * 60 * 1000, // 15 minutes in milliseconds
  });

  // Wrap the resetIdleTimer function to add logging
  const resetIdleTimerWithLogging = () => {
    console.log('Resetting idle timer...');
    resetIdleTimer();
    console.log('Idle timer reset successfully');
  };

  // Load saved authentication state on mount
  useEffect(() => {
    try {
      const savedAccount = localStorage.getItem('account');
      const savedIsAuthenticated = localStorage.getItem('isAuthenticated') === 'true';
      const savedUserAddress = localStorage.getItem('userAddress');

      if (savedAccount && savedIsAuthenticated && savedUserAddress) {
        // Persisted accounts carry no signing material; rehydrate the
        // sensitive fields from the tab-scoped signer session when one
        // exists for the same address. Without it the account is
        // display-only and signing flows require a fresh login.
        const parsedAccount = JSON.parse(savedAccount) as PersistedAccount &
          Partial<Pick<AccountData, 'ephemeralPrivateKey' | 'zkProofs' | 'userSalt'>>;
        let restoredAccount = parsedAccount as AccountData;

        const signerSession = loadSignerSession();
        if (signerSession && signerSession.userAddress === parsedAccount.userAddr) {
          restoredAccount = {
            ...parsedAccount,
            ephemeralPrivateKey: signerSession.ephemeralPrivateKey,
            zkProofs: signerSession.zkProofs,
            userSalt: signerSession.userSalt,
          } as AccountData;
        } else if (parsedAccount.ephemeralPrivateKey && parsedAccount.zkProofs) {
          // Legacy entry written before key material was stripped from
          // localStorage — use it once; the persistence effect below
          // rewrites the sanitized shape immediately.
          try {
            saveSignerSession(
              accountToSignerSession(restoredAccount, getCurrentNetwork()),
            );
          } catch (signerErr) {
            console.warn('Failed to rehydrate client signer session', signerErr);
          }
        }

        setAccount(restoredAccount);
        setIsAuthenticated(true);
        setUserAddress(savedUserAddress);
        void refreshAdminHeartbeatsAfterAuth({
          account: restoredAccount,
          heartbeatClient: zkLogin,
          source: 'session_restore',
        });
      }
    } catch (err) {
      console.warn('Failed to restore saved authentication state:', err);
      localStorage.removeItem('account');
      localStorage.removeItem('isAuthenticated');
      localStorage.removeItem('userAddress');
    } finally {
      setHasHydratedAuth(true);
      setIsLoading(false);
    }
  }, [zkLogin]);

  // Persist state changes to localStorage
  useEffect(() => {
    if (!hasHydratedAuth) {
      return;
    }

    if (account) {
      // Never persist signing material — see PersistedAccount above.
      localStorage.setItem('account', JSON.stringify(toPersistedAccount(account)));
    } else {
      localStorage.removeItem('account');
    }
  }, [account, hasHydratedAuth]);

  useEffect(() => {
    if (!hasHydratedAuth) {
      return;
    }

    localStorage.setItem('isAuthenticated', isAuthenticated.toString());
  }, [isAuthenticated, hasHydratedAuth]);

  useEffect(() => {
    if (!hasHydratedAuth) {
      return;
    }

    if (userAddress) {
      localStorage.setItem('userAddress', userAddress);
    } else {
      localStorage.removeItem('userAddress');
    }
  }, [userAddress, hasHydratedAuth]);

  const login = async (provider: OAuthProvider) => {
    try {
      setIsLoading(true);
      const { loginUrl } = await zkLogin.beginLogin(provider);
      if (!loginUrl) {
        throw new Error('No login URL returned');
      }
      window.location.href = loginUrl;
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start login process');
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setAccount(null);
    setIsAuthenticated(false);
    setUserAddress('');
    setError(null);
    localStorage.removeItem('account');
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('userAddress');

    // Clear the Phase 2 client-side signer session along with the localStorage
    // account, so the ephemeral private key never lingers past logout.
    clearSignerSession();

    // Clear sessionStorage to reset UI state between sessions
    sessionStorage.removeItem('testnetBannerDismissed');
    
    // Redirect to home page after logout
    // The prompt=select_account parameter in the OAuth URL will ensure
    // users are prompted to select an account on next login
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://njangionchain.com';
    window.location.href = baseUrl;
  };

  const handleCallback = async (jwt: string) => {
    console.log('🔄 AuthContext: handleCallback called');
    const accountData = await zkLogin.handleCallback(jwt);
    console.log('✅ AuthContext: zkLogin callback completed, user address:', accountData.userAddr);
    
    setAccount(accountData);
    setUserAddress(accountData.userAddr);
    setIsAuthenticated(true);

    // Persist immediately so a navigation/remount cannot lose the fresh
    // session. Signing material stays out of localStorage — the signer
    // session below (sessionStorage) plus React state carry it instead.
    localStorage.setItem('account', JSON.stringify(toPersistedAccount(accountData)));
    localStorage.setItem('userAddress', accountData.userAddr);
    localStorage.setItem('isAuthenticated', 'true');

    // Populate the Phase 2 client-side signer session so downstream flows
    // (useZkLoginSigner) can sign transactions without re-POSTing the
    // ephemeral private key through the server.
    try {
      saveSignerSession(
        accountToSignerSession(accountData, getCurrentNetwork()),
      );
    } catch (signerErr) {
      console.warn('Failed to persist client signer session', signerErr);
    }

    setHasHydratedAuth(true);

    // Reset idle timer after successful login
    resetIdleTimerWithLogging();

    void refreshAdminHeartbeatsAfterAuth({
      account: accountData,
      heartbeatClient: zkLogin,
      source: 'login_success',
    });
    
    // Check for WhatsApp phone number and send notification
    const whatsappPhone = sessionStorage.getItem('whatsapp_phone');
    console.log('📱 AuthContext: Checking for WhatsApp phone:', whatsappPhone ? `Found: ${whatsappPhone}` : 'Not found');
    
    if (whatsappPhone) {
      console.log('📤 AuthContext: Sending WhatsApp notification for:', whatsappPhone);
      
      try {
        // Send notification to WhatsApp with account data so server can register mapping
        const response = await fetch('/api/whatsapp/auth/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            token: 'direct-auth',
            phone: whatsappPhone, 
            success: true,
            message: 'Authentication completed successfully! You can now use all Njangi commands.',
            userAddress: accountData.userAddr // Add user address for debugging
          }),
        });
        
        if (response.ok) {
          console.log('✅ AuthContext: WhatsApp notification sent successfully');
        } else {
          const errorText = await response.text();
          console.error('❌ AuthContext: WhatsApp notification failed:', response.status, errorText);
        }
        
        // Clear the session storage
        sessionStorage.removeItem('whatsapp_phone');
      } catch (err) {
        console.error('❌ AuthContext: Failed to send WhatsApp notification:', err);
      }
    } else {
      console.log('ℹ️ AuthContext: No WhatsApp phone found, skipping notification');
    }
    
    return accountData;
  };

  // Removed: `sendTransaction`. It wrapped the legacy server-signed
  // circle-creation action and had no callers — create-circle.tsx uses
  // ZkLoginClient.createCircle, which builds and signs in the browser.
  // Migrating a dead chain would have meant carrying it forever.

  const deleteCircle = async (circleId: string, walletId?: string, packageId?: string) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimerWithLogging();
    
    console.log(`AuthContext: Sending delete request for circle ${circleId}`);
    console.log(`AuthContext: Using package ID: ${packageId || '(default)'}`);
    
    try {
      // Signed in the browser — the server no longer holds a key that could
      // do it. deleteCircle asserts on chain that the circle is empty
      // (contributions, deposits and wallet balances all zero), so this
      // cannot destroy a circle holding funds.
      const { digest: deleteDigest } = await new ZkLoginClient().deleteCircle(
        account,
        circleId,
        walletId,
      );
      const response = { ok: true, status: 200 };
      const responseData: {
        digest?: string;
        error?: string;
        details?: string;
        code?: string;
      } = { digest: deleteDigest };
      console.log('AuthContext: Delete circle response:', responseData);
      
      // If response is not ok, handle differently based on error type
      if (!response.ok) {
        // Check for specific errors from the API
        if (response.status === 400 && responseData.error) {
          // Special handling for wallet balance errors to make them consistently detectable
          if (responseData.error.includes('wallet has') || 
              responseData.error.includes('coins') || 
              responseData.error.includes('funds') ||
              responseData.error.includes('EWalletHas') ||
              responseData.code === 'EWalletHasBalance' ||
              responseData.code === 'EWalletHasStablecoin') {
            
            // Instead of throwing, return a structured error that the UI can handle gracefully
            return {
              success: false,
              error: 'Cannot delete: The wallet has coins stored in dynamic fields. Please withdraw all funds first.',
              errorType: 'WALLET_HAS_BALANCE',
              walletId
            };
          }
          
          // Special handling for already deleted objects
          if (responseData.code === 'OBJECT_ALREADY_DELETED' || 
              responseData.error.includes('already been deleted')) {
            
            // Instead of throwing, return a structured error that indicates the object is already deleted
            return {
              success: false,
              error: 'This circle has already been deleted or is no longer available. Please refresh the page to update the view.',
              errorType: 'OBJECT_ALREADY_DELETED',
              walletId
            };
          }
          
          // Regular business logic errors (like cannot delete due to active members)
          throw new Error(responseData.error);
        } else if (response.status === 401) {
          // Authentication error
          const message = responseData.error || 'Authentication failed. Please login again.';
          throw new Error(message);
        } else {
          // Other server errors
          const errorMessage = responseData.error || 'Failed to delete circle';
          const detailsMessage = responseData.details ? `\nDetails: ${responseData.details}` : '';
          throw new Error(`${errorMessage}${detailsMessage}`);
        }
      }
      
      // Success case
      return { 
        success: true, 
        digest: responseData.digest || '' 
      };
    } catch (error) {
      console.error('Error in AuthContext.deleteCircle:', error);
      // Rethrow to let component handle specific error cases
      throw error;
    }
  };

  const activateCircle = async (circleId: string): Promise<string> => {
    if (!zkLogin) {
      throw new Error('ZkLogin client not initialized');
    }
    
    if (!account) {
      throw new Error('User not authenticated');
    }

    try {
      // Try to use zkLogin to make transaction
      console.log(`Activating circle ${circleId} with zkLogin`);
      const zkLoginClient = new ZkLoginClient();
      const result = await zkLoginClient.activateCircle(account, circleId);
      return result.digest;
    } catch (error) {
      console.error('Error activating circle:', error);
      throw error;
    }
  };

  const withdrawWalletFunds = async (walletId: string, amount?: string) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimerWithLogging();
    
    console.log(`AuthContext: Sending withdraw funds request for wallet ${walletId}`);
    
    try {
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'withdrawWalletFunds', 
          account,
          walletId,
          amount,
          network: getCurrentNetwork() // Add current network to request
        })
      });
      
      // Parse response data first to get error details if any
      const responseData = await response.json();
      console.log('AuthContext: Withdraw funds response:', responseData);
      
      // If response is not ok, throw a detailed error
      if (!response.ok) {
        // Check for specific errors from the API
        if (response.status === 400 && responseData.error) {
          // Business logic error (like insufficient funds)
          throw new Error(responseData.error);
        } else if (response.status === 401) {
          // Authentication error
          const message = responseData.error || 'Authentication failed. Please login again.';
          throw new Error(message);
        } else {
          // Other server errors
          const errorMessage = responseData.error || 'Failed to withdraw funds';
          const detailsMessage = responseData.details ? `\nDetails: ${responseData.details}` : '';
          throw new Error(`${errorMessage}${detailsMessage}`);
        }
      }
      
      // Success case
      return responseData.digest;
    } catch (error) {
      console.error('Error in AuthContext.withdrawWalletFunds:', error);
      // Rethrow to let component handle specific error cases
      throw error;
    }
  };

  const sendTokens = async (transferData: {
    recipientAddress: string;
    amount: string;
    coinType: string;
    memo?: string;
  }) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimerWithLogging();
    
    console.log('AuthContext: Sending token transfer request');
    
    try {
      // Signed in the browser. This action was the most dangerous thing on
      // the old server-signing surface: an arbitrary "move `amount` of
      // `coinType` to `recipient`" primitive that no Move-target allowlist
      // could constrain, because it makes no Move call at all. With the
      // session cookie it was enough to drain a wallet. The server can no
      // longer perform it.
      const [{ SuiClient }, signerModule, { buildSendTokensTx }] = await Promise.all([
        import('@mysten/sui/client'),
        import('@/lib/zklogin-client-signer'),
        import('@/lib/send-tokens-tx'),
      ]);
      const signerSession = signerModule.loadSignerSession();
      if (!signerSession) {
        throw new Error('Your signing session is unavailable. Please sign in again.');
      }
      const suiClient = new SuiClient({
        url: getNetworkConfig(signerSession.network).rpcUrl,
      });

      const { digest } = await signerModule.signAndExecuteWithZkLogin(
        signerSession,
        suiClient,
        {
          build: (txb, client) =>
            buildSendTokensTx(txb, client, {
              recipientAddress: transferData.recipientAddress,
              amount: BigInt(transferData.amount),
              coinType: transferData.coinType,
              userAddress: signerSession.userAddress,
            }),
          gasBudget: 30_000_000,
        },
      );

      // Success case
      return {
        success: true,
        digest,
      };
    } catch (error) {
      console.error('Error in AuthContext.sendTokens:', error);
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{ 
      account,
      isAuthenticated,
      isLoading,
      userAddress,
      error,
      login,
      logout,
      handleCallback, 
      deleteCircle,
      setUserAddress,
      setIsAuthenticated,
      setError,
      resetIdleTimer: resetIdleTimerWithLogging,
      activateCircle,
      pendingAction,
      setPendingAction,
      isLocalDevMode,
      setLocalDevMode: setIsLocalDevMode,
      withdrawWalletFunds,
      sendTokens
    }}>
      {children}
      {/* Legal acceptance gate (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
          runs after fresh logins AND localStorage session restores — both
          paths flow through this provider, unlike /auth/callback. The gate
          itself exempts recovery/claim routes; see LegalAcceptanceModal. */}
      <LegalAcceptanceGate active={isAuthenticated && !isLoading} />
      {/* Address-drift gate (docs/prd/prd-address-drift-guard.md): warns when
          this sign-in resolved to a different Sui address than the identity
          used before, which strands the user's funds at the old one. Mounted
          here for the same reason as the legal gate — it must cover session
          restore, not just /auth/callback — and it exempts the same
          fund-access routes. */}
      <AddressDriftGate active={isAuthenticated && !isLoading} />
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
} 
