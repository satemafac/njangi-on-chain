module njangi::njangi_price_validator {
    use sui::clock::Clock;
    use sui::table::{Self, Table};
    use sui::event;

    use pyth::price_info;
    use pyth::price_identifier;
    use pyth::price;
    use pyth::pyth;
    use pyth::price_info::PriceInfoObject;
    use pyth::i64::{Self, I64};

    use std::ascii::{Self, String};

    // ----------------------------------------------------------
    // Compliance redesign — Phase 1
    //
    // The previous version of this module identified an asset by substring
    // search on the canonical Move type string (`string::index_of(b"USDC")`).
    // That allowed any coin whose type string contained the bytes `USDC`
    // (for example, `0x...::myusdc_wrapped::USDC`) to match the real USDC
    // oracle feed and decimals. The fix replaces substring matching with
    // exact full-canonical-type comparison, and introduces an `AssetRegistry`
    // shared object so additional assets can be registered through a
    // governance flow rather than by code change.
    // ----------------------------------------------------------

    // Error codes
    const E_INVALID_PRICE_ID: u64 = 101;
    const E_PRICE_TOO_OLD: u64 = 102;
    const E_INSUFFICIENT_VALUE: u64 = 103;
    const E_ARITHMETIC_OVERFLOW: u64 = 104;
    const E_UNSUPPORTED_ASSET: u64 = 105;
    const E_NOT_ADMIN: u64 = 106;
    const E_ASSET_ALREADY_REGISTERED: u64 = 107;
    const E_INVALID_PRICE_ID_LENGTH: u64 = 108;
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;

    // Pyth price feed IDs are 32-byte values.
    const PRICE_ID_BYTES: u64 = 32;

    // SUI/USD price feed ID — the only oracle baked into the package; all
    // other asset oracle IDs are supplied via `register_asset` so the
    // protocol can grow without redeployment.
    const SUI_USD_PRICE_ID: vector<u8> = x"5450dc9536f233ea863ce9f89191a6f755f80e393ba2be2057dbabda0cc407c9";

    // Native SUI canonical type string (no 0x prefix, 64-char address).
    const SUI_TYPE: vector<u8> = b"0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

    // ----------------------------------------------------------
    // Asset registry — exact type → oracle config lookup
    // ----------------------------------------------------------
    public struct AssetEntry has store, copy, drop {
        oracle_price_id: vector<u8>,
        decimals: u8,
        max_age_secs: u64,
        enabled: bool,
    }

    public struct AssetRegistry has key {
        id: UID,
        admin: address,
        assets: Table<vector<u8>, AssetEntry>,
    }

    public struct AssetRegistered has copy, drop {
        coin_type: vector<u8>,
        oracle_price_id: vector<u8>,
        decimals: u8,
        max_age_secs: u64,
        registered_by: address,
    }

    public struct AssetUpdated has copy, drop {
        coin_type: vector<u8>,
        oracle_price_id: vector<u8>,
        decimals: u8,
        max_age_secs: u64,
        enabled: bool,
        updated_by: address,
    }

    /// Initializes the registry with the canonical asset whitelist baked in.
    /// New stablecoins or oracle migrations are added via `register_asset`
    /// and `set_asset_enabled` rather than by republishing the package.
    public fun init_registry(ctx: &mut TxContext) {
        let admin = tx_context::sender(ctx);
        let mut assets = table::new<vector<u8>, AssetEntry>(ctx);

        table::add(&mut assets, SUI_TYPE, AssetEntry {
            oracle_price_id: SUI_USD_PRICE_ID,
            decimals: 9,
            max_age_secs: 60,
            enabled: true,
        });

        let registry = AssetRegistry {
            id: object::new(ctx),
            admin,
            assets,
        };
        transfer::share_object(registry);
    }

    /// Register a new asset. Caller must be the registry admin. Use this for
    /// stablecoins or new collateral assets after publishing the package, so
    /// the on-chain whitelist can grow without redeploying the protocol.
    public fun register_asset(
        registry: &mut AssetRegistry,
        coin_type: vector<u8>,
        oracle_price_id: vector<u8>,
        decimals: u8,
        max_age_secs: u64,
        ctx: &TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == registry.admin, E_NOT_ADMIN);
        assert!(vector::length(&oracle_price_id) == PRICE_ID_BYTES, E_INVALID_PRICE_ID_LENGTH);
        assert!(!table::contains(&registry.assets, coin_type), E_ASSET_ALREADY_REGISTERED);

        table::add(&mut registry.assets, coin_type, AssetEntry {
            oracle_price_id,
            decimals,
            max_age_secs,
            enabled: true,
        });

        event::emit(AssetRegistered {
            coin_type,
            oracle_price_id,
            decimals,
            max_age_secs,
            registered_by: sender,
        });
    }

    /// Toggle an asset's enabled flag (e.g. emergency pause for an oracle).
    public fun set_asset_enabled(
        registry: &mut AssetRegistry,
        coin_type: vector<u8>,
        enabled: bool,
        ctx: &TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == registry.admin, E_NOT_ADMIN);
        assert!(table::contains(&registry.assets, coin_type), E_UNSUPPORTED_ASSET);

        let entry = table::borrow_mut(&mut registry.assets, coin_type);
        entry.enabled = enabled;

        event::emit(AssetUpdated {
            coin_type,
            oracle_price_id: entry.oracle_price_id,
            decimals: entry.decimals,
            max_age_secs: entry.max_age_secs,
            enabled,
            updated_by: sender,
        });
    }

    public fun is_asset_registered(registry: &AssetRegistry, coin_type: vector<u8>): bool {
        table::contains(&registry.assets, coin_type)
    }

    public fun get_asset_entry(registry: &AssetRegistry, coin_type: vector<u8>): AssetEntry {
        assert!(table::contains(&registry.assets, coin_type), E_UNSUPPORTED_ASSET);
        let entry = table::borrow(&registry.assets, coin_type);
        AssetEntry {
            oracle_price_id: entry.oracle_price_id,
            decimals: entry.decimals,
            max_age_secs: entry.max_age_secs,
            enabled: entry.enabled,
        }
    }

    public fun asset_oracle_price_id(entry: &AssetEntry): vector<u8> { entry.oracle_price_id }
    public fun asset_decimals(entry: &AssetEntry): u8 { entry.decimals }
    public fun asset_max_age_secs(entry: &AssetEntry): u64 { entry.max_age_secs }
    public fun asset_enabled(entry: &AssetEntry): bool { entry.enabled }

    // ----------------------------------------------------------
    // Validation entrypoints
    // ----------------------------------------------------------

    /// Validates that a stablecoin deposit meets the required USD value.
    /// Looks the asset up by exact canonical type string in the registry,
    /// rejecting any coin type that has not been explicitly registered.
    /// Returns the USD value of the deposit.
    public fun validate_stablecoin_deposit_with_registry(
        registry: &AssetRegistry,
        price_info_object: &PriceInfoObject,
        amount: u64,
        required_amount: u64,
        coin_type_str: String,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        let coin_type_bytes = ascii::into_bytes(coin_type_str);
        assert!(table::contains(&registry.assets, coin_type_bytes), E_UNSUPPORTED_ASSET);
        let entry = table::borrow(&registry.assets, coin_type_bytes);
        assert!(entry.enabled, E_UNSUPPORTED_ASSET);

        let price_struct = pyth::get_price_no_older_than(price_info_object, clock, entry.max_age_secs);

        let current_time = tx_context::epoch_timestamp_ms(ctx) / 1000;
        let price_time = price::get_timestamp(&price_struct);
        assert!(current_time - price_time <= entry.max_age_secs, E_PRICE_TOO_OLD);

        let price_info = price_info::get_price_info_from_price_info_object(price_info_object);
        let price_id = price_identifier::get_bytes(&price_info::get_price_identifier(&price_info));
        assert!(price_id == entry.oracle_price_id, E_INVALID_PRICE_ID);

        let decimal_adjust = price::get_expo(&price_struct);
        let price_value = price::get_price(&price_struct);

        let usd_value = calculate_usd_value_with_decimals(amount, price_value, decimal_adjust, entry.decimals);
        assert!(usd_value >= required_amount, E_INSUFFICIENT_VALUE);

        usd_value
    }

    /// Backwards-compatible entrypoint that does not require a registry
    /// reference. Identifies the asset by exact canonical type comparison
    /// against the built-in allowlist (substring matching has been removed).
    public fun validate_stablecoin_deposit(
        price_info_object: &PriceInfoObject,
        amount: u64,
        required_amount: u64,
        coin_type_str: String,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        let max_age = 60;
        let price_struct = pyth::get_price_no_older_than(price_info_object, clock, max_age);

        let current_time = tx_context::epoch_timestamp_ms(ctx) / 1000;
        let price_time = price::get_timestamp(&price_struct);
        assert!(current_time - price_time <= max_age, E_PRICE_TOO_OLD);

        let price_info = price_info::get_price_info_from_price_info_object(price_info_object);
        let price_id = price_identifier::get_bytes(&price_info::get_price_identifier(&price_info));

        validate_price_id(price_id, coin_type_str);

        let decimal_adjust = price::get_expo(&price_struct);
        let price_value = price::get_price(&price_struct);

        let usd_value = calculate_usd_value(amount, price_value, decimal_adjust, coin_type_str);
        assert!(usd_value >= required_amount, E_INSUFFICIENT_VALUE);

        usd_value
    }

    /// Reads a SUI/USD oracle snapshot and returns
    /// (price_usd_cents_per_sui, oracle_timestamp_seconds).
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

    // ----------------------------------------------------------
    // Internal helpers
    // ----------------------------------------------------------

    /// Validates that the price ID matches the expected ID for the given
    /// coin type, using exact full-canonical-type comparison rather than
    /// substring search. The previous substring-matching implementation
    /// allowed any type containing the bytes "USDC"/"USDT"/etc. to satisfy
    /// the corresponding oracle feed.
    fun validate_price_id(price_id: vector<u8>, coin_type_str: String) {
        let coin_type_bytes = ascii::into_bytes(coin_type_str);
        let expected = expected_price_id_for_type(&coin_type_bytes);
        assert!(price_id == expected, E_INVALID_PRICE_ID);
    }

    /// Returns the expected oracle price ID for a known canonical type, or
    /// aborts with E_UNSUPPORTED_ASSET when the type is not in the built-in
    /// allowlist. Use the registry-backed entrypoint for assets registered
    /// after package publication.
    fun expected_price_id_for_type(coin_type_bytes: &vector<u8>): vector<u8> {
        if (*coin_type_bytes == SUI_TYPE) {
            return SUI_USD_PRICE_ID
        };
        // For non-native assets the registry is authoritative; the legacy
        // entrypoint deliberately rejects them so the only correctness
        // story is "registered + enabled" via `AssetRegistry`.
        abort E_UNSUPPORTED_ASSET
    }

    /// Calculates the USD value of an amount based on price and decimals,
    /// resolving decimals from the registered allowlist (built-in for SUI;
    /// other assets must use `validate_stablecoin_deposit_with_registry`).
    fun calculate_usd_value(amount: u64, price_value: I64, decimal_adjust: I64, coin_type_str: String): u64 {
        let coin_type_bytes = ascii::into_bytes(coin_type_str);
        let coin_decimals = decimals_for_known_type(&coin_type_bytes);
        calculate_usd_value_with_decimals(amount, price_value, decimal_adjust, coin_decimals)
    }

    fun calculate_usd_value_with_decimals(
        amount: u64,
        price_value: I64,
        decimal_adjust: I64,
        coin_decimals: u8
    ): u64 {
        let price_usd_cents = to_usd_cents_per_token(price_value, decimal_adjust);
        let coin_scale = pow10(coin_decimals as u64);
        assert!(amount == 0 || price_usd_cents <= MAX_U64 / amount, E_ARITHMETIC_OVERFLOW);
        let usd_cents_numerator = amount * price_usd_cents;
        usd_cents_numerator / coin_scale
    }

    fun decimals_for_known_type(coin_type_bytes: &vector<u8>): u8 {
        if (*coin_type_bytes == SUI_TYPE) {
            return 9
        };
        abort E_UNSUPPORTED_ASSET
    }

    // Converts oracle price representation (value * 10^expo) into USD cents per token.
    fun to_usd_cents_per_token(price_value: I64, decimal_adjust: I64): u64 {
        let price_magnitude = i64::get_magnitude_if_positive(&price_value);

        if (i64::get_is_negative(&decimal_adjust)) {
            let expo = i64::get_magnitude_if_negative(&decimal_adjust);
            let denom = pow10(expo);
            assert!(price_magnitude == 0 || 100 <= MAX_U64 / price_magnitude, E_ARITHMETIC_OVERFLOW);
            (price_magnitude * 100) / denom
        } else {
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

}
