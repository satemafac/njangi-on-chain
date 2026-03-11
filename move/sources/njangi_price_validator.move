module njangi::njangi_price_validator {
    use sui::clock::Clock;
    use sui::tx_context::{Self, TxContext};
    
    use pyth::price_info;
    use pyth::price_identifier;
    use pyth::price;
    use pyth::pyth;
    use pyth::price_info::PriceInfoObject;
    use pyth::i64::{Self, I64};
    
    use std::string;
    use std::ascii::{Self, String};
    
    // Error codes
    const E_INVALID_PRICE_ID: u64 = 101;
    const E_PRICE_TOO_OLD: u64 = 102;
    const E_INSUFFICIENT_VALUE: u64 = 103;
    const E_ARITHMETIC_OVERFLOW: u64 = 104;
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;
    
    // Known price feed IDs from Pyth Network
    // ETH/USD price feed ID
    const ETH_USD_PRICE_ID: vector<u8> = x"ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    // USDC/USD price feed ID
    const USDC_USD_PRICE_ID: vector<u8> = x"eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
    // USDT/USD price feed ID
    const USDT_USD_PRICE_ID: vector<u8> = x"2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b";
    // SUI/USD price feed ID
    const SUI_USD_PRICE_ID: vector<u8> = x"5450dc9536f233ea863ce9f89191a6f755f80e393ba2be2057dbabda0cc407c9";
    // AFSUI/USD price feed ID
    const AFSUI_USD_PRICE_ID: vector<u8> = x"d213e2929116af56c3ce71a1acee874f1dd03f42567b552085fa9d8ce8ce7134";
    
    /// Validates that a stablecoin deposit meets the required USD value
    /// Returns the USD value of the deposit
    public fun validate_stablecoin_deposit(
        price_info_object: &PriceInfoObject,
        amount: u64,
        required_amount: u64,
        coin_type_str: String,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        // Price must be fresh (not older than 60 seconds)
        let max_age = 60;
        let price_struct = pyth::get_price_no_older_than(price_info_object, clock, max_age);
        
        // Check if the price is too old
        let current_time = tx_context::epoch_timestamp_ms(ctx) / 1000; // Convert to seconds
        let price_time = price::get_timestamp(&price_struct);
        
        assert!(current_time - price_time <= max_age, E_PRICE_TOO_OLD);
        
        // Get the price ID to verify we're using the correct feed
        let price_info = price_info::get_price_info_from_price_info_object(price_info_object);
        let price_id = price_identifier::get_bytes(&price_info::get_price_identifier(&price_info));
        
        // Verify the price feed ID based on coin type
        validate_price_id(price_id, coin_type_str);
        
        // Extract price information
        let decimal_adjust = price::get_expo(&price_struct);
        let price_value = price::get_price(&price_struct);
        
        // Calculate the USD value of the deposit
        let usd_value = calculate_usd_value(amount, price_value, decimal_adjust, coin_type_str);
        
        // Ensure the value meets the required amount
        assert!(usd_value >= required_amount, E_INSUFFICIENT_VALUE);
        
        usd_value
    }

    /// Reads a SUI/USD oracle snapshot and returns:
    /// (price_usd_cents_per_sui, oracle_timestamp_seconds).
    /// Uses a caller-supplied lookback window so callers can implement custom
    /// stale-price fallback behavior.
    public fun get_sui_price_snapshot(
        price_info_object: &PriceInfoObject,
        clock: &Clock,
        max_age_seconds: u64
    ): (u64, u64) {
        let price_struct = pyth::get_price_no_older_than(price_info_object, clock, max_age_seconds);

        let price_info = price_info::get_price_info_from_price_info_object(price_info_object);
        let price_id = price_identifier::get_bytes(&price_info::get_price_identifier(&price_info));
        assert!(price_id == SUI_USD_PRICE_ID, E_INVALID_PRICE_ID);

        let decimal_adjust = price::get_expo(&price_struct);
        let price_value = price::get_price(&price_struct);
        let price_usd_cents = to_usd_cents_per_token(price_value, decimal_adjust);
        let price_time = price::get_timestamp(&price_struct);

        (price_usd_cents, price_time)
    }
    
    /// Validates that the price ID matches the expected ID for the given coin type
    fun validate_price_id(price_id: vector<u8>, coin_type_str: String) {
        // Convert to string::String for comparison functions
        let str = string::utf8(ascii::into_bytes(coin_type_str));
        
        if (string::index_of(&str, &string::utf8(b"USDC")) != 18446744073709551615) {
            assert!(price_id == USDC_USD_PRICE_ID, E_INVALID_PRICE_ID);
        } else if (string::index_of(&str, &string::utf8(b"USDT")) != 18446744073709551615) {
            assert!(price_id == USDT_USD_PRICE_ID, E_INVALID_PRICE_ID);
        } else if (string::index_of(&str, &string::utf8(b"ETH")) != 18446744073709551615) {
            assert!(price_id == ETH_USD_PRICE_ID, E_INVALID_PRICE_ID);
        } else if (string::index_of(&str, &string::utf8(b"SUI")) != 18446744073709551615) {
            assert!(price_id == SUI_USD_PRICE_ID, E_INVALID_PRICE_ID);
        } else if (string::index_of(&str, &string::utf8(b"AFSUI")) != 18446744073709551615) {
            assert!(price_id == AFSUI_USD_PRICE_ID, E_INVALID_PRICE_ID);
        } else {
            assert!(false, E_INVALID_PRICE_ID); // Unsupported coin type
        }
    }
    
    /// Calculates the USD value of an amount based on price and decimals
    fun calculate_usd_value(amount: u64, price_value: I64, decimal_adjust: I64, coin_type_str: String): u64 {
        // Convert to string::String for comparison functions
        let str = string::utf8(ascii::into_bytes(coin_type_str));
        
        // Handle different coin decimal places
        let coin_decimals = get_coin_decimals(str);

        // Convert oracle price into USD cents per token.
        let price_usd_cents = to_usd_cents_per_token(price_value, decimal_adjust);
        let coin_scale = pow10(coin_decimals as u64);

        // amount (coin base units) * price (usd cents per token) / 10^coin_decimals
        assert!(amount == 0 || price_usd_cents <= MAX_U64 / amount, E_ARITHMETIC_OVERFLOW);
        let usd_cents_numerator = amount * price_usd_cents;
        usd_cents_numerator / coin_scale
    }

    // Converts oracle price representation (value * 10^expo) into USD cents per token.
    fun to_usd_cents_per_token(price_value: I64, decimal_adjust: I64): u64 {
        let price_magnitude = i64::get_magnitude_if_positive(&price_value);

        if (i64::get_is_negative(&decimal_adjust)) {
            // price = magnitude / 10^expo
            let expo = i64::get_magnitude_if_negative(&decimal_adjust);
            let denom = pow10(expo);
            assert!(price_magnitude == 0 || 100 <= MAX_U64 / price_magnitude, E_ARITHMETIC_OVERFLOW);
            (price_magnitude * 100) / denom
        } else {
            // price = magnitude * 10^expo
            let expo = i64::get_magnitude_if_positive(&decimal_adjust);
            let expo_scale = pow10(expo);
            assert!(price_magnitude == 0 || expo_scale <= MAX_U64 / price_magnitude, E_ARITHMETIC_OVERFLOW);
            let scaled_price = price_magnitude * expo_scale;
            assert!(scaled_price == 0 || 100 <= MAX_U64 / scaled_price, E_ARITHMETIC_OVERFLOW);
            scaled_price * 100
        }
    }

    // 10^shift with overflow protection.
    fun pow10(shift: u64): u64 {
        let mut out = 1u64;
        let mut i = 0u64;
        while (i < shift) {
            assert!(10 <= MAX_U64 / out, E_ARITHMETIC_OVERFLOW);
            out = out * 10;
            i = i + 1;
        };
        out
    }
    
    /// Returns the number of decimal places for a given coin type
    fun get_coin_decimals(coin_type_str: string::String): u8 {
        if (string::index_of(&coin_type_str, &string::utf8(b"USDC")) != 18446744073709551615) {
            6 // USDC has 6 decimals
        } else if (string::index_of(&coin_type_str, &string::utf8(b"USDT")) != 18446744073709551615) {
            6 // USDT has 6 decimals
        } else if (string::index_of(&coin_type_str, &string::utf8(b"ETH")) != 18446744073709551615) {
            18 // ETH has 18 decimals
        } else if (string::index_of(&coin_type_str, &string::utf8(b"SUI")) != 18446744073709551615) {
            9 // SUI has 9 decimals
        } else if (string::index_of(&coin_type_str, &string::utf8(b"AFSUI")) != 18446744073709551615) {
            9 // AFSUI has 9 decimals
        } else {
            9 // Default to 9 decimals
        }
    }
} 
