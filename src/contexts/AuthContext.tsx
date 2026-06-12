import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AccountData, OAuthProvider } from '@/services/zkLoginService';
import { ZkLoginClient } from '@/services/zkLoginClient';
import { useIdleTimer } from '@/hooks/useIdleTimer';
import { getCurrentNetwork } from '@/services/network-config';
import { refreshAdminHeartbeatsAfterAuth } from '@/lib/admin-heartbeat-refresh';
import {
  accountToSignerSession,
  clearSignerSession,
  saveSignerSession,
} from '@/lib/zklogin-client-signer';

// Define CircleData interface based on required parameters
interface CircleData {
  name: string;
  contribution_amount: string | number;
  security_deposit: string | number;
  cycle_length: number;
  cycle_day: number;
  circle_type: number;
  max_members: number;
  rotation_style: number;
  penalty_rules: boolean[];
  goal_type?: { some?: number };
  target_amount?: { some?: string | number };
  target_date?: { some?: string | number };
  verification_required: boolean;
}

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
  sendTransaction: (circleData: CircleData) => Promise<string>;
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
  sendTransaction: async () => '',
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
        const parsedAccount = JSON.parse(savedAccount) as AccountData;
        setAccount(parsedAccount);
        setIsAuthenticated(true);
        setUserAddress(savedUserAddress);
        try {
          saveSignerSession(
            accountToSignerSession(parsedAccount, getCurrentNetwork()),
          );
        } catch (signerErr) {
          console.warn('Failed to rehydrate client signer session', signerErr);
        }
        void refreshAdminHeartbeatsAfterAuth({
          account: parsedAccount,
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
      localStorage.setItem('account', JSON.stringify(account));
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

    // Persist immediately so a navigation/remount cannot lose the fresh session.
    localStorage.setItem('account', JSON.stringify(accountData));
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

  const sendTransaction = async (circleData: CircleData) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimerWithLogging();
    const { digest } = await zkLogin.sendTransaction(account, circleData);
    return digest;
  };

  const deleteCircle = async (circleId: string, walletId?: string, packageId?: string) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimerWithLogging();
    
    console.log(`AuthContext: Sending delete request for circle ${circleId}`);
    console.log(`AuthContext: Using package ID: ${packageId || '(default)'}`);
    
    try {
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'deleteCircle', 
          account,
          circleId,
          walletId,
          packageId, // Pass the circle-specific package ID
          network: getCurrentNetwork() // Add current network to request
        })
      });
      
      // Parse response data first to get error details if any
      const responseData = await response.json();
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
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'sendTokens', 
          account,
          ...transferData
        })
      });
      
      const responseData = await response.json();
      console.log('AuthContext: Send tokens response:', responseData);
      
      if (!response.ok) {
        if (response.status === 401) {
          // Authentication error
          const message = responseData.error || 'Authentication failed. Please login again.';
          throw new Error(message);
        } else {
          // Other server errors
          const errorMessage = responseData.error || 'Failed to send tokens';
          throw new Error(errorMessage);
        }
      }
      
      // Success case
      return { 
        success: true, 
        digest: responseData.digest || '' 
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
      sendTransaction,
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
