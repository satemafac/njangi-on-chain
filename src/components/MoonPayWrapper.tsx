import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';

// Dynamically import MoonPay components to avoid SSR issues
const MoonPayBuyWidget = dynamic(
  () => import('@moonpay/moonpay-react').then(mod => ({ default: mod.MoonPayBuyWidget })),
  { 
    ssr: false,
    loading: () => <div>Loading MoonPay...</div>
  }
);

interface MoonPayWrapperProps {
  variant: 'overlay' | 'embedded';
  baseCurrencyCode: string;
  baseCurrencyAmount: string;
  defaultCurrencyCode: string;
  walletAddress?: string;
  visible: boolean;
  onClose: () => Promise<void>;
}

export default function MoonPayWrapper(props: MoonPayWrapperProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Only render on client side
  if (!isMounted) {
    return null;
  }

  return <MoonPayBuyWidget {...props} />;
}

