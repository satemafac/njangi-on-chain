import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';
import { cetusService } from '../../../../lib/cetus-service';
import { PACKAGE_ID } from '../../../../services/circle-service';

interface StablecoinConfig {
  enabled: boolean;
  targetCoinType: string;
  slippageTolerance: number;
  minimumSwapAmount: number;
  dexAddress: string;
  globalConfigId?: string;
  poolId?: string;
}

export default function SwapSettings() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  
  const [hasAccess, setHasAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [walletId, setWalletId] = useState<string | null>(null);
  
  const [config, setConfig] = useState<StablecoinConfig>({
    enabled: false,
    targetCoinType: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN', // Default to USDC
    slippageTolerance: 50, // 0.5%
    minimumSwapAmount: 1, // 1 SUI
    dexAddress: '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12', // Cetus package ID v1.26.0
    globalConfigId: '',
    poolId: '',
  });
  
  const [availableTokens, setAvailableTokens] = useState<Array<{ symbol: string; address: string }>>([]);
  
  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
    
    if (id && userAddress) {
      fetchCircleData();
      fetchWalletId();
      loadAvailableTokens();
    }
  }, [id, userAddress, isAuthenticated]);
  
  const fetchCircleData = async () => {
    try {
      setLoading(true);
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true }
      });
      
      if (objectData.data?.content && 'fields' in objectData.data.content) {
        const fields = objectData.data.content.fields as {
          name: string;
          admin: string;
          contribution_amount?: string;
          [key: string]: unknown;
        };
        
        if (fields.admin !== userAddress) {
          toast.error('You must be the circle admin to access this page');
          router.push('/dashboard');
        } else {
          setHasAccess(true);
        }
      }
    } catch (error) {
      console.error('Error fetching circle data:', error);
      toast.error('Failed to load circle information');
    } finally {
      setLoading(false);
    }
  };
  
  const fetchWalletId = async () => {
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      const walletCreatedEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circle::CustodyWalletCreated`
        },
        limit: 50
      });
      
      // Look for events related to this circle
      for (const event of walletCreatedEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'circle_id' in event.parsedJson &&
            'wallet_id' in event.parsedJson &&
            event.parsedJson.circle_id === id) {
          setWalletId(event.parsedJson.wallet_id as string);
          break;
        }
      }
    } catch (error) {
      console.error('Error fetching wallet ID:', error);
    }
  };
  
  const loadAvailableTokens = async () => {
    try {
      if (!userAddress) return;
      
      // Initialize the service and get available tokens
      cetusService.init(userAddress, 'testnet');
      const tokens = await cetusService.getSupportedTokens();
      setAvailableTokens(tokens.map(t => ({ symbol: t.symbol, address: t.address })));
    } catch (error) {
      console.error('Error loading available tokens:', error);
    }
  };
  
  const handleToggleEnabled = () => {
    setConfig(prev => ({ ...prev, enabled: !prev.enabled }));
  };
  
  const handleTargetTokenChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setConfig(prev => ({ ...prev, targetCoinType: e.target.value }));
  };
  
  const handleSlippageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setConfig(prev => ({ ...prev, slippageTolerance: parseInt(e.target.value) }));
  };
  
  const handleMinAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value) && value >= 0) {
      setConfig(prev => ({ ...prev, minimumSwapAmount: value }));
    }
  };
  
  const handlePoolIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfig(prev => ({ ...prev, poolId: e.target.value }));
  };
  
  const handleGlobalConfigIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfig(prev => ({ ...prev, globalConfigId: e.target.value }));
  };
  
  const handleSaveConfig = async () => {
    if (!account || !walletId) {
      toast.error('Missing required information');
      return;
    }
    
    if (config.enabled && (!config.poolId || !config.globalConfigId)) {
      toast.error('Pool ID and Global Config ID are required when enabling auto-swap');
      return;
    }
    
    setSaving(true);
    try {
      toast.loading('Saving stablecoin swap configuration...', { id: 'config-save' });
      
      // Format the transaction payload
      const result = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'configureStablecoinSwap',
          account,
          walletId,
          enabled: config.enabled,
          targetCoinType: config.targetCoinType,
          slippageTolerance: config.slippageTolerance,
          minimumSwapAmount: Math.floor(config.minimumSwapAmount * 1e9), // Convert to SUI decimals
          dexAddress: config.dexAddress,
          globalConfigId: config.globalConfigId,
          poolId: config.poolId,
        }),
      });
      
      const data = await result.json();
      
      if (result.ok) {
        toast.success('Configuration saved successfully!', { id: 'config-save' });
      } else {
        toast.error(data.error || 'Failed to save configuration', { id: 'config-save' });
      }
    } catch (error) {
      console.error('Error saving config:', error);
      toast.error('An error occurred while saving configuration', { id: 'config-save' });
    } finally {
      setSaving(false);
    }
  };
  
  if (!isAuthenticated || loading || !hasAccess) {
    return (
      <div className="min-h-screen bg-gray-50 flex justify-center items-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-500 rounded-full border-t-transparent"></div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6 flex items-center justify-between">
            <button
              onClick={() => router.push(`/circle/${id}/manage`)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm text-sm text-gray-700 font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Circle Management
            </button>
          </div>

          <div className="bg-white shadow-md rounded-xl overflow-hidden border border-gray-100">
            <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Stablecoin Swap Settings
              </h2>
              <p className="text-gray-600">
                Configure automatic stablecoin swaps for your circle
              </p>
            </div>
            
            <div className="p-6">
              <div className="mb-8">
                <div className="flex items-center space-x-3 mb-4">
                  <div className="relative inline-block w-10 mr-2 align-middle select-none">
                    <input 
                      type="checkbox" 
                      id="toggle-swap"
                      checked={config.enabled}
                      onChange={handleToggleEnabled}
                      className="toggle-checkbox absolute block w-6 h-6 rounded-full bg-white border-4 appearance-none cursor-pointer"
                    />
                    <label 
                      htmlFor="toggle-swap" 
                      className={`toggle-label block overflow-hidden h-6 rounded-full cursor-pointer ${config.enabled ? 'bg-blue-500' : 'bg-gray-300'}`}
                      style={{ transition: 'background-color 0.3s ease' }}
                    ></label>
                  </div>
                  <label htmlFor="toggle-swap" className="text-lg font-medium text-gray-700">
                    {config.enabled ? 'Auto-Swap Enabled' : 'Auto-Swap Disabled'}
                  </label>
                </div>
                
                <p className="text-sm text-gray-600 mb-4">
                  When enabled, member contributions will automatically be swapped to stablecoins 
                  to protect against crypto volatility.
                </p>
              </div>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Target Stablecoin
                  </label>
                  <select
                    value={config.targetCoinType}
                    onChange={handleTargetTokenChange}
                    className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                    disabled={!config.enabled}
                  >
                    {availableTokens
                      .filter(token => token.symbol === 'USDC' || token.symbol === 'USDT')
                      .map(token => (
                        <option key={token.address} value={token.address}>
                          {token.symbol}
                        </option>
                      ))
                    }
                  </select>
                  <p className="mt-1 text-sm text-gray-500">
                    The stablecoin that SUI will be swapped to
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Slippage Tolerance
                  </label>
                  <select
                    value={config.slippageTolerance.toString()}
                    onChange={handleSlippageChange}
                    className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                    disabled={!config.enabled}
                  >
                    <option value="10">0.1%</option>
                    <option value="25">0.25%</option>
                    <option value="50">0.5%</option>
                    <option value="100">1.0%</option>
                    <option value="200">2.0%</option>
                  </select>
                  <p className="mt-1 text-sm text-gray-500">
                    Maximum acceptable price difference from estimated swap rate
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Minimum Swap Amount (SUI)
                  </label>
                  <input
                    type="number"
                    value={config.minimumSwapAmount}
                    onChange={handleMinAmountChange}
                    min="0"
                    step="0.1"
                    className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                    disabled={!config.enabled}
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    Minimum amount of SUI required to trigger auto-swap (to avoid dust swaps)
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cetus Pool ID
                  </label>
                  <input
                    type="text"
                    value={config.poolId || ''}
                    onChange={handlePoolIdChange}
                    placeholder="0x..."
                    className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                    disabled={!config.enabled}
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    SUI-Stablecoin pool object ID (required for auto-swap)
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cetus Global Config ID
                  </label>
                  <input
                    type="text"
                    value={config.globalConfigId || ''}
                    onChange={handleGlobalConfigIdChange}
                    placeholder="0x..."
                    className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                    disabled={!config.enabled}
                  />
                  <p className="mt-1 text-sm text-gray-500">
                    Cetus global configuration object ID (required for auto-swap)
                  </p>
                </div>
                
                <div className="pt-5">
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={handleSaveConfig}
                      disabled={saving || (config.enabled && (!config.poolId || !config.globalConfigId))}
                      className={`py-2 px-4 rounded-md font-medium transition-colors ${
                        saving || (config.enabled && (!config.poolId || !config.globalConfigId))
                          ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                          : "bg-blue-600 text-white hover:bg-blue-700"
                      }`}
                    >
                      {saving ? "Saving..." : "Save Configuration"}
                    </button>
                  </div>
                  
                  {config.enabled && (!config.poolId || !config.globalConfigId) && (
                    <p className="mt-2 text-sm text-center text-red-600">
                      Pool ID and Global Config ID are required when auto-swap is enabled
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      
      <style jsx>{`
        .toggle-checkbox:checked + .toggle-label {
          background-color: #3b82f6;
        }
        .toggle-checkbox:checked {
          transform: translateX(100%);
          border-color: #3b82f6;
        }
      `}</style>
    </div>
  );
} 