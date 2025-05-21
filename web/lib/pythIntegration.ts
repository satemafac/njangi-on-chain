/**
 * Pyth Price Oracle Integration for Njangi
 * 
 * This file provides integration with Pyth Network price oracles for the Njangi protocol.
 * It handles fetching price data and creating transactions that include price validation.
 * Compatible with zkLogin authentication.
 */

// Import from installed packages
import { SuiPriceServiceConnection, SuiPythClient, PriceFeed } from "@pythnetwork/pyth-sui-js";
// Updated SUI SDK imports 
import { SuiClient } from "@mysten/sui.js/client";
import { TransactionBlock } from "@mysten/sui.js/transactions";

// Type definition for wallet signer
interface WalletSigner {
    provider: SuiClient;
    signAndExecuteTransactionBlock: (txBlock: {
        transactionBlock: TransactionBlock,
        options?: {
            showEffects?: boolean,
            showEvents?: boolean
        }
    }) => Promise<{ digest: string, [key: string]: unknown }>;
}

// Mainnet configurations
const MAINNET_CONFIG = {
    pythStateId: "0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8",
    wormholeStateId: "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c",
    hermesUrl: "https://hermes-beta.pyth.network"
};

// Testnet configurations
const TESTNET_CONFIG = {
    pythStateId: "0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c",
    wormholeStateId: "0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790",
    hermesUrl: "https://hermes-beta.pyth.network"
};

// Known price feed IDs
const PRICE_FEED_IDS = {
    BTC_USD: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    ETH_USD: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    USDC_USD: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    USDT_USD: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    SUI_USD: "0x5450dc9536f233ea863ce9f89191a6f755f80e393ba2be2057dbabda0cc407c9",
    AFSUI_USD: "0xd213e2929116af56c3ce71a1acee874f1dd03f42567b552085fa9d8ce8ce7134"
};

/**
 * Creates a transaction to deposit stablecoin with price validation
 * @param wallet The wallet used to sign and execute the transaction
 * @param circleId The ID of the circle
 * @param walletId The ID of the custody wallet
 * @param coinObjectId The ID of the coin object to deposit
 * @param requiredAmount The minimum required USD value for the deposit
 * @param tokenType The type of token being deposited (e.g., "0x2::sui::SUI")
 * @param isMainnet Whether to use mainnet or testnet configuration
 * @returns The transaction result
 */
export async function depositWithPriceValidation(
    wallet: WalletSigner,
    circleId: string,
    walletId: string,
    coinObjectId: string,
    requiredAmount: bigint,
    tokenType: string,
    isMainnet = true
) {
    const config = isMainnet ? MAINNET_CONFIG : TESTNET_CONFIG;
    
    // Determine which price feed to use based on token type
    let priceFeedId = PRICE_FEED_IDS.SUI_USD;
    if (tokenType.includes("USDC")) {
        priceFeedId = PRICE_FEED_IDS.USDC_USD;
    } else if (tokenType.includes("USDT")) {
        priceFeedId = PRICE_FEED_IDS.USDT_USD;
    } else if (tokenType.includes("ETH")) {
        priceFeedId = PRICE_FEED_IDS.ETH_USD;
    }
    
    // Connect to the Pyth price service
    const priceService = new SuiPriceServiceConnection(config.hermesUrl);
    
    // Get the price feed update data
    const priceUpdateData = await priceService.getPriceFeedsUpdateData([priceFeedId]);
    
    // Create the Pyth client with provider
    // Type casting is needed for zkLogin compatibility with Pyth SDK
    const pythClient = new SuiPythClient(
        // Force type to avoid SDK version mismatch
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet.provider as any,
        config.pythStateId,
        config.wormholeStateId
    );
    
    // Create a transaction block
    const tx = new TransactionBlock();
    
    // Update the price feed and get the price info object ID
    // Type casting needed for zkLogin compatibility with different TransactionBlock types
    const priceInfoObjectIds = await pythClient.updatePriceFeeds(
        // Force type to avoid SDK version mismatch
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx as any,
        priceUpdateData, 
        [priceFeedId]
    );
    
    // Call the deposit function with price validation
    tx.moveCall({
        target: `njangi::njangi_circles::deposit_stablecoin_with_price_validation`,
        arguments: [
            tx.object(circleId),
            tx.object(walletId),
            tx.object(coinObjectId),
            tx.pure(requiredAmount.toString()),
            tx.object(priceInfoObjectIds[0]),
            tx.object("0x6"), // Clock object
        ],
        typeArguments: [tokenType],
    });
    
    // Execute the transaction
    const txBlock = {
        transactionBlock: tx,
        options: {
            showEffects: true,
            showEvents: true,
        },
    };
    
    try {
        const result = await wallet.signAndExecuteTransactionBlock(txBlock);
        return {
            success: true,
            txId: result.digest,
            result
        };
    } catch (error) {
        console.error("Error executing transaction:", error);
        return {
            success: false,
            error
        };
    }
}

/**
 * Gets the current price of a token in USD
 * @param priceFeedId The Pyth price feed ID
 * @param isMainnet Whether to use mainnet or testnet configuration
 * @returns The current price in USD
 */
export async function getCurrentPrice(
    priceFeedId: string,
    isMainnet = true
): Promise<number> {
    const config = isMainnet ? MAINNET_CONFIG : TESTNET_CONFIG;
    
    try {
        // Connect to the Pyth price service
        const priceService = new SuiPriceServiceConnection(config.hermesUrl);
        
        // Get the current price
        const priceFeeds = await priceService.getLatestPriceFeeds([priceFeedId]);
        
        if (priceFeeds && priceFeeds.length > 0) {
            const priceFeed = priceFeeds[0] as PriceFeed;
            
            try {
                // Try to access price data with newer Pyth SDK method
                const priceObj = priceFeed.getPriceNoOlderThan(60);
                
                if (priceObj) {
                    const price = priceObj.price;
                    const expo = priceObj.expo;
                    
                    // Ensure these are numbers before arithmetic
                    if (typeof price === 'number' && typeof expo === 'number') {
                        // Convert price to a human-readable format
                        return price * Math.pow(10, expo);
                    }
                }
                
                throw new Error("Invalid price format");
            } catch {
                // Fallback to older API format if needed
                console.warn("Using fallback price access method");
                
                // The following is needed for backwards compatibility with older
                // versions of the Pyth SDK
                let priceValue: number | null = null;
                let expoValue: number | null = null;
                
                // Try the old access pattern
                try {
                    // Access price data using type assertion to bypass TypeScript checks
                    const priceData = (priceFeed as unknown as { price: { price: number, expo: number } }).price;
                    if (priceData) {
                        priceValue = priceData.price;
                        expoValue = priceData.expo;
                    }
                } catch (error) {
                    console.error("Could not access price with any method:", error);
                }
                
                if (typeof priceValue === 'number' && typeof expoValue === 'number') {
                    return priceValue * Math.pow(10, expoValue);
                }
                
                throw new Error("Could not access price data with any method");
            }
        }
        
        throw new Error("Price feed not found");
    } catch (error) {
        console.error("Error getting current price:", error);
        throw error;
    }
} 