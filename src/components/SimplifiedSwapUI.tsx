import React, { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { swapService, SwapQuote } from '../services/swap-service';
import { ArrowDown, Settings, AlertCircle, Info, CheckCircle2, TrendingUp } from 'lucide-react';
import { priceService } from '../services/price-service';
import ConfirmationModal from './ConfirmationModal';
import { SuiClient } from '@mysten/sui/client';

// Maximum number of retries for deposit attempts
const MAX_RETRIES = 3;

interface SimplifiedSwapUIProps {
  walletId: string;
  circleId: string;
  contributionAmount: number;
  securityDepositPaid: boolean; // Whether the security deposit has been paid
  securityDepositAmount: number; // Amount of the security deposit
  onComplete?: () => void;
}

const SimplifiedSwapUI: React.FC<SimplifiedSwapUIProps> = ({
  walletId,
  circleId,
  contributionAmount,
  securityDepositPaid = true, // Default to true for backward compatibility
  securityDepositAmount = 0,
  onComplete,
}) => {
  // Add debug logs to understand the data flow
  console.log('[SimplifiedSwapUI] Initializing. securityDepositPaid:', securityDepositPaid);
  console.log('[SimplifiedSwapUI] contributionAmount prop:', contributionAmount);
  console.log('[SimplifiedSwapUI] securityDepositAmount prop:', securityDepositAmount);
  
  // This is where the conversion happens - if the value is already in SUI (not raw), this is incorrect
  const requiredAmount = securityDepositPaid ? contributionAmount : securityDepositAmount;
  console.log('[SimplifiedSwapUI] Calculated requiredAmount:', requiredAmount);
  
  // Remove unused variable
  // const rawRequired = requiredAmount * 1e9;  // This assumes the incoming value is in SUI units
  console.log('[SimplifiedSwapUI] Setting initial amount state to:', requiredAmount.toString());

  const { account } = useAuth();
  const [amount, setAmount] = useState<string>('');
  const [receiveAmount, setReceiveAmount] = useState<string>('0.0');
  const [swapQuote, setSwapQuote] = useState<SwapQuote | null>(null);
  const [processing, setProcessing] = useState<boolean>(false);
  const [slippage, setSlippage] = useState<number>(5.0); // Increased default slippage from 2.0% to 5.0%
  const [customSlippage, setCustomSlippage] = useState<string>('');
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [suiPrice, setSuiPrice] = useState<number | null>(null);
  const [effectiveRate, setEffectiveRate] = useState<number | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<'underpaid' | 'overpaid' | 'exact' | null>(null);
  const [suggestedAmount, setSuggestedAmount] = useState<number | null>(null);
  
  // New state variables for two-transaction approach
  const [transactionStep, setTransactionStep] = useState<'swap' | 'deposit' | 'complete'>('swap');
  const [swapTxDigest, setSwapTxDigest] = useState<string | null>(null);
  const [swappedCoinId, setSwappedCoinId] = useState<string | null>(null);
  const [depositProcessing, setDepositProcessing] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  
  // New state variables for slippage error modal
  const [showSlippageErrorModal, setShowSlippageErrorModal] = useState<boolean>(false);
  const [recommendedSlippage, setRecommendedSlippage] = useState<number>(10);

  // Determine the required amount based on whether security deposit is paid
  const paymentType = securityDepositPaid ? 'contribution' : 'security deposit';

  // Constants for this form
  const SUI_COIN_TYPE = '0x2::sui::SUI';
  const USDC_COIN_TYPE = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
  const ESTIMATED_GAS_FEE = 0.00021; // Estimated gas fee in SUI (adjust based on network conditions)

  // Fetch SUI price when component mounts
  useEffect(() => {
    const fetchSuiPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price && !isNaN(price) && price > 0) {
          setSuiPrice(price);
          setEffectiveRate(price); // Set initial effective rate to match SUI price
          console.log('Fetched SUI price for swap:', price);
          
          // Update the receive amount based on live price if we have an amount
          if (amount && parseFloat(amount) > 0) {
            const suiAmount = parseFloat(amount);
            const usdcAmount = suiAmount * price;
            setReceiveAmount(usdcAmount.toFixed(2));
          }
          
          // Calculate suggested amount with slippage and gas
          if (requiredAmount > 0) {
            calculateSuggestedAmount(requiredAmount, price, slippage);
          }
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
      }
    };
    
    fetchSuiPrice();
  }, []);

  // Initialize with required amount
  useEffect(() => {
    if (requiredAmount > 0) {
      setAmount(requiredAmount.toString());
      getSwapEstimate(requiredAmount.toString());
      
      // Calculate suggested amount with slippage and gas if we have price
      if (suiPrice) {
        calculateSuggestedAmount(requiredAmount, suiPrice, slippage);
      }
    }
  }, [requiredAmount, suiPrice]);

  // Update suggested amount when slippage changes
  useEffect(() => {
    if (requiredAmount > 0 && suiPrice) {
      calculateSuggestedAmount(requiredAmount, suiPrice, slippage);
    }
  }, [slippage, requiredAmount]);

  const calculateSuggestedAmount = (baseAmount: number, price: number, slippagePercent: number) => {
    // Calculate slippage buffer (e.g., 0.5% of the base amount)
    const slippageBuffer = baseAmount * (slippagePercent / 100);
    
    // Calculate total suggested amount (base + slippage buffer + gas fee)
    const total = baseAmount + slippageBuffer + ESTIMATED_GAS_FEE;
    
    setSuggestedAmount(total);
    return total;
  };

  // Check if the current amount is underpaid or overpaid
  const checkPaymentStatus = (currentAmount: number) => {
    if (!requiredAmount || requiredAmount <= 0) {
      setPaymentStatus(null);
      return;
    }
    
    // Calculate difference as a percentage of required amount
    const diff = ((currentAmount - requiredAmount) / requiredAmount) * 100;
    
    if (Math.abs(diff) < 0.1) {
      // Consider it exact if the difference is less than 0.1%
      setPaymentStatus('exact');
    } else if (diff < 0) {
      setPaymentStatus('underpaid');
    } else {
      setPaymentStatus('overpaid');
    }
  };

  const getSwapEstimate = async (inputAmount: string) => {
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      setReceiveAmount('0.0');
      setSwapQuote(null);
      setPaymentStatus(null);
      return;
    }

    if (!circleId) {
      toast.error('Circle ID is required for swap estimation');
      return;
    }
    
    const parsedAmount = parseFloat(inputAmount);
    checkPaymentStatus(parsedAmount);
    
    try {
      // If we have a live SUI price, use it for the calculation instead of the API
      if (suiPrice && suiPrice > 0) {
        const suiAmount = parsedAmount;
        const usdcAmount = suiAmount * suiPrice; // Use live SUI price for calculation
        
        // Create a swapQuote with the live price data
        const quote: SwapQuote = {
          amountIn: suiAmount,
          amountOut: usdcAmount * 1e6, // Convert to micro USDC
          price: suiPrice,
          priceImpact: 0.10, // Use a fixed low price impact for better UX
          poolId: 'live-price'
        };
        
        setSwapQuote(quote);
        setReceiveAmount(usdcAmount.toFixed(2));
        
        // Calculate and set the effective rate (this should match the displayed rate)
        setEffectiveRate(suiPrice);
        
        return;
      }
      
      // Fallback to service if no live price available
      const quote = await swapService.getSwapEstimate(
        SUI_COIN_TYPE,
        USDC_COIN_TYPE,
        parsedAmount,
        circleId
      );
      
      if (quote) {
        setSwapQuote(quote);
        // Format USDC amount with 2 decimal places
        setReceiveAmount((quote.amountOut / 1e6).toFixed(2));
        
        // Calculate the effective rate from quote
        const calculatedRate = quote.amountOut / (quote.amountIn * 1e6);
        setEffectiveRate(calculatedRate);
      } else {
        setReceiveAmount('0.0');
        setEffectiveRate(null);
      }
    } catch (error) {
      console.error('Error in getSwapEstimate:', error);
      toast.error('Failed to get swap estimate');
      setReceiveAmount('0.0');
      setEffectiveRate(null);
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setAmount(value);
    
    const parsedAmount = parseFloat(value);
    if (!isNaN(parsedAmount)) {
      checkPaymentStatus(parsedAmount);
    } else {
      setPaymentStatus(null);
    }
    
    // If we have a live SUI price, calculate directly
    if (suiPrice && suiPrice > 0 && value && parseFloat(value) > 0) {
      const suiAmount = parseFloat(value);
      const usdcAmount = suiAmount * suiPrice;
      setReceiveAmount(usdcAmount.toFixed(2));
      
      // Create a swapQuote with the live price data
      const quote: SwapQuote = {
        amountIn: suiAmount,
        amountOut: usdcAmount * 1e6, // Convert to micro USDC
        price: suiPrice,
        priceImpact: 0.10, // Use a fixed low price impact
        poolId: 'live-price'
      };
      
      setSwapQuote(quote);
      setEffectiveRate(suiPrice);
    } else {
      getSwapEstimate(value);
    }
  };

  const handleSuggestedClick = () => {
    // Set to suggested amount if available
    if (suggestedAmount) {
      setAmount(suggestedAmount.toFixed(8));
      
      // Calculate directly if we have SUI price
      if (suiPrice && suiPrice > 0) {
        const usdcAmount = suggestedAmount * suiPrice;
        setReceiveAmount(usdcAmount.toFixed(2));
        
        // Create a swapQuote with the live price data
        const quote: SwapQuote = {
          amountIn: suggestedAmount,
          amountOut: usdcAmount * 1e6, // Convert to micro USDC
          price: suiPrice,
          priceImpact: 0.10, // Use a fixed low price impact
          poolId: 'live-price'
        };
        
        setSwapQuote(quote);
        setEffectiveRate(suiPrice);
        checkPaymentStatus(suggestedAmount);
      } else {
        getSwapEstimate(suggestedAmount.toString());
      }
    }
  };

  const handleMaxClick = () => {
    if (requiredAmount > 0) {
      setAmount(requiredAmount.toString());
      
      // Calculate directly if we have SUI price
      if (suiPrice && suiPrice > 0) {
        const usdcAmount = requiredAmount * suiPrice;
        setReceiveAmount(usdcAmount.toFixed(2));
        
        // Create a swapQuote with the live price data
        const quote: SwapQuote = {
          amountIn: requiredAmount,
          amountOut: usdcAmount * 1e6, // Convert to micro USDC
          price: suiPrice,
          priceImpact: 0.10, // Use a fixed low price impact
          poolId: 'live-price'
        };
        
        setSwapQuote(quote);
        setEffectiveRate(suiPrice);
        checkPaymentStatus(requiredAmount);
      } else {
        getSwapEstimate(requiredAmount.toString());
      }
    }
  };

  const handleHalfClick = () => {
    // Set to half of required amount
    if (requiredAmount > 0) {
      const halfAmount = (requiredAmount / 2).toString();
      setAmount(halfAmount);
      
      // Calculate directly if we have SUI price
      if (suiPrice && suiPrice > 0) {
        const halfSuiAmount = requiredAmount / 2;
        const usdcAmount = halfSuiAmount * suiPrice;
        setReceiveAmount(usdcAmount.toFixed(2));
        
        // Create a swapQuote with the live price data
        const quote: SwapQuote = {
          amountIn: halfSuiAmount,
          amountOut: usdcAmount * 1e6, // Convert to micro USDC
          price: suiPrice,
          priceImpact: 0.10, // Use a fixed low price impact
          poolId: 'live-price'
        };
        
        setSwapQuote(quote);
        setEffectiveRate(suiPrice);
        checkPaymentStatus(halfSuiAmount);
      } else {
        getSwapEstimate(halfAmount);
      }
    }
  };

  // Calculate amount based on fixed output value (reverse calculation)
  const setFixedOutput = (outputValue: number) => {
    if (suiPrice && suiPrice > 0) {
      // Calculate required SUI to get this fixed USDC amount
      const requiredSui = outputValue / suiPrice;
      setAmount(requiredSui.toFixed(18)); // Use more precision for SUI
      setReceiveAmount(outputValue.toFixed(2));
      
      // Create swap quote
      const quote: SwapQuote = {
        amountIn: requiredSui,
        amountOut: outputValue * 1e6, // Convert to micro USDC
        price: suiPrice,
        priceImpact: 0.10,
        poolId: 'live-price'
      };
      
      setSwapQuote(quote);
      setEffectiveRate(suiPrice);
      checkPaymentStatus(requiredSui);
    }
  };

  // Pre-populate with a fixed USDC output amount
  useEffect(() => {
    // If we have the price but no amount set yet, default to 1.00 USDC output
    if (suiPrice && suiPrice > 0 && (!amount || parseFloat(amount) === 0) && !requiredAmount) {
      setFixedOutput(1.00); // Default to 1.00 USDC only if no required amount
    }
  }, [suiPrice]);

  const handleCustomSlippageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCustomSlippage(value);
    
    // Parse and set the slippage if valid
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
      setSlippage(parsed);
    }
  };

  // First transaction: Execute just the swap
  const handleSwap = async () => {
    if (!swapQuote || !account || !amount) {
      toast.error('Please enter an amount to swap');
      return;
    }

    setProcessing(true);
    
    try {
      // Clear any existing toasts first
      toast.dismiss('swap-step');
      toast.loading('Processing SUI to USDC swap...', { id: 'swap-step' });
      
      // Calculate minimum amount out based on slippage
      // Use a more aggressive slippage buffer for volatile markets
      const effectiveSlippage = slippage * 1.2; // Add 20% extra buffer to the selected slippage
      console.log(`Using effective slippage of ${effectiveSlippage}% (user selected ${slippage}%)`);
      
      const minAmountOut = Math.max(
        100, // Minimum safety floor
        Math.floor(swapQuote.amountOut * (1 - effectiveSlippage / 100))
      );
      
      // IMPORTANT: Use the raw SUI amount directly without additional conversion
      const suiAmountToSend = parseFloat(amount);
      
      console.log('Sending swap-only request with detailed parameters:', {
        suiAmount: suiAmountToSend,
        quoteAmountOut: swapQuote.amountOut,
        minAmountOut,
        slippage: effectiveSlippage,
        priceImpact: swapQuote.priceImpact
      });
      
      // Use zkLogin API to execute just the swap (without deposit)
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'executeSwapOnly', // New API action for swap only
          account,
          suiAmount: suiAmountToSend,
          minAmountOut,
          slippage: effectiveSlippage, // Use the buffered slippage value
        }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        console.error('Swap failed:', result);
        
        // Check if we need to reauthenticate
        if (result.requireRelogin) {
          toast.error('Your session has expired. Please login again.', { id: 'swap-step' });
          
          // Redirect to login page after a short delay
          setTimeout(() => {
            window.location.href = '/';
          }, 2000);
          return;
        }
        
        // Check for detailed error information
        let errorMessage = result.error || 'Swap failed';
        if (result.details) {
          console.error('Error details:', result.details);
          
          // Extract specific error patterns
          if (typeof result.details === 'string') {
            if (result.details.includes('insufficient gas')) {
              errorMessage = 'Insufficient SUI for gas fees. Please add more SUI to your wallet.';
              toast.error(errorMessage, { id: 'swap-step' });
            } else if (result.details.includes('coin balance too low')) {
              errorMessage = 'Your wallet balance is too low for this swap.';
              toast.error(errorMessage, { id: 'swap-step' });
            } else if (result.details.includes('function not found')) {
              errorMessage = 'Swap failed: Cetus pool module not found. Please contact support.';
              toast.error(errorMessage, { id: 'swap-step' });
            } else if (result.details.includes('Pool does not exist')) {
              errorMessage = 'The SUI/USDC liquidity pool is not available. Please try again later.';
              toast.error(errorMessage, { id: 'swap-step' });
            } else if (result.details.includes('Slippage tolerance exceeded') || 
                      (result.details.includes('MoveAbort') && result.details.includes('1) in command 2'))) {
              // For slippage errors, show the modal instead of a toast
              const newRecommendedSlippage = Math.min(50, Math.ceil(slippage * 2));
              toast.dismiss('swap-step'); // Dismiss the loading toast
              
              setRecommendedSlippage(newRecommendedSlippage);
              setShowSlippageErrorModal(true);
              setProcessing(false);
              return; // Exit early without throwing error since we're handling with modal
            }
          }
        }
        
        throw new Error(errorMessage);
      }
      
      toast.success('SUI to USDC swap completed successfully!', { id: 'swap-step' });
      console.log('Swap transaction executed with digest:', result.digest);
      
      // Store the swap transaction digest and coin ID for the next step
      setSwapTxDigest(result.digest);
      setSwappedCoinId(result.createdCoinId); // API should return the created USDC coin's ID
      
      // Move to the deposit step
      setTransactionStep('deposit');
    } catch (error) {
      console.error('Error in swap step:', error);
      
      toast.error(
        error instanceof Error 
          ? `Swap failed: ${error.message}` 
          : 'Swap failed. Please try again.',
        { id: 'swap-step' }
      );
    } finally {
      setProcessing(false);
    }
  };

  // New function to handle slippage confirmation
  const handleSlippageConfirmation = () => {
    // Update slippage to recommended value
    setSlippage(recommendedSlippage);
    
    // Show settings to inform the user of the change
    setShowSettings(true);
    
    // Try the swap again after a short delay to allow UI update
    setTimeout(() => {
      handleSwap();
    }, 100);
  };
  
  // Second transaction: Deposit the USDC to the custody wallet
  const handleDeposit = async () => {
    if (!swappedCoinId || !account || !circleId || !walletId) {
      toast.error("Missing required information for deposit", { id: 'deposit-step' });
      return;
    }
    
    setDepositProcessing(true);
    toast.loading('Preparing deposit transaction...', { id: 'deposit-step' });
    
    try {
      // First, fetch the USDC coin details to confirm it exists and get the value
      const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      let coinObject;
      
      try {
        coinObject = await suiClient.getObject({
          id: swappedCoinId,
          options: { showContent: true }
        });
        
        if (!coinObject.data?.content || !('fields' in coinObject.data.content)) {
          throw new Error('Coin object not found or invalid');
        }
        
        console.log('USDC coin found:', coinObject);
      } catch (error) {
        console.error('Error fetching USDC coin:', error);
        throw new Error('USDC coin not found. The blockchain might still be processing the swap transaction. Please wait a moment and try again.');
      }

      // Now, fetch the exact required deposit amount from the circle
      let requiredDepositUsd = 0;
      
      try {
        // First get the dynamic fields to find the config object
        const dynamicFields = await suiClient.getDynamicFields({
          parentId: circleId
        });
        
        console.log('Looking for CircleConfig in dynamic fields...');
        
        // Find the CircleConfig field
        let configFieldObjectId = null;
        for (const field of dynamicFields.data) {
          if (field.name && 
              typeof field.name === 'object' && 
              'type' in field.name && 
              field.name.type && 
              field.name.type.includes('vector<u8>') && 
              field.objectType && 
              field.objectType.includes('CircleConfig')) {
            
            configFieldObjectId = field.objectId;
            console.log(`Found CircleConfig dynamic field: ${configFieldObjectId}`);
            break;
          }
        }
        
        // Get the CircleConfig object if found
        if (configFieldObjectId) {
          const configObject = await suiClient.getObject({
            id: configFieldObjectId,
            options: { showContent: true }
          });
          
          if (configObject.data?.content && 
              'fields' in configObject.data.content &&
              'value' in configObject.data.content.fields) {
            
            const valueField = configObject.data.content.fields.value;
            if (typeof valueField === 'object' && 
                valueField !== null && 
                'fields' in valueField) {
              
              // Extract the security_deposit_usd field for security deposits
              // or contribution_amount_usd for regular contributions
              const configFields = valueField.fields as Record<string, unknown>;
              if (!securityDepositPaid) {
                requiredDepositUsd = Number(configFields.security_deposit_usd || 0);
                console.log('Found security_deposit_usd:', requiredDepositUsd);
              } else {
                requiredDepositUsd = Number(configFields.contribution_amount_usd || 0);
                console.log('Found contribution_amount_usd:', requiredDepositUsd);
              }
              
              // Note: The USD amounts are in CENTS, 
              // so 20 = $0.20, 2000 = $20.00
            }
          }
        }
      } catch (error) {
        console.error('Error fetching circle config details:', error);
      }

      // Make the deposit call with the extra required deposit information
      const depositResponse = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'depositStablecoin',
          account,
          circleId,
          walletId,
          coinObjectId: swappedCoinId,
          stablecoinType: USDC_COIN_TYPE,
          requiredDepositUsd // Include the USD amount for server-side handling
        }),
      });
      
      const result = await depositResponse.json();
      
      if (!depositResponse.ok) {
        console.error('Deposit response error:', result);
        
        // Handle error from invalid coin ID
        if (retryCount < MAX_RETRIES && result.error && (
          result.error.includes('object not found') ||
          result.error.includes('Object does not exist')
        )) {
          toast.error('Retrying deposit... Waiting for blockchain to process swap.', { id: 'deposit-step', duration: 5000 });
          
          // Wait a bit and retry
          setTimeout(() => {
            setDepositProcessing(false);
            setRetryCount(prev => prev + 1);
          }, 3000);
          return;
        }
        
        // Handle deposit amount mismatch errors (specifically error code 2)
        if (result.error && (
          result.error.includes('deposit amount does not match') ||
          result.error.includes('EIncorrectDepositAmount') ||
          result.error.match(/MoveAbort\(.+, 2\)/)
        )) {
          toast.error(
            'The deposit amount doesn\'t match the required amount. This might be due to a currency conversion issue. Please try again.',
            { id: 'deposit-step', duration: 8000 }
          );
          setDepositProcessing(false);
          return;
        }
        
        // Handle member status errors (specifically inactive member, error code 14)
        if (result.error && (
          result.error.includes('membership is not active') ||
          result.error.includes('Member is not active') ||
          result.error.includes('EMemberNotActive') ||
          result.error.match(/MoveAbort\(.+, 14\)/)
        )) {
          // Show a more user-friendly message
          toast.error(
            'Your membership needs to be activated by the circle admin before you can deposit. Please contact the admin to activate your membership.',
            { id: 'deposit-step', duration: 8000 }
          );
          setDepositProcessing(false);
          return;
        }
        
        // Handle already paid deposit error (error code 21)
        if (result.error && (
          result.error.includes('already paid') ||
          result.error.includes('EDepositAlreadyPaid') ||
          result.error.match(/MoveAbort\(.+, 21\)/)
        )) {
          toast.success(
            'You have already paid the security deposit for this circle!',
            { id: 'deposit-step', duration: 5000 }
          );
          
          // Notify of success since the user's goal is already achieved
          setTransactionStep('complete');
          
          // Reset form and notify parent after completion
          setTimeout(() => {
            if (onComplete) {
              onComplete();
            }
          }, 3000);
          
          setDepositProcessing(false);
          return;
        }
        
        throw new Error(result.error || 'Failed to deposit USDC');
      }
      
      // Success path
      toast.success(
        !securityDepositPaid 
          ? 'Security deposit paid successfully!' 
          : 'Contribution made successfully!', 
        { id: 'deposit-step' }
      );
      console.log('Deposit transaction executed with digest:', result.digest);
      
      // Move to the complete step
      setTransactionStep('complete');
      
      // Reset form and notify parent after completion
      setTimeout(() => {
        setAmount('');
        setReceiveAmount('0.0');
        setSwapQuote(null);
        setSwapTxDigest(null);
        setSwappedCoinId(null);
        setRetryCount(0);
        
        // Reset back to swap step for next transaction
        setTransactionStep('swap');
        
        // Notify parent component
        if (onComplete) {
          onComplete();
        }
      }, 3000);
    } catch (error) {
      console.error('Error in deposit step:', error);
      
      toast.error(
        error instanceof Error 
          ? `Deposit failed: ${error.message}` 
          : 'Deposit failed. Please try again.',
        { id: 'deposit-step' }
      );
    } finally {
      setDepositProcessing(false);
    }
  };

  // Replace the original handleSwapAndDeposit with a function that calls the appropriate handler
  const handleSwapAndDeposit = async () => {
    if (transactionStep === 'swap') {
      await handleSwap();
    } else if (transactionStep === 'deposit') {
      await handleDeposit();
    }
  };

  // Format price impact to show color based on severity
  const renderPriceImpact = () => {
    if (!swapQuote) return "0.00%";
    
    const impact = swapQuote.priceImpact;
    let colorClass = "text-green-500";
    
    if (impact > 5) {
      colorClass = "text-red-500";
    } else if (impact > 1) {
      colorClass = "text-amber-500";
    }
    
    return (
      <span className={colorClass}>
        {impact.toFixed(2)}%
      </span>
    );
  };

  // Render payment status message
  const renderPaymentStatus = () => {
    if (!paymentStatus || paymentStatus === 'exact') return null;
    
    const currentAmount = parseFloat(amount);
    const difference = Math.abs(currentAmount - requiredAmount).toFixed(6);
    const percentDiff = Math.abs(((currentAmount - requiredAmount) / requiredAmount) * 100).toFixed(1);
    
    if (paymentStatus === 'underpaid') {
      return (
        <div className="flex items-center space-x-1 text-amber-500 text-sm mt-1">
          <AlertCircle size={14} />
          <span>Underpaying by {difference} SUI ({percentDiff}%)</span>
        </div>
      );
    } else if (paymentStatus === 'overpaid') {
      return (
        <div className="flex items-center space-x-1 text-blue-500 text-sm mt-1">
          <AlertCircle size={14} />
          <span>Overpaying by {difference} SUI ({percentDiff}%)</span>
        </div>
      );
    }
    
    return null;
  };

  // Render transaction step indicator
  const renderTransactionSteps = () => {
    return (
      <div className="flex justify-between items-center mb-4 border-b border-gray-800 pb-3">
        <div className="flex items-center">
          <div className={`flex items-center justify-center w-6 h-6 rounded-full mr-2 ${
            transactionStep === 'swap' 
              ? 'bg-blue-600 text-white' 
              : transactionStep === 'deposit' || transactionStep === 'complete' 
                ? 'bg-green-500 text-white' 
                : 'bg-gray-700 text-gray-300'
          }`}>
            {transactionStep === 'swap' ? '1' : <CheckCircle2 size={14} />}
          </div>
          <span className={transactionStep === 'swap' ? 'text-white font-medium' : 'text-gray-300'}>Swap SUI to USDC</span>
        </div>
        
        <div className="w-8 h-0.5 bg-gray-700"></div>
        
        <div className="flex items-center">
          <div className={`flex items-center justify-center w-6 h-6 rounded-full mr-2 ${
            transactionStep === 'deposit' 
              ? 'bg-blue-600 text-white' 
              : transactionStep === 'complete' 
                ? 'bg-green-500 text-white' 
                : 'bg-gray-700 text-gray-300'
          }`}>
            {transactionStep === 'deposit' ? '2' : transactionStep === 'complete' ? <CheckCircle2 size={14} /> : '2'}
          </div>
          <span className={transactionStep === 'deposit' ? 'text-white font-medium' : 'text-gray-300'}>Deposit to Circle</span>
        </div>
      </div>
    );
  };

  // Get button text based on current transaction step
  const getButtonText = () => {
    if (transactionStep === 'swap') {
      if (processing) {
        return (
          <span className="flex items-center justify-center">
            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Swapping SUI to USDC...
          </span>
        );
      }

      if (!swapQuote || parseFloat(amount) <= 0) {
        return "Enter an amount";
      }

      return "Swap SUI to USDC";
    } else if (transactionStep === 'deposit') {
      if (depositProcessing) {
        return (
          <span className="flex items-center justify-center">
            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Depositing USDC...
          </span>
        );
      }

      return securityDepositPaid 
        ? "Deposit as Contribution" 
        : "Deposit as Security Deposit";
    }

    return "Processing...";
  };

  // Render the success message when transaction is complete
  const renderCompletionMessage = () => {
    if (transactionStep !== 'complete') return null;

    return (
      <div className="bg-green-900/30 border border-green-600/30 rounded-lg p-4 mb-4">
        <div className="flex items-center space-x-3">
          <CheckCircle2 size={24} className="text-green-400" />
          <div>
            <h3 className="font-medium text-green-400">Transaction Complete!</h3>
            <p className="text-sm text-green-300">
              {securityDepositPaid 
                ? 'Your contribution was successfully processed.' 
                : 'Your security deposit was successfully processed.'}
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-[#121212] rounded-xl p-4 text-white">
      {/* Slippage Error Modal */}
      <ConfirmationModal
        isOpen={showSlippageErrorModal}
        onClose={() => setShowSlippageErrorModal(false)}
        onConfirm={handleSlippageConfirmation}
        title="Price Movement Detected"
        confirmText={`Increase Slippage to ${recommendedSlippage}% & Retry`}
        cancelText="Adjust Manually"
        confirmButtonVariant="warning"
        message={
          <div className="space-y-3">
            <div className="flex items-start">
              <TrendingUp className="text-amber-500 mr-2 mt-0.5 flex-shrink-0" />
              <p>
                The SUI/USDC price is moving rapidly and your swap couldn&apos;t be completed with the current 
                slippage tolerance of <span className="font-medium">{slippage}%</span>.
              </p>
            </div>
            <div className="bg-amber-50 p-3 rounded-md border border-amber-200 text-amber-800 text-sm">
              <p className="font-medium mb-1">Recommendation:</p>
              <p>
                Increase your slippage tolerance to <span className="font-bold">{recommendedSlippage}%</span> to 
                accommodate current market volatility.
              </p>
            </div>
            <div className="text-sm text-gray-600">
              <p>You can also close this dialog and adjust slippage manually in settings.</p>
            </div>
          </div>
        }
      />

      {/* Header section */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex space-x-6">
          <button className="text-white border-b-2 border-white pb-1 font-medium">Swap</button>
        </div>
        <div className="flex items-center space-x-2">
          <div className="bg-[#232323] px-3 py-1 rounded-md flex items-center">
            <span>{slippage}%</span>
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className="ml-2"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Transaction steps indicator */}
      {renderTransactionSteps()}
      
      {/* Completion message */}
      {renderCompletionMessage()}

      {/* Settings panel */}
      {showSettings && (
        <div className="bg-[#232323] p-3 rounded-lg mb-4">
          <div className="mb-2">
            <label className="text-sm text-gray-400">Slippage Tolerance</label>
            <div className="flex mt-1 space-x-2 flex-wrap">
              {[1.0, 2.0, 5.0, 10.0, 15.0].map(value => (
                <button
                  key={value}
                  onClick={() => setSlippage(value)}
                  className={`px-3 py-1 rounded-md text-sm mb-1 ${
                    slippage === value 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-[#333333] text-gray-300'
                  }`}
                >
                  {value}%
                </button>
              ))}
            </div>
            
            {/* Custom slippage input */}
            <div className="flex items-center mt-2">
              <input
                type="number"
                value={customSlippage}
                onChange={handleCustomSlippageChange}
                placeholder="Custom (1-50%)"
                className="bg-[#333333] text-white text-sm px-3 py-1 rounded-md w-full"
                min="0.1"
                max="50"
                step="0.1"
              />
            </div>
            
            <div className="mt-2 text-xs text-amber-400">
              <div className="flex items-start">
                <Info size={12} className="mr-1 mt-0.5 flex-shrink-0" />
                <span>
                  <strong>High price volatility detected!</strong> The SUI/USDC pool is experiencing significant price movement. 
                  Higher slippage values (10-15%) may be needed for successful swaps during these market conditions.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step-specific info banners */}
      {transactionStep === 'swap' && !securityDepositPaid && (
        <div className="bg-[#1E1E2E] border border-blue-600/30 rounded-lg p-3 mb-3 text-sm">
          <div className="flex items-start space-x-2">
            <Info size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
            <span>Step 1: Swap your SUI to USDC for security deposit. After completing this step, you&apos;ll need to deposit the USDC.</span>
          </div>
        </div>
      )}
      
      {transactionStep === 'deposit' && (
        <div className="bg-[#1E1E2E] border border-blue-600/30 rounded-lg p-3 mb-3 text-sm">
          <div className="flex items-start space-x-2">
            <Info size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
            <span>Step 2: Deposit the swapped USDC to the circle&apos;s custody wallet as {securityDepositPaid ? 'your contribution' : 'security deposit'}.</span>
          </div>
        </div>
      )}

      {/* Form fields - only shown in swap step */}
      {transactionStep === 'swap' && (
        <>
          {/* Required amount info */}
          {requiredAmount > 0 && (
            <div className="bg-[#1A1A1A] rounded-lg p-3 mb-3 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Required {paymentType}:</span>
                <span>{requiredAmount} SUI</span>
              </div>
              {suggestedAmount && (
                <div className="flex justify-between items-center mt-1">
                  <span className="text-gray-400">Suggested amount (with {slippage}% slippage + gas):</span>
                  <div className="flex items-center">
                    <span>{suggestedAmount.toFixed(6)} SUI</span>
                    <button
                      onClick={handleSuggestedClick}
                      className="ml-2 bg-blue-600 hover:bg-blue-700 text-xs px-2 py-1 rounded"
                    >
                      Use
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* You Pay section */}
          <div className="bg-[#1A1A1A] rounded-lg p-4 mb-2">
            <div className="flex justify-between text-gray-400 mb-1">
              <span>You Pay</span>
            </div>
            <div className="flex justify-between items-center">
              <input
                type="number"
                value={amount}
                onChange={handleAmountChange}
                placeholder="0.0"
                className="bg-transparent text-2xl outline-none w-full"
                disabled={processing}
              />
              <div className="flex flex-col items-end">
                <div className="flex items-center bg-[#333333] py-1 px-3 rounded-lg mb-1">
                  <span className="font-medium">SUI</span>
                </div>
                <div className="flex space-x-1">
                  <button 
                    onClick={handleHalfClick}
                    className="bg-[#2D2D2D] hover:bg-[#444444] text-xs px-2 py-1 rounded"
                  >
                    HALF
                  </button>
                  <button 
                    onClick={handleMaxClick}
                    className="bg-[#2D2D2D] hover:bg-[#444444] text-xs px-2 py-1 rounded"
                  >
                    MAX
                  </button>
                </div>
              </div>
            </div>
            {renderPaymentStatus()}
          </div>

          {/* Arrow */}
          <div className="flex justify-center -my-1 relative z-10">
            <div className="bg-[#121212] p-2 rounded-full">
              <ArrowDown size={16} className="text-gray-400" />
            </div>
          </div>

          {/* You Receive section */}
          <div className="bg-[#1A1A1A] rounded-lg p-4 mt-2">
            <div className="flex justify-between text-gray-400 mb-1">
              <span>You Receive</span>
            </div>
            <div className="flex justify-between items-center">
              <input
                type="text"
                value={receiveAmount}
                readOnly
                className="bg-transparent text-2xl outline-none w-full"
              />
              <div className="flex items-center bg-[#333333] py-1 px-3 rounded-lg">
                <span className="font-medium">USDC</span>
              </div>
            </div>
          </div>

          {/* Price details */}
          {swapQuote && (
            <div className="mt-4 bg-transparent px-1">
              <div className="flex justify-between items-center text-sm text-gray-400 mb-1">
                <span>Rate</span>
                <span>1 SUI = {effectiveRate ? effectiveRate.toFixed(4) : '0.00'} USDC</span>
              </div>
              <div className="flex justify-between items-center text-sm text-gray-400">
                <span>Price Impact</span>
                {renderPriceImpact()}
              </div>
              <div className="flex justify-between items-center text-sm text-gray-400 mt-1">
                <span>Network Fee</span>
                <span>~{ESTIMATED_GAS_FEE.toFixed(6)} SUI</span>
              </div>
              <div className="flex justify-between items-center text-sm text-gray-400 mt-1">
                <span>Swap Provider</span>
                <span className="text-blue-400">Cetus</span>
              </div>
              {swapQuote.priceImpact > 5 && (
                <div className="mt-2 bg-red-900/30 border border-red-600/30 rounded-md p-2 text-xs text-red-300">
                  <div className="flex items-start">
                    <AlertCircle size={12} className="mr-1 mt-0.5 flex-shrink-0 text-red-400" />
                    <span>
                      High price impact detected ({swapQuote.priceImpact.toFixed(2)}%). This trade may result in significant value loss 
                      due to low liquidity. Consider using a higher slippage tolerance or trading a smaller amount.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Transaction details for deposit step */}
      {transactionStep === 'deposit' && (
        <div className="bg-[#1A1A1A] rounded-lg p-4 mb-4">
          <div className="flex justify-between items-center text-sm text-gray-400 mb-2">
            <span>Swap Transaction:</span>
            <a 
              href={`https://explorer.sui.io/txblock/${swapTxDigest}?network=testnet`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline truncate max-w-[180px]"
            >
              {swapTxDigest ? `${swapTxDigest.substring(0, 8)}...` : 'Loading...'}
            </a>
          </div>
          <div className="flex justify-between items-center text-sm text-gray-400 mb-2">
            <span>Swapped Amount:</span>
            <span className="font-medium text-white">{receiveAmount} USDC</span>
          </div>
          <div className="flex justify-between items-center text-sm text-gray-400">
            <span>Destination:</span>
            <span className="font-medium text-white">Circle Custody Wallet</span>
          </div>
        </div>
      )}

      {/* Action button */}
      <button
        onClick={handleSwapAndDeposit}
        disabled={
          (transactionStep === 'swap' && (processing || !swapQuote || parseFloat(amount) <= 0)) ||
          (transactionStep === 'deposit' && depositProcessing) ||
          transactionStep === 'complete'
        }
        className={`w-full py-3 rounded-lg mt-4 text-center font-medium ${
          (transactionStep === 'swap' && (!swapQuote || parseFloat(amount) <= 0)) || transactionStep === 'complete'
            ? 'bg-[#2D2D2D] text-gray-500 cursor-not-allowed' 
            : processing || depositProcessing 
              ? 'bg-blue-800 text-gray-300 cursor-wait' 
              : 'bg-[#4E60FF] hover:bg-[#3A4DE7] text-white'
        }`}
      >
        {getButtonText()}
      </button>
    </div>
  );
};

export default SimplifiedSwapUI; 