import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AccountData, OAuthProvider } from '@/services/zkLoginService';
import { ZkLoginClient } from '@/services/zkLoginClient';
import { useIdleTimer } from '@/hooks/useIdleTimer';

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

interface AuthContextType {
  account: AccountData | null;
  isAuthenticated: boolean;
  userAddress: string;
  error: string | null;
  login: (provider: OAuthProvider) => Promise<void>;
  logout: () => void;
  handleCallback: (jwt: string) => Promise<AccountData>;
  sendTransaction: (circleData: CircleData) => Promise<string>;
  deleteCircle: (circleId: string) => Promise<string>;
  setUserAddress: (address: string) => void;
  setIsAuthenticated: (value: boolean) => void;
  setError: (error: string) => void;
  resetIdleTimer: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userAddress, setUserAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
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

  // Load saved authentication state on mount
  useEffect(() => {
    const savedAccount = localStorage.getItem('account');
    const savedIsAuthenticated = localStorage.getItem('isAuthenticated') === 'true';
    const savedUserAddress = localStorage.getItem('userAddress');

    if (savedAccount && savedIsAuthenticated && savedUserAddress) {
      setAccount(JSON.parse(savedAccount));
      setIsAuthenticated(true);
      setUserAddress(savedUserAddress);
    }
  }, []);

  // Persist state changes to localStorage
  useEffect(() => {
    if (account) {
      localStorage.setItem('account', JSON.stringify(account));
    } else {
      localStorage.removeItem('account');
    }
  }, [account]);

  useEffect(() => {
    localStorage.setItem('isAuthenticated', isAuthenticated.toString());
  }, [isAuthenticated]);

  useEffect(() => {
    if (userAddress) {
      localStorage.setItem('userAddress', userAddress);
    } else {
      localStorage.removeItem('userAddress');
    }
  }, [userAddress]);

  const login = async (provider: OAuthProvider) => {
    try {
      const { loginUrl } = await zkLogin.beginLogin(provider);
      if (!loginUrl) {
        throw new Error('No login URL returned');
      }
      window.location.href = loginUrl;
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start login process');
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
  };

  const handleCallback = async (jwt: string) => {
    const accountData = await zkLogin.handleCallback(jwt);
    setAccount(accountData);
    setUserAddress(accountData.userAddr);
    setIsAuthenticated(true);
    // Reset idle timer after successful login
    resetIdleTimer();
    return accountData;
  };

  const sendTransaction = async (circleData: CircleData) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimer();
    const { digest } = await zkLogin.sendTransaction(account, circleData);
    return digest;
  };

  const deleteCircle = async (circleId: string) => {
    if (!account) throw new Error('Not logged in');
    // Reset idle timer on transaction
    resetIdleTimer();
    
    console.log(`AuthContext: Sending delete request for circle ${circleId}`);
    
    try {
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'deleteCircle', 
          account,
          circleId
        })
      });
      
      // Parse response data first to get error details if any
      const responseData = await response.json();
      console.log('AuthContext: Delete circle response:', responseData);
      
      // If response is not ok, throw a detailed error
      if (!response.ok) {
        // Check for specific errors from the API
        if (response.status === 400 && responseData.error) {
          // Business logic error (like cannot delete due to active members)
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
      return responseData.digest;
    } catch (error) {
      console.error('Error in AuthContext.deleteCircle:', error);
      // Rethrow to let component handle specific error cases
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{ 
      account,
      isAuthenticated,
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
      resetIdleTimer
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