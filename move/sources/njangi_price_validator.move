module njangi::njangi_price_validator {
    use sui::clock::Clock;
    use sui::table::{Self, Table};
    use sui::event;
    use sui::dynamic_field as df;
    use sui::package::{Self, UpgradeCap};
    use sui::coin::{Self, CoinMetadata};
    use sui::coin_registry::{Self, Currency};

    use njangi::njangi_core as core;

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

    // Error codes (102 and 103 belonged to the oracle-priced deposit
    // validators retired in v11; do not reuse them)
    const E_INVALID_PRICE_ID: u64 = 101;
    const E_ARITHMETIC_OVERFLOW: u64 = 104;
    const E_UNSUPPORTED_ASSET: u64 = 105;
    const E_NOT_ADMIN: u64 = 106;
    const E_ASSET_ALREADY_REGISTERED: u64 = 107;
    const E_INVALID_PRICE_ID_LENGTH: u64 = 108;
    // v11: the registry passed to a money path is not the protocol's
    // canonical one (anyone can mint a registry with `init_registry`).
    const E_REGISTRY_NOT_CANONICAL: u64 = 109;
    // v11: the asset is registered and enabled but lacks the role the
    // caller needs (settlement / security deposit).
    const E_ASSET_LACKS_ROLE: u64 = 110;
    const E_INVALID_FLAGS: u64 = 111;
    const E_INVALID_ADMIN: u64 = 112;
    // Mirrors njangi_compliance::E_FOREIGN_UPGRADE_CAP (306): the presented
    // UpgradeCap does not govern this package lineage.
    const E_FOREIGN_UPGRADE_CAP: u64 = 306;
    // Mirrors njangi_circles::E_DEPRECATED_ENTRYPOINT.
    const E_DEPRECATED: u64 = 89;
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;

    // ----------------------------------------------------------
    // v11 asset roles. An asset is usable by a circle only when it is
    // registered, enabled, AND carries the role the money path needs.
    // Assets registered before v11 carry no flags until the registry
    // admin sets them, so nothing changes for them by accident.
    // ----------------------------------------------------------
    const FLAG_SETTLEMENT: u64 = 1; // may be a circle's contribution asset
    const FLAG_DEPOSIT: u64 = 2; // may be paid as a circle's security deposit
    const FLAG_USD_PEGGED: u64 = 4; // native = cents * 10^(decimals - 2) is meaningful
    const ALL_FLAGS: u64 = 7;

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
    /// stablecoins or other new assets after publishing the package, so
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
    // v11 — canonical registry, asset roles, admin handover
    //
    // Layout of AssetEntry / AssetRegistry is unchanged (upgrade rule);
    // the new facts live in dynamic fields on the registry's UID under
    // key types no earlier package version can construct.
    //
    // Adding an asset later is one registry-admin transaction
    // (`register_asset_with_metadata` / `register_asset_with_currency`
    // with its flags) plus app configuration — no package publish.
    // Disabling an asset (`set_asset_enabled(false)`) blocks new
    // commitments only; refunds, claims and recovery never consult the
    // registry.
    // ----------------------------------------------------------

    /// Present (value `true`) on exactly the registries blessed by the
    /// holder of this package lineage's UpgradeCap.
    public struct CanonicalKey has copy, drop, store {}

    /// Role flags of one registered asset (FLAG_* bitmask). Absent == 0.
    public struct AssetFlagsKey has copy, drop, store { coin_type: vector<u8> }

    public struct RegistryBlessed has copy, drop {
        registry_id: ID,
        blessed_by: address,
    }

    public struct AssetFlagsSet has copy, drop {
        registry_id: ID,
        coin_type: vector<u8>,
        flags: u64,
        set_by: address,
    }

    public struct RegistryAdminTransferred has copy, drop {
        registry_id: ID,
        previous_admin: address,
        new_admin: address,
    }

    /// Marks `registry` as the protocol's canonical AssetRegistry. Only the
    /// holder of THIS lineage's UpgradeCap can do it (same lineage pin as
    /// njangi_compliance), because `init_registry` is open to anyone and a
    /// money path must never trust a registry somebody else administers.
    /// Idempotent.
    public fun bless_canonical(registry: &mut AssetRegistry, cap: &UpgradeCap, ctx: &TxContext) {
        assert_canonical_upgrade_cap(cap);
        if (!df::exists_(&registry.id, CanonicalKey {})) {
            df::add(&mut registry.id, CanonicalKey {}, true);
        };
        event::emit(RegistryBlessed {
            registry_id: object::id(registry),
            blessed_by: tx_context::sender(ctx),
        });
    }

    public fun is_canonical(registry: &AssetRegistry): bool {
        df::exists_with_type<CanonicalKey, bool>(&registry.id, CanonicalKey {})
    }

    public fun registry_admin(registry: &AssetRegistry): address {
        registry.admin
    }

    /// Registers `T` with its decimals read from the coin's own
    /// `CoinMetadata<T>` (no hand-typed key or decimals) and its role flags.
    public fun register_asset_with_metadata<T>(
        registry: &mut AssetRegistry,
        metadata: &CoinMetadata<T>,
        oracle_price_id: vector<u8>,
        max_age_secs: u64,
        flags: u64,
        ctx: &TxContext
    ) {
        let decimals = coin::get_decimals(metadata);
        register_typed_asset<T>(registry, decimals, oracle_price_id, max_age_secs, flags, ctx);
    }

    /// Same as `register_asset_with_metadata` for coins whose metadata lives
    /// in the framework coin registry (`Currency<T>`).
    public fun register_asset_with_currency<T>(
        registry: &mut AssetRegistry,
        currency: &Currency<T>,
        oracle_price_id: vector<u8>,
        max_age_secs: u64,
        flags: u64,
        ctx: &TxContext
    ) {
        let decimals = coin_registry::decimals(currency);
        register_typed_asset<T>(registry, decimals, oracle_price_id, max_age_secs, flags, ctx);
    }

    fun register_typed_asset<T>(
        registry: &mut AssetRegistry,
        decimals: u8,
        oracle_price_id: vector<u8>,
        max_age_secs: u64,
        flags: u64,
        ctx: &TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == registry.admin, E_NOT_ADMIN);
        assert!(vector::length(&oracle_price_id) == PRICE_ID_BYTES, E_INVALID_PRICE_ID_LENGTH);
        let coin_type = core::coin_type_bytes<T>();
        assert!(!table::contains(&registry.assets, coin_type), E_ASSET_ALREADY_REGISTERED);
        assert_valid_flags(flags, decimals);

        table::add(&mut registry.assets, coin_type, AssetEntry {
            oracle_price_id,
            decimals,
            max_age_secs,
            enabled: true,
        });
        write_flags(registry, coin_type, flags);

        event::emit(AssetRegistered {
            coin_type,
            oracle_price_id,
            decimals,
            max_age_secs,
            registered_by: sender,
        });
        event::emit(AssetFlagsSet {
            registry_id: object::id(registry),
            coin_type,
            flags,
            set_by: sender,
        });
    }

    /// Sets the role flags of an already-registered asset (e.g. SUI, which
    /// `init_registry` seeds without flags). Registry admin only.
    public fun set_asset_flags(
        registry: &mut AssetRegistry,
        coin_type: vector<u8>,
        flags: u64,
        ctx: &TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == registry.admin, E_NOT_ADMIN);
        assert!(table::contains(&registry.assets, coin_type), E_UNSUPPORTED_ASSET);
        let decimals = table::borrow(&registry.assets, coin_type).decimals;
        assert_valid_flags(flags, decimals);
        write_flags(registry, coin_type, flags);
        event::emit(AssetFlagsSet {
            registry_id: object::id(registry),
            coin_type,
            flags,
            set_by: sender,
        });
    }

    public fun asset_flags(registry: &AssetRegistry, coin_type: vector<u8>): u64 {
        let key = AssetFlagsKey { coin_type };
        if (df::exists_with_type<AssetFlagsKey, u64>(&registry.id, key)) {
            *df::borrow<AssetFlagsKey, u64>(&registry.id, key)
        } else {
            0
        }
    }

    /// Hands the registry to a new admin (e.g. the operator multisig).
    public fun transfer_registry_admin(
        registry: &mut AssetRegistry,
        new_admin: address,
        ctx: &TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == registry.admin, E_NOT_ADMIN);
        assert!(new_admin != @0x0, E_INVALID_ADMIN);
        registry.admin = new_admin;
        event::emit(RegistryAdminTransferred {
            registry_id: object::id(registry),
            previous_admin: sender,
            new_admin,
        });
    }

    public fun flag_settlement(): u64 { FLAG_SETTLEMENT }
    public fun flag_deposit(): u64 { FLAG_DEPOSIT }
    public fun flag_usd_pegged(): u64 { FLAG_USD_PEGGED }

    /// The gate every v11 commitment path runs: the registry is canonical,
    /// `T` is registered and enabled, and it carries `role`. Returns the
    /// registered decimals so callers snapshot them from the registry
    /// rather than from the caller.
    public(package) fun assert_usable<T>(registry: &AssetRegistry, role: u64): u8 {
        assert!(is_canonical(registry), E_REGISTRY_NOT_CANONICAL);
        let coin_type = core::coin_type_bytes<T>();
        assert!(table::contains(&registry.assets, coin_type), E_UNSUPPORTED_ASSET);
        let entry = table::borrow(&registry.assets, coin_type);
        assert!(entry.enabled, E_UNSUPPORTED_ASSET);
        assert!(asset_flags(registry, coin_type) & role == role, E_ASSET_LACKS_ROLE);
        entry.decimals
    }

    /// True when `T` is flagged USD-pegged in `registry`.
    public fun is_usd_pegged<T>(registry: &AssetRegistry): bool {
        asset_flags(registry, core::coin_type_bytes<T>()) & FLAG_USD_PEGGED == FLAG_USD_PEGGED
    }

    fun assert_valid_flags(flags: u64, decimals: u8) {
        assert!(flags & ALL_FLAGS == flags, E_INVALID_FLAGS);
        // The USD-peg formula needs at least cent precision.
        if (flags & FLAG_USD_PEGGED == FLAG_USD_PEGGED) {
            assert!(decimals >= 2, E_INVALID_FLAGS);
        };
    }

    fun write_flags(registry: &mut AssetRegistry, coin_type: vector<u8>, flags: u64) {
        let key = AssetFlagsKey { coin_type };
        if (df::exists_with_type<AssetFlagsKey, u64>(&registry.id, key)) {
            *df::borrow_mut<AssetFlagsKey, u64>(&mut registry.id, key) = flags;
        } else {
            df::add(&mut registry.id, key, flags);
        };
    }

    // Same lineage binding as njangi_compliance::assert_canonical_upgrade_cap
    // (a cap of ANY package satisfies `&UpgradeCap`): accept the cap only if
    // it points at this package's runtime id (never-upgraded lineage) or IS
    // the pinned UpgradeCap object of this lineage.
    fun assert_canonical_upgrade_cap(cap: &UpgradeCap) {
        let fresh_publish_cap =
            package::upgrade_package(cap) == object::id_from_address(@njangi);
        let pinned_lineage_cap =
            object::id(cap) == object::id_from_address(@njangi_upgrade_cap);
        assert!(fresh_publish_cap || pinned_lineage_cap, E_FOREIGN_UPGRADE_CAP);
    }

    #[test_only]
    /// Shares a registry seeded with SUI (like `init_registry`) and returns
    /// its id; tests bless it with a lineage cap from `package::test_publish`.
    public fun init_registry_for_testing(ctx: &mut TxContext): ID {
        let admin = tx_context::sender(ctx);
        let mut assets = table::new<vector<u8>, AssetEntry>(ctx);
        table::add(&mut assets, SUI_TYPE, AssetEntry {
            oracle_price_id: SUI_USD_PRICE_ID,
            decimals: 9,
            max_age_secs: 60,
            enabled: true,
        });
        let registry = AssetRegistry { id: object::new(ctx), admin, assets };
        let id = object::id(&registry);
        transfer::share_object(registry);
        id
    }

    #[test_only]
    /// Registers `T` with explicit decimals instead of a CoinMetadata (test
    /// coins have no metadata object).
    public fun register_asset_for_testing<T>(
        registry: &mut AssetRegistry,
        decimals: u8,
        flags: u64,
        ctx: &TxContext
    ) {
        register_typed_asset<T>(registry, decimals, SUI_USD_PRICE_ID, 60, flags, ctx);
    }

    // ----------------------------------------------------------
    // Validation entrypoints
    // ----------------------------------------------------------

    /// RETIRED in v11: no circle prices a deposit with an oracle. Deposits
    /// are exact amounts of the circle's pinned asset (njangi_circles::
    /// post_security_deposit), gated by `assert_usable`.
    public fun validate_stablecoin_deposit_with_registry(
        _registry: &AssetRegistry,
        _price_info_object: &PriceInfoObject,
        _amount: u64,
        _required_amount: u64,
        _coin_type_str: String,
        _clock: &Clock,
        _ctx: &mut TxContext
    ): u64 {
        abort E_DEPRECATED
    }

    /// RETIRED in v11 (see `validate_stablecoin_deposit_with_registry`).
    public fun validate_stablecoin_deposit(
        _price_info_object: &PriceInfoObject,
        _amount: u64,
        _required_amount: u64,
        _coin_type_str: String,
        _clock: &Clock,
        _ctx: &mut TxContext
    ): u64 {
        abort E_DEPRECATED
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
