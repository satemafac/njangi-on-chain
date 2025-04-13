import React, { useState, useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { swapService, SwapQuote } from '../services/swap-service';
import { ArrowDown, Settings, AlertCircle, Info, CheckCircle2 } from 'lucide-react';
import { priceService } from '../services/price-service';

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
  const { account } = useAuth();
  const [amount, setAmount] = useState<string>('');
  const [receiveAmount, setReceiveAmount] = useState<string>('0.0');
  const [swapQuote, setSwapQuote] = useState<SwapQuote | null>(null);
  const [processing, setProcessing] = useState<boolean>(false);
  const [slippage, setSlippage] = useState<number>(0.5);
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

  // Determine the required amount based on whether security deposit is paid
  const requiredAmount = securityDepositPaid ? contributionAmount : securityDepositAmount;
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
      const minAmountOut = Math.max(
        1, // Ensure minAmountOut is at least 1 (never zero)
        Math.floor(swapQuote.amountOut * (1 - slippage / 100))
      );
      
      console.log('Sending swap-only request with parameters:', {
        suiAmount: parseFloat(amount),
        minAmountOut,
        slippage,
      });
      
      // Use zkLogin API to execute just the swap (without deposit)
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'executeSwapOnly', // New API action for swap only
          account,
          suiAmount: parseFloat(amount),
          minAmountOut,
          slippage: slippage,
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
            } else if (result.details.includes('coin balance too low')) {
              errorMessage = 'Your wallet balance is too low for this swap.';
            } else if (result.details.includes('function not found')) {
              errorMessage = 'Swap failed: Cetus pool module not found. Please contact support.';
            } else if (result.details.includes('Pool does not exist')) {
              errorMessage = 'The SUI/USDC liquidity pool is not available. Please try again later.';
            } else if (result.details.includes('Slippage tolerance exceeded')) {
              errorMessage = `Price movement exceeded your slippage tolerance of ${slippage}%. Try increasing slippage or try again.`;
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
  
  // Second transaction: Deposit the USDC to the custody wallet
  const handleDeposit = async () => {
    if (!account || !walletId || !circleId) {
      toast.error('Missing required information for deposit');
      console.error('Missing required info:', { 
        hasAccount: !!account, 
        hasWalletId: !!walletId, 
        hasCircleId: !!circleId 
      });
      return;
    }

    // Check if we have a valid swappedCoinId
    if (!swappedCoinId) {
      console.error('Missing swapped coin ID for deposit step');
      
      if (retryCount > 0) {
        toast.error(
          'Still unable to find the swapped coin. Please go back to the swap step and try again.',
          { id: 'deposit-step', duration: 5000 }
        );
      } else {
        toast.error(
          'Could not find the swapped USDC coin. Please wait a moment and try again.',
          { id: 'deposit-step', duration: 3000 }
        );
      }
      
      setRetryCount(prev => prev + 1);
      return;
    }

    // Validate the coin ID format
    if (!swappedCoinId.match(/^0x[a-fA-F0-9]{40,64}$/)) {
      console.error('Invalid coin ID format:', swappedCoinId);
      toast.error('The swapped coin ID appears to be invalid. Please try again.', 
        { id: 'deposit-step' });
      return;
    }

    setDepositProcessing(true);
    
    try {
      // Clear any existing toasts first
      toast.dismiss('deposit-step');
      toast.loading('Depositing USDC to custody wallet...', { id: 'deposit-step' });
      
      console.log('Sending deposit request with parameters:', {
        coinObjectId: swappedCoinId,
        walletId,
        stablecoinType: USDC_COIN_TYPE,
        isSecurityDeposit: !securityDepositPaid,
      });
      
      // Use zkLogin API to deposit the USDC
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'depositStablecoin',
          account,
          walletId,
          coinObjectId: swappedCoinId,
          stablecoinType: USDC_COIN_TYPE,
        }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        console.error('Deposit failed:', result);
        
        // Check if we need to reauthenticate
        if (result.requireRelogin) {
          toast.error('Your session has expired. Please login again.', { id: 'deposit-step' });
          
          // Redirect to login page after a short delay
          setTimeout(() => {
            window.location.href = '/';
          }, 2000);
          return;
        }
        
        // Check for specific error related to coin object not found
        if (result.error && (
            result.error.includes('object not found') ||
            result.error.includes('Object does not exist') ||
            result.error.includes('Invalid object id') ||
            result.error.includes('Coin object not found')
        )) {
          toast.error(
            'USDC coin not found. The blockchain might still be processing the swap transaction. Please wait a moment and try again.',
            { id: 'deposit-step', duration: 5000 }
          );
          setRetryCount(prev => prev + 1);
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
            <div className="flex mt-1 space-x-2">
              {[0.1, 0.5, 1.0, 2.0].map(value => (
                <button
                  key={value}
                  onClick={() => setSlippage(value)}
                  className={`px-3 py-1 rounded-md text-sm ${
                    slippage === value 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-[#333333] text-gray-300'
                  }`}
                >
                  {value}%
                </button>
              ))}
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