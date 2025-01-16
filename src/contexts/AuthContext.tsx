import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AccountData } from '@/services/zkLoginService';
import { ZkLoginClient } from '@/services/zkLoginClient';
import type { OAuthProvider } from '@/services/zkLoginService';

interface AuthContextType {
  account: AccountData | null;
  isAuthenticated: boolean;
  userAddress: string;
  error: string | null;
  login: (provider: OAuthProvider) => Promise<void>;
  logout: () => void;
  handleCallback: (jwt: string) => Promise<AccountData>;
  sendTransaction: () => Promise<string>;
  setUserAddress: (address: string) => void;
  setIsAuthenticated: (value: boolean) => void;
  setError: (error: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userAddress, setUserAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const zkLogin = ZkLoginClient.getInstance();

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
    return accountData;
  };

  const sendTransaction = async () => {
    if (!account) throw new Error('Not logged in');
    const { digest } = await zkLogin.sendTransaction(account);
    return digest;
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
      setUserAddress,
      setIsAuthenticated,
      setError
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