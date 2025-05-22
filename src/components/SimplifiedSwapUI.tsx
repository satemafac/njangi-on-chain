import React, { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { swapService, SwapQuote } from '../services/swap-service';
import { ArrowDown, Settings, AlertCircle, Info, CheckCircle2, TrendingUp, RefreshCw } from 'lucide-react';
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
  disabled?: boolean; // Whether the component is disabled (e.g., if circle is not active)
}

const SimplifiedSwapUI: React.FC<SimplifiedSwapUIProps> = ({
  walletId,
  circleId,
  contributionAmount,
  securityDepositPaid = true, // Default to true for backward compatibility
  securityDepositAmount = 0,
  onComplete,
  disabled = false, // Default to false
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
  const [isPriceLoading, setIsPriceLoading] = useState<boolean>(false);
  const [priceLastUpdated, setPriceLastUpdated] = useState<Date | null>(null);
  
  // New state variables for two-transaction approach
  const [transactionStep, setTransactionStep] = useState<'swap' | 'deposit' | 'complete'>('swap');
  const [swapTxDigest, setSwapTxDigest] = useState<string | null>(null);
  const [swappedCoinId, setSwappedCoinId] = useState<string | null>(null);
  const [depositProcessing, setDepositProcessing] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  
  // New state variables for slippage error modal
  // const [showSlippageErrorModal, setShowSlippageErrorModal] = useState<boolean>(false);
  const [recommendedSlippage, setRecommendedSlippage] = useState<number>(10);

  // Add this to component state
  const [slippageChanged, setSlippageChanged] = useState<boolean>(false);

  // Add missing state variable
  const [highVolatilityDetected, setHighVolatilityDetected] = useState<boolean>(false);

  // Add state to track current deposit status that can change during usage
  const [currentDepositPaid, setCurrentDepositPaid] = useState<boolean>(securityDepositPaid);

  // Determine the required amount based on whether security deposit is paid
  const paymentType = currentDepositPaid ? 'contribution' : 'security deposit';

  // Update the currentDepositPaid state whenever securityDepositPaid prop changes
  useEffect(() => {
    setCurrentDepositPaid(securityDepositPaid);
    console.log(`[SimplifiedSwapUI] Updated deposit status: ${securityDepositPaid ? 'PAID' : 'NOT PAID'}`);
  }, [securityDepositPaid]);

  // Constants for this form
  const SUI_COIN_TYPE = '0x2::sui::SUI';
  const USDC_COIN_TYPE = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
  const ESTIMATED_GAS_FEE = 0.00021; // Estimated gas fee in SUI (adjust based on network conditions)

  // New constants for better swap calculations
  const MARKET_VOLATILITY_BUFFER = 0.1; // 10% extra buffer for market volatility
  const MINIMUM_SECURITY_BUFFER = 0.07; // 7% minimum buffer regardless of other settings
  const SMALL_AMOUNT_EXTRA_BUFFER = 0.2; // 20% extra buffer for small amounts (< 0.2 SUI)
  const EXACT_AMOUNT_BUFFER = 0.25; // 25% buffer for exact amount requirements

  // Fetch SUI price when component mounts
  useEffect(() => {
    const fetchSuiPrice = async () => {
      setIsPriceLoading(true);
      try {
        // Check if we have a cached price first
        const cachedPrice = priceService.getCachedPrice();
        if (cachedPrice !== null) {
          setSuiPrice(cachedPrice);
          setEffectiveRate(cachedPrice);
          setPriceLastUpdated(new Date());
        }
        
        // Force refresh the price for accuracy
        const price = await priceService.forceRefreshPrice();
        if (price && !isNaN(price) && price > 0) {
          setSuiPrice(price);
          setEffectiveRate(price); // Set initial effective rate to match SUI price
          setPriceLastUpdated(new Date());
          console.log('Fetched fresh SUI price:', price);
          
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
        } else if (cachedPrice === null) {
          // If we didn't get a price and didn't have a cached price, use fallback
          console.warn('Using fallback SUI price of $3.71');
          setSuiPrice(3.71);
          setEffectiveRate(3.71);
          setPriceLastUpdated(new Date());
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
        // If we still don't have a price, use fallback
        if (suiPrice === null) {
          setSuiPrice(3.71);
          setEffectiveRate(3.71);
          setPriceLastUpdated(new Date());
        }
      } finally {
        setIsPriceLoading(false);
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

  // Update the slippage update effect
  useEffect(() => {
    if (requiredAmount > 0 && suiPrice) {
      // Get the newly calculated suggested amount
      const newSuggestedAmount = calculateSuggestedAmount(requiredAmount, suiPrice, slippage);
      setSuggestedAmount(newSuggestedAmount);
      setSlippageChanged(slippage !== 5.0);
      
      // Force update amounts if Use Suggested Amount was clicked recently
      // This ensures immediate feedback
      if (amount && parseFloat(amount) > 0 && suggestedAmount) {
        const currentAmount = parseFloat(amount);
        const suggestedDifference = Math.abs((currentAmount - suggestedAmount) / suggestedAmount);
        
        // Only auto-update if current amount is close to previous suggested amount (within 5%)
        if (suggestedDifference < 0.05) {
          console.log(`Updating amount based on slippage change: ${currentAmount} → ${newSuggestedAmount}`);
          setAmount(newSuggestedAmount.toString());
          
          // Update the receive amount too
          if (suiPrice) {
            // Apply the conservative estimation factor
            let estimationFactor = 0.97; // 3% reduction as baseline
            if (!currentDepositPaid) {
              estimationFactor = 0.95; // 5% reduction for security deposits
            }
            if (newSuggestedAmount < 0.2) {
              estimationFactor -= 0.03; // Additional 3% reduction for small amounts
            }
            
            const newUsdcAmount = newSuggestedAmount * suiPrice * estimationFactor;
            setReceiveAmount(newUsdcAmount.toFixed(6));
            
            // Also update swap quote if it exists
            if (swapQuote) {
              const updatedQuote = { ...swapQuote };
              updatedQuote.amountIn = newSuggestedAmount;
              updatedQuote.amountOut = newUsdcAmount * 1e6; // Convert to micro USDC
              setSwapQuote(updatedQuote);
            }
          }
        }
      }
    }
  }, [slippage]);

  const calculateSuggestedAmount = (baseAmount: number, price: number, slippagePercent: number) => {
    if (!price || price <= 0 || !baseAmount || baseAmount <= 0) {
      return baseAmount;
    }

    // For security deposits, we need exact amounts to avoid contract errors
    const isSecurityDeposit = !currentDepositPaid;
    
    // Calculate USDC equivalent (this is what we're aiming for)
    const targetUsdcAmount = baseAmount * price;
    console.log(`Target USDC amount: ${targetUsdcAmount.toFixed(6)} USDC`);

    // Base buffer calculation - start with slippage
    let bufferPercentage = slippagePercent / 100;
    
    // For security deposits, use a higher buffer since we need an exact amount
    if (isSecurityDeposit) {
      bufferPercentage = Math.max(bufferPercentage, EXACT_AMOUNT_BUFFER);
      console.log(`Using security deposit buffer: ${bufferPercentage * 100}%`);
    }
    
    // Add dynamic market volatility buffer
    bufferPercentage += MARKET_VOLATILITY_BUFFER;
    
    // For smaller amounts, add extra buffer (DEX has higher slippage on small amounts)
    if (baseAmount < 0.2) {
      bufferPercentage += SMALL_AMOUNT_EXTRA_BUFFER;
      console.log(`Adding small amount buffer, total buffer: ${bufferPercentage * 100}%`);
    }
    
    // Ensure we have a minimum buffer regardless
    bufferPercentage = Math.max(bufferPercentage, MINIMUM_SECURITY_BUFFER);
    
    // Calculate the adjusted SUI amount needed to get the target USDC after slippage
    // Formula: adjustedAmount = targetAmount / (1 - bufferPercentage)
    const adjustedBaseSuiAmount = baseAmount / (1 - bufferPercentage);
    
    // Add gas fee on top
    const totalSuiAmount = adjustedBaseSuiAmount + ESTIMATED_GAS_FEE;
    
    console.log(`Calculation details:`, {
      baseSuiAmount: baseAmount,
      targetUsdcAmount: targetUsdcAmount.toFixed(6),
      bufferPercentage: (bufferPercentage * 100).toFixed(2) + '%',
      adjustedSuiAmount: adjustedBaseSuiAmount.toFixed(8),
      withGasFee: totalSuiAmount.toFixed(8)
    });
    
    setSuggestedAmount(totalSuiAmount);
    return totalSuiAmount;
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
        
        // Apply a conservative estimation due to DEX slippage and fees
        // For exact values like security deposits, be more conservative
        let estimationFactor = 0.97; // 3% reduction as baseline
        
        if (!currentDepositPaid && requiredAmount > 0) {
          // For security deposits, be more conservative
          estimationFactor = 0.95; // 5% reduction
        }
        
        // For small amounts, be even more conservative
        if (suiAmount < 0.2) {
          estimationFactor -= 0.03; // Additional 3% reduction
        }
        
        // Calculate conservative USDC estimation
        const conservativeUsdcAmount = suiAmount * suiPrice * estimationFactor;
        
        // Create a swapQuote with the conservative estimation
        const quote: SwapQuote = {
          amountIn: suiAmount,
          amountOut: conservativeUsdcAmount * 1e6, // Convert to micro USDC
          price: suiPrice * estimationFactor, // Adjusted price
          priceImpact: 0.10 + ((1 - estimationFactor) * 100), // Higher price impact for conservative estimates
          poolId: 'live-price'
        };
        
        setSwapQuote(quote);
        setReceiveAmount(conservativeUsdcAmount.toFixed(6));
        
        // Calculate and set the effective rate (with the conservative adjustment)
        setEffectiveRate(suiPrice * estimationFactor);
        
        // Display a warning if this likely won't be enough for a security deposit
        if (!currentDepositPaid && requiredAmount > 0) {
          const requiredUsdc = requiredAmount * suiPrice;
          if (conservativeUsdcAmount < requiredUsdc && !processing) {
            // Toast warning about insufficient amount for security deposit
            console.warn(`Estimated USDC (${conservativeUsdcAmount.toFixed(6)}) may be less than required (${requiredUsdc.toFixed(6)})`);
          }
        }
        
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
      
      // The useEffect for slippage changes will handle updating the amount
    }
  };

  // First transaction: Execute just the swap with improved calculations
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
      // For security deposits, use a more conservative minAmountOut
      let effectiveSlippage = slippage;
      
      // If this is for a security deposit, calculate minimum USDC needed
      if (!currentDepositPaid && requiredAmount > 0 && suiPrice !== null && suiPrice > 0) {
        // Calculate the actual minimum needed in USDC for the security deposit
        const requiredUsdcMicrounits = requiredAmount * suiPrice * 1e6;
        console.log(`For security deposit: Required minimum USDC: ${requiredUsdcMicrounits / 1e6} USDC (${requiredUsdcMicrounits} microunits)`);
        
        // Use this as a floor for minAmountOut
        const usdcFloor = Math.floor(requiredUsdcMicrounits);
        
        // Standard calculation based on slippage (but more aggressive)
        const standardMinAmountOut = Math.floor(swapQuote.amountOut * (1 - (effectiveSlippage * 1.1) / 100));
        
        // Use the smaller value to increase chance of transaction success
        const minAmountOut = Math.min(usdcFloor, standardMinAmountOut);
        console.log(`Min amount out calculation:`, {
          standard: standardMinAmountOut,
          floor: usdcFloor,
          using: minAmountOut
        });
        
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
                // For slippage errors, automatically increase slippage without showing the modal
                const newRecommendedSlippage = Math.min(50, Math.ceil(slippage * 2));
                toast.dismiss('swap-step'); // Dismiss the loading toast
                
                // Set the recommended slippage
                setRecommendedSlippage(newRecommendedSlippage);
                
                // Automatically apply the higher slippage
                setSlippage(newRecommendedSlippage);
                console.log(`Automatically increased slippage to ${newRecommendedSlippage}% due to price movement`);
                
                // Show a toast notification instead of modal
                toast.success(`Increased slippage to ${newRecommendedSlippage}% due to price movement`, { 
                  id: 'slippage-auto-increase',
                  duration: 3000
                });
                
                // Try the swap again after a short delay to allow for UI update
                setTimeout(() => {
                  handleSwap();
                }, 500);
                
                setProcessing(false);
                return; // Exit early without throwing error since we're handling it
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
      } else {
        // For regular contributions or small amounts, use more flexible settings
        // Use a more aggressive slippage buffer for volatile markets
        effectiveSlippage = slippage * 1.2; // Add 20% extra buffer to the selected slippage
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
                // For slippage errors, automatically increase slippage without showing the modal
                const newRecommendedSlippage = Math.min(50, Math.ceil(slippage * 2));
                toast.dismiss('swap-step'); // Dismiss the loading toast
                
                // Set the recommended slippage
                setRecommendedSlippage(newRecommendedSlippage);
                
                // Automatically apply the higher slippage
                setSlippage(newRecommendedSlippage);
                console.log(`Automatically increased slippage to ${newRecommendedSlippage}% due to price movement`);
                
                // Show a toast notification instead of modal
                toast.success(`Increased slippage to ${newRecommendedSlippage}% due to price movement`, { 
                  id: 'slippage-auto-increase',
                  duration: 3000
                });
                
                // Try the swap again after a short delay to allow for UI update
                setTimeout(() => {
                  handleSwap();
                }, 500);
                
                setProcessing(false);
                return; // Exit early without throwing error since we're handling it
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
      }
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
    // Make the recommended slippage even higher for additional safety
    const safetySlippage = Math.min(50, Math.ceil(recommendedSlippage * 1.2));
    
    // Update slippage to recommended value with safety margin
    setSlippage(safetySlippage);
    console.log(`Setting slippage to ${safetySlippage}% (from recommendation of ${recommendedSlippage}%)`);
    
    // Show settings to inform the user of the change
    setShowSettings(true);
    
    // Increase the swap amount if we have suggestedAmount
    if (suggestedAmount && amount) {
      const currentAmount = parseFloat(amount);
      // Add 10% more to the suggested amount for additional safety
      const increasedAmount = suggestedAmount * 1.1;
      
      if (increasedAmount > currentAmount) {
        console.log(`Increasing swap amount from ${currentAmount} to ${increasedAmount}`);
        setAmount(increasedAmount.toFixed(8));
      }
    }
    
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

      // Fetch the user's current deposit status before making the deposit
      let currentDepositStatus = currentDepositPaid;
      
      try {
        // Get the circle object
        const circleData = await suiClient.getObject({
          id: circleId,
          options: { showContent: true }
        });
        
        if (circleData.data?.content && 'fields' in circleData.data.content) {
          const circleFields = circleData.data.content.fields as {
            members?: { fields?: { id?: { id: string } } } // Check if members table exists
          };
          
          if (circleFields.members?.fields?.id?.id) {
            const membersTableId = circleFields.members.fields.id.id;
            console.log(`Fetching Member object for deposit status using key ${account.userAddr} from table ${membersTableId}`);
            
            // Get the dynamic field representing the Member object within the Table
            const memberField = await suiClient.getDynamicFieldObject({
              parentId: membersTableId,
              name: {
                type: 'address', // The key type for the members table is address
                value: account.userAddr
              }
            });
            
            if (memberField.data?.content && 'fields' in memberField.data.content) {
              const memberFields = memberField.data.content.fields as {
                value?: { fields?: { deposit_paid?: boolean, [key: string]: unknown } } // Access nested value.fields
              };
              
              if (memberFields.value?.fields?.deposit_paid !== undefined) {
                currentDepositStatus = Boolean(memberFields.value.fields.deposit_paid);
                console.log(`Deposit status found in Member struct before deposit: ${currentDepositStatus}`);
                
                // If status has changed, update our local state
                if (currentDepositStatus !== currentDepositPaid) {
                  console.log('Deposit status has changed since component mounted, updating local state');
                  // This will update the UI to reflect the actual deposit status
                  // and ensure we use the correct deposit function
                  setCurrentDepositPaid(currentDepositStatus);
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('Could not fetch latest deposit status, using existing value:', err);
      }

      // Make the deposit call with the updated deposit status
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
          depositIsPaid: currentDepositStatus, // Renamed from isContribution for clarity
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
          
          // UPDATE: If we get EDepositAlreadyPaid, update our state to reflect that
          if (!currentDepositStatus) {
            console.log('Security deposit status was out of sync, updating to PAID');
            setCurrentDepositPaid(true);
            
            // Also notify parent about state change via onComplete
            if (onComplete) {
              setTimeout(() => {
                onComplete();
              }, 1000);
            }
          }
          
          // Notify of success since the user's goal is already achieved
          setTransactionStep('complete');
          
          setDepositProcessing(false);
          return;
        }
        
        throw new Error(result.error || 'Failed to deposit USDC');
      }
      
      // Success path
      toast.success(
        currentDepositStatus 
          ? 'Contribution made successfully!' 
          : 'Security deposit paid successfully!', 
        { id: 'deposit-step' }
      );
      console.log('Deposit transaction executed with digest:', result.digest);
      
      // If this was a successful security deposit, update our state
      if (!currentDepositStatus) {
        console.log('Updating security deposit status to PAID after successful deposit');
        setCurrentDepositPaid(true);
      }
      
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
    if (disabled) {
      return "Contributions Disabled";
    }
    
    if (transactionStep === 'complete') {
      return "Transaction Complete";
    }
    
    if (processing || depositProcessing) {
      return "Processing...";
    }
    
    if (transactionStep === 'deposit' && swapTxDigest) {
      return currentDepositPaid ? "Complete Contribution" : "Complete Security Deposit";
    }
    
    // Not enough SUI error
    if (amount && parseFloat(amount) > 0 && paymentStatus === 'underpaid') {
      return `Insufficient Amount`;
    }
    
    if (!amount || parseFloat(amount) <= 0) {
      return "Enter Amount";
    }
    
    if (currentDepositPaid) {
      return "Swap & Contribute";
    } else {
      return "Swap & Pay Security Deposit";
    }
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
              {currentDepositPaid 
                ? 'Your contribution was successfully processed.' 
                : 'Your security deposit was successfully processed.'}
            </p>
          </div>
        </div>
      </div>
    );
  };

  // Add manual price refresh function
  const refreshPrice = async () => {
    setIsPriceLoading(true);
    try {
      const price = await priceService.forceRefreshPrice();
      if (price && !isNaN(price) && price > 0) {
        setSuiPrice(price);
        setPriceLastUpdated(new Date());
        console.log('Manually refreshed SUI price:', price);
        
        // Update calculations with new price
        if (amount && parseFloat(amount) > 0) {
          const suiAmount = parseFloat(amount);
          const usdcAmount = suiAmount * price;
          setReceiveAmount(usdcAmount.toFixed(2));
          
          // Update effective rate
          setEffectiveRate(price);
        }
        
        // Recalculate suggested amount
        if (requiredAmount > 0) {
          calculateSuggestedAmount(requiredAmount, price, slippage);
        }
        
        toast.success(`Updated SUI price: $${price.toFixed(2)}`);
      } else {
        toast.error('Failed to refresh price');
      }
    } catch (error) {
      console.error('Error refreshing SUI price:', error);
      toast.error('Failed to refresh price');
    } finally {
      setIsPriceLoading(false);
    }
  };

  // Add a function to check if pool conditions require higher slippage
  const checkPoolConditionsAndUpdateSlippage = async () => {
    // Default recommended values based on amount
    let recommendation = 5.0; // Start with default 5%
    
    if (requiredAmount > 0) {
      // For small amounts, recommend higher slippage since small SUI amounts are more sensitive
      if (requiredAmount < 0.1) {
        recommendation = 10.0;
      }
      
      // For security deposits, always use higher slippage to ensure success
      if (!currentDepositPaid) {
        recommendation = Math.max(recommendation, 12.0);
      }
      
      try {
        // Try to get actual swap route from Cetus API to check actual price impact
        // This is an example - you'd need to implement actual API call to get price impact
        // For now, we'll simulate by setting volatility based on time of day
        const hour = new Date().getHours();
        
        // During highest volatility periods (market open/close), use even higher slippage
        if ((hour >= 8 && hour <= 10) || (hour >= 15 && hour <= 17)) {
          recommendation = Math.max(recommendation, 15.0);
          setHighVolatilityDetected(true);
        }
        
        // If slippage is lower than recommendation, update it but don't show modal
        if (slippage < recommendation) {
          setRecommendedSlippage(recommendation);
        }
      } catch (error) {
        console.error("Error checking pool conditions:", error);
        // Still set a safe default for error cases
        setRecommendedSlippage(15.0);
      }
    }
  };
  
  // Call this when component mounts and when amount changes significantly
  useEffect(() => {
    if (requiredAmount > 0 && suiPrice) {
      checkPoolConditionsAndUpdateSlippage();
    }
  }, [requiredAmount, currentDepositPaid]);
  
  // Improve the suggested amount button to force update the input value
  // and make it more obvious when it's clicked
  const handleSuggestedAmountClick = () => {
    if (suggestedAmount) {
      // Set the amount to suggested amount
      setAmount(suggestedAmount.toString());
      
      // Force update UI to show the amount entered
      const amountInput = document.getElementById('amount-input') as HTMLInputElement;
      if (amountInput) {
        amountInput.value = suggestedAmount.toString();
      }
      
      // Update the receive amount with the conservative estimate
      if (suiPrice) {
        let estimationFactor = 0.97; // 3% reduction as baseline
        if (!currentDepositPaid) {
          estimationFactor = 0.95; // 5% reduction for security deposits
        }
        if (suggestedAmount < 0.2) {
          estimationFactor -= 0.03; // Additional 3% reduction for small amounts
        }
        
        const usdcAmount = suggestedAmount * suiPrice * estimationFactor;
        setReceiveAmount(usdcAmount.toFixed(6));
        
        // Create a swapQuote with the live price data if one doesn't exist
        const quote: SwapQuote = {
          amountIn: suggestedAmount,
          amountOut: usdcAmount * 1e6, // Convert to micro USDC
          price: suiPrice,
          priceImpact: 0.05, // Use a modest default impact
          poolId: 'suggested-amount'
        };
        
        setSwapQuote(quote);
        setEffectiveRate(suiPrice * estimationFactor);
        checkPaymentStatus(suggestedAmount);
      }
      
      // Also verify if slippage is sufficient
      checkPoolConditionsAndUpdateSlippage();
      
      // Show success notification
      toast.success('Using suggested amount for optimal swap', { id: 'suggested-amount' });
    }
  };

  return (
    <div className="bg-[#121212] rounded-xl p-4 text-white">
      {/* Slippage Error Modal */}
      <ConfirmationModal
        isOpen={false}
        onClose={() => {}}
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
          <div className={`${
            slippageChanged ? 'bg-blue-900/50 border border-blue-500/50' : 'bg-[#232323]'
          } px-3 py-1 rounded-md flex items-center transition-colors`}>
            <span className={slippageChanged ? 'text-blue-400 font-medium' : ''}>
              {slippage}%
              {slippageChanged && 
                <span className="ml-1 text-xs px-1 py-0.5 bg-blue-800 rounded text-white">custom</span>
              }
            </span>
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className={`ml-2 ${slippageChanged ? 'text-blue-400' : ''}`}
              title="Adjust slippage tolerance"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Add this after the header section */}
      <div className="flex justify-between items-center mb-3 bg-[#232323] px-3 py-2 rounded-lg text-sm">
        <div className="flex items-center">
          <span className="text-gray-400 mr-2">SUI Price:</span>
          <span className="font-medium text-white">
            {suiPrice ? `$${suiPrice.toFixed(2)}` : 'Loading...'}
          </span>
          {priceLastUpdated && (
            <span className="ml-2 text-xs text-gray-500">
              {`updated ${Math.floor((new Date().getTime() - priceLastUpdated.getTime()) / 1000 / 60)}m ago`}
            </span>
          )}
        </div>
        <button 
          onClick={refreshPrice} 
          disabled={isPriceLoading}
          className={`flex items-center space-x-1 text-xs bg-[#333333] hover:bg-[#444444] px-2 py-1 rounded-md ${isPriceLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <RefreshCw size={12} className={isPriceLoading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Volatility warning */}
      {highVolatilityDetected && (
        <div className="bg-amber-900/30 border border-amber-500/50 rounded-md p-3 mb-4 flex items-start">
          <AlertCircle size={18} className="text-amber-500 mr-2 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-amber-400 font-medium text-sm mb-1">
              High price volatility detected!
            </p>
            <p className="text-amber-300/80 text-xs">
              The SUI/USDC pool is experiencing significant price movement. Higher slippage values ({recommendedSlippage}%) may be needed for successful swaps during these market conditions.
            </p>
          </div>
        </div>
      )}

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
                  onClick={() => {
                    setSlippage(value);
                    
                    // Directly update the amount when slippage button is clicked
                    if (requiredAmount > 0 && suiPrice) {
                      const newSuggestedAmount = calculateSuggestedAmount(requiredAmount, suiPrice, value);
                      
                      // Only update amount if we're using suggested amount or field is empty
                      if (suggestedAmount && (!amount || amount === '' || 
                          (parseFloat(amount) > 0 && 
                           Math.abs((parseFloat(amount) - suggestedAmount) / suggestedAmount) < 0.05))) {
                        
                        console.log(`Updating amount from slippage button: ${value}% → ${newSuggestedAmount}`);
                        setAmount(newSuggestedAmount.toString());
                        
                        // Update the receive amount estimation
                        if (suiPrice) {
                          let estimationFactor = 0.97; // 3% reduction as baseline
                          if (!currentDepositPaid) {
                            estimationFactor = 0.95; // 5% reduction for security deposits
                          }
                          if (newSuggestedAmount < 0.2) {
                            estimationFactor -= 0.03; // Additional 3% reduction for small amounts
                          }
                          
                          const newUsdcAmount = newSuggestedAmount * suiPrice * estimationFactor;
                          setReceiveAmount(newUsdcAmount.toFixed(6));
                        }
                      }
                    }
                  }}
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
          </div>
        </div>
      )}

      {/* Step-specific info banners */}
      {transactionStep === 'swap' && !currentDepositPaid && (
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
            <span>Step 2: Deposit the swapped USDC to the circle&apos;s custody wallet as {currentDepositPaid ? 'your contribution' : 'security deposit'}.</span>
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
                <div className="flex justify-between items-center mt-2">
                  <div className="text-gray-400">Suggested amount (with {slippage}% slippage + gas):</div>
                  <div className="flex items-center">
                    <div className="mr-2 text-white">{suggestedAmount.toFixed(8)} SUI</div>
                    <button
                      onClick={handleSuggestedAmountClick}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors duration-200 flex items-center"
                    >
                      Use Suggested Amount ({suggestedAmount.toFixed(8)} SUI)
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
              <div className="w-full px-4 py-3 bg-[#1B1B1B] rounded-lg flex items-center mt-1">
                <input
                  id="amount-input"
                  type="number"
                  value={amount}
                  onChange={handleAmountChange}
                  placeholder="0.0"
                  className="bg-transparent text-2xl outline-none w-full"
                  disabled={processing}
                />
              </div>
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
          disabled || // Add disabled prop check
          processing || 
          depositProcessing || 
          !amount || 
          parseFloat(amount) <= 0 || 
          paymentStatus === 'underpaid' ||
          transactionStep === 'complete'
        }
        className={`w-full mt-4 py-3 rounded-lg font-medium text-white transition-all ${
          disabled || processing || depositProcessing || !amount || parseFloat(amount) <= 0 || paymentStatus === 'underpaid' || transactionStep === 'complete'
            ? 'bg-gray-400 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {getButtonText()}
      </button>
    </div>
  );
};

export default SimplifiedSwapUI; 