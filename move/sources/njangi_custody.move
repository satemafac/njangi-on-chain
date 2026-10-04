module njangi::njangi_custody {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::sui::SUI;
    use sui::dynamic_field;
    use sui::dynamic_object_field;
    use std::string::{Self, String};
    use std::type_name;
    use std::ascii;
    
    use njangi::njangi_core as core;
    use pyth::price_info::PriceInfoObject;

    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    // 43, 44, 50 and 55 belonged to the legacy-storage movers retired in
    // v11; do not reuse them.
    const EInsufficientAmount: u64 = 53;
    const EInvalidPriceInfo: u64 = 54;
    const EInvalidDecimalPrecision: u64 = 56;
    const EDecimalConversionOverflow: u64 = 57;
    const EPrecisionLoss: u64 = 58;
    // v11: the wallet's deposit records for an asset hold less than a
    // member refund asked for.
    const EDepositBalanceInsufficient: u64 = 59;
    // Mirrors njangi_circles::E_DEPRECATED_ENTRYPOINT.
    const EDeprecated: u64 = 89;
    
    // ----------------------------------------------------------
    // Local constants from core
    // ----------------------------------------------------------
    const SUI_DECIMALS: u8 = 9;
    const USDC_DECIMALS: u8 = 6;
    const USD_CENTS_DECIMALS: u8 = 2;
    const MAX_DECIMAL_SHIFT: u8 = 18;
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;
    
    // ----------------------------------------------------------
    // Custody wallet linked to a circle for secure fund storage
    // ----------------------------------------------------------
    public struct CustodyWallet has key, store {
        id: UID,
        circle_id: ID,
        balance: Balance<SUI>,
        admin: address,
        created_at: u64,
        locked_until: Option<u64>,
        is_active: bool,
        transaction_history: vector<CustodyTransaction>, // History of transactions
    }
    
    // ----------------------------------------------------------
    // Transaction record for custody wallet operations
    // ----------------------------------------------------------
    public struct CustodyTransaction has store, drop {
        operation_type: u8,
        user: address,
        amount: u64,
        timestamp: u64,
    }
    
    // ----------------------------------------------------------
    // New structure to hold a stablecoin balance
    // ----------------------------------------------------------
    #[allow(unused_field)]
    public struct StablecoinBalance has store {
        balance: Balance<SUI>, // Placeholder type as we'll use dynamic fields
        coin_type: String,     // String representation of the coin type
        last_updated: u64,     // Timestamp of last update
    }
    
    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    public struct CustodyWalletCreated has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        admin: address,
    }
    
    public struct CustodyDeposited has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        member: address,
        amount: u64,
        operation_type: u8,
    }
    
    public struct CustodyWithdrawn has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        recipient: address,
        amount: u64,
        operation_type: u8,
    }
    
    public struct StablecoinHoldingUpdated has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        coin_type: String,
        previous_balance: u64,
        new_balance: u64,
        timestamp: u64,
    }
    
    public struct CoinDeposited has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        coin_type: String,
        amount: u64,
        member: address,
        previous_balance: u64,
        new_balance: u64,
        timestamp: u64,
    }
    
    public struct StablecoinDepositWithPrice has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        coin_type: String,
        amount: u64,
        usd_value: u64,
        member: address,
        timestamp: u64,
    }

    // ----------------------------------------------------------
    // v11 deposit records
    //
    // `DepositBalanceKey { asset }` -> `Balance<T>` is a typed record inside
    // this circle's custody wallet holding the members' security deposits
    // in asset `T`. The key type is new in v11 and only this module can
    // construct it, so the coins are reachable solely through the
    // package-internal helpers below. Their one caller, njangi_circles,
    // keeps the per-member amounts (`MemberDepositKey`) and only ever pays
    // a deposit back to the member it is recorded for. No admin, operator
    // or capability holder has a path to these coins.
    // Moves of these records do not append to `transaction_history`, which
    // therefore stays an exact ledger of legacy storage.
    // ----------------------------------------------------------
    public struct DepositBalanceKey has copy, drop, store { asset: vector<u8> }

    /// Written at the legacy typed-balance key of an asset once that asset's
    /// legacy balance has moved to the v11 deposit records (conversion) or,
    /// for circles created on v11, when the wallet is created. The legacy
    /// slot of a v11 asset never holds coins again.
    public struct LegacySlotMigrated has store, drop { migrated_at_ms: u64 }
    
    // ----------------------------------------------------------
    // Create a new custody wallet
    //
    // Kept at its original `()` return type on purpose. Changing an existing
    // public function's signature is an upgrade-INCOMPATIBLE change in Sui: it
    // would force a fresh publish, mint a new package id, and orphan every
    // circle on the current lineage. New callers should use
    // `create_custody_wallet_returning_id` below; adding a function is
    // upgrade-compatible, editing this one is not.
    // ----------------------------------------------------------
    public fun create_custody_wallet(
        circle_id: ID,
        timestamp: u64,
        ctx: &mut TxContext
    ) {
        let _wallet_id = create_custody_wallet_returning_id(circle_id, timestamp, ctx);
    }

    // ----------------------------------------------------------
    // Create a new custody wallet and hand back its id
    //
    // The id exists right here at creation time. Without this, callers had to
    // rediscover it afterwards from the `CustodyWalletCreated` event below — a
    // discovery path that depends on the answering RPC still serving event
    // history, and that goes silently empty (HTTP 200, no rows) when the event
    // filter is built from a post-upgrade package id. A circle whose wallet
    // could not be rediscovered lost its recovery path while its funds sat
    // safely in custody.
    // ----------------------------------------------------------
    public fun create_custody_wallet_returning_id(
        circle_id: ID,
        timestamp: u64,
        ctx: &mut TxContext
    ): ID {
        let admin = tx_context::sender(ctx);
        
        // Create custody wallet without stablecoin config
        let wallet = CustodyWallet {
            id: object::new(ctx),
            circle_id,
            balance: balance::zero<SUI>(),
            admin,
            created_at: timestamp,
            locked_until: option::none(),
            is_active: true,
            transaction_history: vector::empty(),
        };
        
        // Get the wallet ID before sharing
        let wallet_id = object::uid_to_inner(&wallet.id);
        
        // Share the wallet object
        transfer::share_object(wallet);
        
        event::emit(CustodyWalletCreated {
            circle_id,
            wallet_id,
            admin,
        });

        wallet_id
    }

    // ----------------------------------------------------------
    // Compliance note: the public `deposit`, `withdraw`, `lock_wallet`,
    // `unlock_wallet`, and `withdraw_from_dynamic_fields` admin levers were
    // removed in the non-custodial Phase 1 cleanup. In v11 the legacy
    // storage movers (legacy-rail payouts and legacy-storage refunds) are
    // gone too: a member's deposit moves only through the v11 deposit
    // records below, and only back to that member. Legacy storage is read
    // (views, conversion) and moved only by conversion, into the v11
    // records of the same wallet.
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // Get wallet balance
    // ----------------------------------------------------------
    public fun get_balance(wallet: &CustodyWallet): u64 {
        core::from_decimals(balance::value(&wallet.balance))
    }
    
    // ----------------------------------------------------------
    // Get raw wallet balance (in decimals)
    // ----------------------------------------------------------
    public fun get_raw_balance(wallet: &CustodyWallet): u64 {
        balance::value(&wallet.balance)
    }
    
    // ----------------------------------------------------------
    // Get total wallet balance (main balance + dynamic fields)
    // ----------------------------------------------------------
    public fun get_total_wallet_balance(wallet: &CustodyWallet): u64 {
        let main_balance = balance::value(&wallet.balance);

        // Include SUI in both legacy Coin-object storage and new Balance storage.
        main_balance + get_stablecoin_balance<SUI>(wallet)
    }
    
    // ----------------------------------------------------------
    // Get wallet circle ID
    // ----------------------------------------------------------
    public fun get_circle_id(wallet: &CustodyWallet): ID {
        wallet.circle_id
    }
    
    // ----------------------------------------------------------
    // Check if wallet is active
    // ----------------------------------------------------------
    public fun is_wallet_active(wallet: &CustodyWallet): bool {
        wallet.is_active
    }
    
    // ----------------------------------------------------------
    // Check if wallet is locked
    // ----------------------------------------------------------
    public fun is_wallet_locked(wallet: &CustodyWallet): bool {
        option::is_some(&wallet.locked_until)
    }
    
    // ----------------------------------------------------------
    // Get wallet lock time
    // ----------------------------------------------------------
    public fun get_lock_time(wallet: &CustodyWallet): u64 {
        if (option::is_some(&wallet.locked_until)) {
            *option::borrow(&wallet.locked_until)
        } else {
            0
        }
    }
    
    // ----------------------------------------------------------
    // Get wallet admin
    // ----------------------------------------------------------
    public fun get_admin(wallet: &CustodyWallet): address {
        wallet.admin
    }

    // Creation timestamp recorded when the wallet was created (the circle's
    // own create transaction stamps both with the same clock reading).
    public fun get_created_at(wallet: &CustodyWallet): u64 {
        wallet.created_at
    }
    
    // ----------------------------------------------------------
    // Stablecoin Storage Helpers Using Dynamic Fields
    // ----------------------------------------------------------

    // Returns 10^shift while bounding the exponent to keep conversions safe.
    fun decimal_scale(shift: u8): u64 {
        assert!(shift <= MAX_DECIMAL_SHIFT, EInvalidDecimalPrecision);
        let mut scale = 1;
        let mut i: u8 = 0;
        while (i < shift) {
            assert!(scale <= MAX_U64 / 10, EDecimalConversionOverflow);
            scale = scale * 10;
            i = i + 1;
        };
        scale
    }

    // Convert an amount between decimal precisions.
    public fun convert_amount(amount: u64, from_decimals: u8, to_decimals: u8): u64 {
        assert!(from_decimals <= MAX_DECIMAL_SHIFT, EInvalidDecimalPrecision);
        assert!(to_decimals <= MAX_DECIMAL_SHIFT, EInvalidDecimalPrecision);

        if (from_decimals == to_decimals) {
            return amount
        };

        if (from_decimals < to_decimals) {
            let scale = decimal_scale(to_decimals - from_decimals);
            assert!(amount <= MAX_U64 / scale, EDecimalConversionOverflow);
            amount * scale
        } else {
            let scale = decimal_scale(from_decimals - to_decimals);
            amount / scale
        }
    }

    // Detect whether down-scaling will truncate remainder digits.
    public fun has_precision_loss(amount: u64, from_decimals: u8, to_decimals: u8): bool {
        assert!(from_decimals <= MAX_DECIMAL_SHIFT, EInvalidDecimalPrecision);
        assert!(to_decimals <= MAX_DECIMAL_SHIFT, EInvalidDecimalPrecision);

        if (from_decimals <= to_decimals) {
            return false
        };

        let scale = decimal_scale(from_decimals - to_decimals);
        amount % scale != 0
    }

    // Convert with strict validation; aborts if information would be truncated.
    public fun convert_amount_exact(amount: u64, from_decimals: u8, to_decimals: u8): u64 {
        assert!(!has_precision_loss(amount, from_decimals, to_decimals), EPrecisionLoss);
        convert_amount(amount, from_decimals, to_decimals)
    }

    // Convert USD cents (2dp) to USDC micro-units (6dp).
    public fun usd_cents_to_usdc_amount(usd_cents: u64): u64 {
        convert_amount(usd_cents, USD_CENTS_DECIMALS, USDC_DECIMALS)
    }

    // Convert USDC micro-units (6dp) to USD cents (2dp).
    public fun usdc_amount_to_usd_cents(usdc_amount: u64): u64 {
        convert_amount(usdc_amount, USDC_DECIMALS, USD_CENTS_DECIMALS)
    }

    // Convert SUI mist (9dp) to USD cents (2dp) using price in USD cents per 1 SUI.
    public fun sui_to_usd_cents(sui_amount: u64, sui_price_usd_cents: u64): u64 {
        assert!(sui_price_usd_cents > 0, EInvalidPriceInfo);
        assert!(sui_amount <= MAX_U64 / sui_price_usd_cents, EDecimalConversionOverflow);
        let usd_numerator = sui_amount * sui_price_usd_cents;
        usd_numerator / decimal_scale(SUI_DECIMALS)
    }

    // Convert USD cents (2dp) to SUI mist (9dp) using price in USD cents per 1 SUI.
    public fun usd_cents_to_sui(usd_cents: u64, sui_price_usd_cents: u64): u64 {
        assert!(sui_price_usd_cents > 0, EInvalidPriceInfo);
        let sui_scale = decimal_scale(SUI_DECIMALS);
        assert!(usd_cents <= MAX_U64 / sui_scale, EDecimalConversionOverflow);
        let sui_numerator = usd_cents * sui_scale;
        sui_numerator / sui_price_usd_cents
    }

    // Indicates whether SUI->USD conversion will truncate fractional cents.
    public fun has_rounding_in_sui_to_usd_cents(sui_amount: u64, sui_price_usd_cents: u64): bool {
        assert!(sui_price_usd_cents > 0, EInvalidPriceInfo);
        assert!(sui_amount <= MAX_U64 / sui_price_usd_cents, EDecimalConversionOverflow);
        let usd_numerator = sui_amount * sui_price_usd_cents;
        let usd_scale = decimal_scale(SUI_DECIMALS);
        usd_numerator % usd_scale != 0
    }

    // Indicates whether USD->SUI conversion will truncate fractional mist units.
    public fun has_rounding_in_usd_cents_to_sui(usd_cents: u64, sui_price_usd_cents: u64): bool {
        assert!(sui_price_usd_cents > 0, EInvalidPriceInfo);
        let sui_scale = decimal_scale(SUI_DECIMALS);
        assert!(usd_cents <= MAX_U64 / sui_scale, EDecimalConversionOverflow);
        let sui_numerator = usd_cents * sui_scale;
        sui_numerator % sui_price_usd_cents != 0
    }
    
    // Generate a key for storing coin objects
    fun coin_field_name(): String {
        // Legacy key used by dynamic_object_field<Coin<T>> storage.
        string::utf8(b"coin_objects")
    }

    // Generate a type-specific key for dynamic_field<String, Balance<CoinType>> storage.
    fun balance_field_name<CoinType>(): String {
        let type_name_str = type_name::into_string(type_name::get<CoinType>());
        string::utf8(ascii::into_bytes(type_name_str))
    }
    
    // Check if a stablecoin balance exists. Typed lookups only (v11): a slot
    // holding another type — a different coin, or a migrated marker — is
    // not a balance of `CoinType`.
    public fun has_stablecoin_balance<CoinType>(wallet: &CustodyWallet): bool {
        dynamic_object_field::exists_with_type<String, Coin<CoinType>>(&wallet.id, coin_field_name())
            || dynamic_field::exists_with_type<String, Balance<CoinType>>(&wallet.id, balance_field_name<CoinType>())
    }
    
    // Get a stablecoin balance from stored coins. Every read is type-checked
    // (`exists_with_type`), so one asset's legacy storage can never make a
    // read of another asset abort.
    public fun get_stablecoin_balance<CoinType>(wallet: &CustodyWallet): u64 {
        // New storage path: dynamic_field<String, Balance<CoinType>>
        let balance_field = balance_field_name<CoinType>();
        let dynamic_balance = if (dynamic_field::exists_with_type<String, Balance<CoinType>>(&wallet.id, balance_field)) {
            let stored_balance = dynamic_field::borrow<String, Balance<CoinType>>(&wallet.id, balance_field);
            balance::value(stored_balance)
        } else {
            0
        };

        // Legacy storage path: dynamic_object_field<String, Coin<CoinType>>
        let legacy_field = coin_field_name();
        let legacy_balance = if (dynamic_object_field::exists_with_type<String, Coin<CoinType>>(&wallet.id, legacy_field)) {
            let coin = dynamic_object_field::borrow<String, Coin<CoinType>>(&wallet.id, legacy_field);
            coin::value(coin)
        } else {
            0
        };

        dynamic_balance + legacy_balance
    }

    // Track coin type metadata
    fun register_stablecoin_type<CoinType>(wallet: &mut CustodyWallet) {
        // Get the type name as an ascii::String
        let type_name_str = type_name::into_string(type_name::get<CoinType>());
        
        // Convert to string::String
        let string_type = string::utf8(ascii::into_bytes(type_name_str));
        
        // Create the key for dynamic field access
        let key = string::utf8(b"registered_types");
        
        // Check if we already have a vector of registered types
        if (!dynamic_field::exists_(&wallet.id, key)) {
            // If not, create a new vector with this type
            let mut types = vector::empty<String>();
            vector::push_back<String>(&mut types, string_type);
            dynamic_field::add(&mut wallet.id, key, types);
        } else {
            // Get existing registered types
            let types = dynamic_field::borrow<String, vector<String>>(&wallet.id, key);
            
            // Check if type is already registered
            let mut i = 0;
            let len = vector::length(types);
            while (i < len) {
                let stored_type = vector::borrow(types, i);
                if (string::bytes(stored_type) == string::bytes(&string_type)) {
                    // Type already registered, do nothing
                    return
                };
                i = i + 1;
            };
            
            // Add the new type to registered types
            let existing_types = dynamic_field::borrow_mut<String, vector<String>>(&mut wallet.id, key);
            vector::push_back<String>(existing_types, string_type);
        }
    }
    
    // Get all supported stablecoin types
    public fun get_supported_stablecoin_types(wallet: &CustodyWallet): vector<String> {
        let key = string::utf8(b"registered_types");
        if (dynamic_field::exists_(&wallet.id, key)) {
            *dynamic_field::borrow(&wallet.id, key)
        } else {
            vector::empty()
        }
    }
    
    // Metadata-by-symbol views — RETIRED in v11. Nothing ever wrote the
    // fields they read, so they could only answer a guessed default. A
    // circle's decimals live in its pinned asset terms (njangi_circles).
    public fun get_coin_decimals(_wallet: &CustodyWallet, _coin_symbol: String): u8 {
        abort EDeprecated
    }

    public fun get_coin_type_path(_wallet: &CustodyWallet, _coin_symbol: String): String {
        abort EDeprecated
    }

    // ----------------------------------------------------------
    // Get total stablecoin value in USD (simplified)
    // ----------------------------------------------------------
    public fun get_total_stablecoin_value_usd(wallet: &CustodyWallet): u64 {
        let _stablecoin_types = get_supported_stablecoin_types(wallet);
        
        // In a real implementation, we'd sum up the balances of all stablecoin types
        // and convert to USD value. For simplicity, we're just returning 0 here.
        0
    }
    
    // ----------------------------------------------------------
    // Oracle-priced deposit validation — RETIRED in v11 (deposits are
    // exact amounts of the circle's pinned asset; no oracle on the money
    // path).
    // ----------------------------------------------------------
    #[allow(unused_type_parameter)]
    public fun validate_deposit_amount<CoinType>(
        _amount: u64,
        _required_amount: u64,
        _price_info_object: &PriceInfoObject,
        _clock: &Clock,
        _ctx: &mut TxContext
    ): u64 {
        abort EDeprecated
    }

    // ----------------------------------------------------------
    // Get wallet balance in raw form (keeping decimals)
    // Checks both the main balance field and any SUI in dynamic fields
    // ----------------------------------------------------------
    public fun get_wallet_balance(wallet: &CustodyWallet): u64 {
        // Get the balance from the main field
        let main_balance = balance::value(&wallet.balance);
        
        // Check for any SUI stored in dynamic fields
        let sui_in_dynamic_fields = get_stablecoin_balance<SUI>(wallet);
        
        // Return the combined balance
        main_balance + sui_in_dynamic_fields
    }
    
    // ----------------------------------------------------------
    // Check if the wallet has any stablecoin balance of any type
    // ----------------------------------------------------------
    public fun has_any_stablecoin_balance(wallet: &CustodyWallet): bool {
        let stablecoin_types = get_supported_stablecoin_types(wallet);
        let len = vector::length(&stablecoin_types);
        
        // If we don't have any registered stablecoin types, return false
        if (len == 0) {
            return false
        };
        
        // Legacy check: old dynamic_object_field key.
        let coin_objects_key = string::utf8(b"coin_objects");
        if (dynamic_object_field::exists_(&wallet.id, coin_objects_key)) {
            return true
        };

        // New check: typed dynamic_field<String, Balance<CoinType>> keys. A
        // slot that only carries the v11 migrated marker holds no coins.
        let mut i = 0;
        while (i < len) {
            let coin_type_key = *vector::borrow(&stablecoin_types, i);
            if (
                dynamic_field::exists_(&wallet.id, coin_type_key)
                    && !dynamic_field::exists_with_type<String, LegacySlotMigrated>(&wallet.id, coin_type_key)
            ) {
                return true
            };
            i = i + 1;
        };

        // Check for SUI in dynamic fields as a fallback
        // This is kept for backward compatibility
        let sui_dynamic_field = get_stablecoin_balance<SUI>(wallet);
        if (sui_dynamic_field > 0) {
            return true
        };
        
        false
    }

    // ----------------------------------------------------------
    // v11 deposit-record primitives (package-internal)
    // ----------------------------------------------------------

    fun deposit_balance_key<T>(): DepositBalanceKey {
        DepositBalanceKey { asset: core::coin_type_bytes<T>() }
    }

    /// Joins `funds` into the wallet's deposit record for `T`; returns the
    /// record's new value.
    public(package) fun join_deposit_balance<T>(wallet: &mut CustodyWallet, funds: Balance<T>): u64 {
        let key = deposit_balance_key<T>();
        if (dynamic_field::exists_with_type<DepositBalanceKey, Balance<T>>(&wallet.id, key)) {
            let record = dynamic_field::borrow_mut<DepositBalanceKey, Balance<T>>(&mut wallet.id, key);
            balance::join(record, funds)
        } else {
            let value = balance::value(&funds);
            dynamic_field::add(&mut wallet.id, key, funds);
            value
        }
    }

    /// Splits `amount` out of the deposit record for `T`. The only caller,
    /// njangi_circles, asks for exactly a member's recorded deposit and
    /// pays it to that member.
    public(package) fun split_deposit_balance<T>(wallet: &mut CustodyWallet, amount: u64): Balance<T> {
        let key = deposit_balance_key<T>();
        assert!(dynamic_field::exists_with_type<DepositBalanceKey, Balance<T>>(&wallet.id, key), EDepositBalanceInsufficient);
        let record = dynamic_field::borrow_mut<DepositBalanceKey, Balance<T>>(&mut wallet.id, key);
        assert!(balance::value(record) >= amount, EDepositBalanceInsufficient);
        balance::split(record, amount)
    }

    /// Coins of `T` held in this wallet's v11 deposit records.
    public fun deposit_balance_value<T>(wallet: &CustodyWallet): u64 {
        let key = deposit_balance_key<T>();
        if (dynamic_field::exists_with_type<DepositBalanceKey, Balance<T>>(&wallet.id, key)) {
            balance::value(dynamic_field::borrow<DepositBalanceKey, Balance<T>>(&wallet.id, key))
        } else {
            0
        }
    }

    /// Records a member's security deposit in `T` (njangi_circles::
    /// post_security_deposit) and emits the custody deposit event the
    /// notification relay follows (the coin type and decimals travel in
    /// njangi_circles::SecurityDepositPosted).
    public(package) fun store_member_deposit<T>(
        wallet: &mut CustodyWallet,
        deposit: Coin<T>,
        member: address
    ): u64 {
        let amount = coin::value(&deposit);
        assert!(amount > 0, EInsufficientAmount);
        let new_balance = join_deposit_balance<T>(wallet, coin::into_balance(deposit));
        event::emit(CustodyDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            member,
            amount,
            operation_type: core::custody_op_stablecoin_deposit(),
        });
        new_balance
    }

    /// v11: creates the circle's wallet with T's legacy slot already marked
    /// migrated, so the wallet keeps `T` only in its v11 deposit records.
    /// Shared, like every custody wallet.
    public(package) fun create_custody_wallet_for_asset<T>(
        circle_id: ID,
        timestamp: u64,
        ctx: &mut TxContext
    ): ID {
        let admin = tx_context::sender(ctx);
        let mut wallet = CustodyWallet {
            id: object::new(ctx),
            circle_id,
            balance: balance::zero<SUI>(),
            admin,
            created_at: timestamp,
            locked_until: option::none(),
            is_active: true,
            transaction_history: vector::empty(),
        };
        dynamic_field::add(
            &mut wallet.id,
            balance_field_name<T>(),
            LegacySlotMigrated { migrated_at_ms: timestamp }
        );
        register_stablecoin_type<T>(&mut wallet);

        let wallet_id = object::uid_to_inner(&wallet.id);
        transfer::share_object(wallet);
        event::emit(CustodyWalletCreated { circle_id, wallet_id, admin });
        wallet_id
    }

    // ----------------------------------------------------------
    // v11 conversion helpers (package-internal)
    //
    // A legacy circle converts by moving its legacy deposits into the v11
    // deposit records of the same wallet. The per-member amounts come from
    // `transaction_history`, which only package code writes and only when
    // coins actually move.
    // ----------------------------------------------------------

    public(package) fun legacy_history_length(wallet: &CustodyWallet): u64 {
        vector::length(&wallet.transaction_history)
    }

    /// True when legacy storage has only ever held `T` (`registered_types`
    /// ⊆ {T}), holds it only as a typed balance (no `coin_objects`), holds
    /// no SUI when `T` is not SUI, and its ledger records only security
    /// deposits (op 3) and withdrawals (op 1).
    public(package) fun legacy_is_single_asset<T>(wallet: &CustodyWallet): bool {
        let own_key = balance_field_name<T>();
        let types = get_supported_stablecoin_types(wallet);
        let mut i = 0;
        while (i < vector::length(&types)) {
            if (vector::borrow(&types, i) != &own_key) {
                return false
            };
            i = i + 1;
        };
        if (dynamic_object_field::exists_(&wallet.id, coin_field_name())) {
            return false
        };
        if (!core::is_sui<T>()) {
            if (balance::value(&wallet.balance) > 0) {
                return false
            };
            if (dynamic_field::exists_(&wallet.id, balance_field_name<SUI>())) {
                return false
            };
        };
        // T's slot holds T's balance or nothing; a migrated marker means the
        // slot was already converted.
        if (
            dynamic_field::exists_(&wallet.id, own_key)
                && !dynamic_field::exists_with_type<String, Balance<T>>(&wallet.id, own_key)
        ) {
            return false
        };
        let history = &wallet.transaction_history;
        let mut j = 0;
        while (j < vector::length(history)) {
            let op = vector::borrow(history, j).operation_type;
            if (op != core::custody_op_withdrawal() && op != core::custody_op_stablecoin_deposit()) {
                return false
            };
            j = j + 1;
        };
        true
    }

    /// Per-member net legacy deposits: Σ deposits − Σ withdrawals by
    /// `user`, over the whole ledger. The flag is false when some member was
    /// paid back more than they deposited, i.e. the ledger cannot be read as
    /// deposits and refunds alone.
    public(package) fun legacy_deposit_nets(wallet: &CustodyWallet): (bool, vector<address>, vector<u64>) {
        let history = &wallet.transaction_history;
        let mut users = vector::empty<address>();
        let mut deposited = vector::empty<u64>();
        let mut withdrawn = vector::empty<u64>();
        let mut i = 0;
        while (i < vector::length(history)) {
            let txn = vector::borrow(history, i);
            let (found, index) = vector::index_of(&users, &txn.user);
            let k = if (found) {
                index
            } else {
                vector::push_back(&mut users, txn.user);
                vector::push_back(&mut deposited, 0);
                vector::push_back(&mut withdrawn, 0);
                vector::length(&users) - 1
            };
            if (txn.operation_type == core::custody_op_stablecoin_deposit()) {
                let slot = vector::borrow_mut(&mut deposited, k);
                *slot = *slot + txn.amount;
            } else if (txn.operation_type == core::custody_op_withdrawal()) {
                let slot = vector::borrow_mut(&mut withdrawn, k);
                *slot = *slot + txn.amount;
            };
            i = i + 1;
        };

        let mut consistent = true;
        let mut nets = vector::empty<u64>();
        let mut k = 0;
        while (k < vector::length(&users)) {
            let d = *vector::borrow(&deposited, k);
            let w = *vector::borrow(&withdrawn, k);
            if (w > d) {
                consistent = false;
                vector::push_back(&mut nets, 0);
            } else {
                vector::push_back(&mut nets, d - w);
            };
            k = k + 1;
        };
        (consistent, users, nets)
    }

    /// Coins of `T` in legacy storage: its typed balance, plus the main
    /// balance when `T` is SUI.
    public(package) fun legacy_balance_of<T>(wallet: &CustodyWallet): u64 {
        let key = balance_field_name<T>();
        let typed = if (dynamic_field::exists_with_type<String, Balance<T>>(&wallet.id, key)) {
            balance::value(dynamic_field::borrow<String, Balance<T>>(&wallet.id, key))
        } else {
            0
        };
        if (core::is_sui<T>()) {
            typed + balance::value(&wallet.balance)
        } else {
            typed
        }
    }

    /// Moves every legacy coin of `T` into the wallet's v11 deposit record
    /// for `T` (same wallet, nothing leaves it) and marks T's legacy
    /// slot migrated. Returns the amount moved.
    public(package) fun migrate_legacy_to_deposit_balance<T>(wallet: &mut CustodyWallet, clock: &Clock): u64 {
        let key = balance_field_name<T>();
        let mut moved = 0;
        if (dynamic_field::exists_with_type<String, Balance<T>>(&wallet.id, key)) {
            let legacy = dynamic_field::remove<String, Balance<T>>(&mut wallet.id, key);
            moved = balance::value(&legacy);
            join_deposit_balance<T>(wallet, legacy);
        };
        if (core::is_sui<T>()) {
            moved = moved + migrate_main_sui_to_deposit_balance(wallet);
        };
        close_legacy_slot<T>(wallet, clock);
        moved
    }

    fun migrate_main_sui_to_deposit_balance(wallet: &mut CustodyWallet): u64 {
        let main = balance::withdraw_all(&mut wallet.balance);
        let value = balance::value(&main);
        if (value > 0) {
            join_deposit_balance<SUI>(wallet, main);
        } else {
            balance::destroy_zero(main);
        };
        value
    }

    /// Marks T's legacy slot migrated (`LegacySlotMigrated`) and records `T`
    /// in `registered_types`. The slot must hold no coins.
    public(package) fun close_legacy_slot<T>(wallet: &mut CustodyWallet, clock: &Clock) {
        let key = balance_field_name<T>();
        if (dynamic_field::exists_with_type<String, Balance<T>>(&wallet.id, key)) {
            let leftover = dynamic_field::remove<String, Balance<T>>(&mut wallet.id, key);
            balance::destroy_zero(leftover);
        };
        if (!dynamic_field::exists_(&wallet.id, key)) {
            dynamic_field::add(
                &mut wallet.id,
                key,
                LegacySlotMigrated { migrated_at_ms: clock::timestamp_ms(clock) }
            );
        };
        register_stablecoin_type<T>(wallet);
    }

    /// True when T's legacy slot carries the v11 migrated marker.
    public fun is_legacy_slot_migrated<T>(wallet: &CustodyWallet): bool {
        dynamic_field::exists_with_type<String, LegacySlotMigrated>(&wallet.id, balance_field_name<T>())
    }

    // ----------------------------------------------------------
    // Test-only: legacy-storage writes as package versions before v11 make
    // them (typed legacy balance + ledger entry), so tests can build a
    // wallet in the state those versions leave behind.
    // ----------------------------------------------------------
    #[test_only]
    public fun legacy_store_for_testing<CoinType>(
        wallet: &mut CustodyWallet,
        deposit: Coin<CoinType>,
        member: address,
        operation_type: u8,
        clock: &Clock
    ) {
        let amount = coin::value(&deposit);
        let field_name = balance_field_name<CoinType>();
        let incoming = coin::into_balance(deposit);
        // Untyped existence check, then a typed borrow — exactly what the
        // pre-v11 writer does, so a migrated slot makes it abort the same way.
        if (dynamic_field::exists_(&wallet.id, field_name)) {
            balance::join(dynamic_field::borrow_mut<String, Balance<CoinType>>(&mut wallet.id, field_name), incoming);
        } else {
            dynamic_field::add<String, Balance<CoinType>>(&mut wallet.id, field_name, incoming);
            register_stablecoin_type<CoinType>(wallet);
        };
        vector::push_back(&mut wallet.transaction_history, CustodyTransaction {
            operation_type,
            user: member,
            amount,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    #[test]
    fun test_convert_amount_between_usd_cents_and_usdc() {
        // $40.62 -> 40_620_000 microUSDC
        assert!(usd_cents_to_usdc_amount(4062) == 40620000, 9001);
        assert!(usdc_amount_to_usd_cents(40620000) == 4062, 9002);
    }

    #[test]
    fun test_convert_amount_generic_paths() {
        // 2dp -> 6dp
        assert!(convert_amount(1, 2, 6) == 10000, 9003);
        // 9dp -> 6dp truncates lower precision
        assert!(convert_amount(1000000001, 9, 6) == 1000000, 9004);
    }

    #[test]
    fun test_precision_loss_detection_and_exact_conversion() {
        assert!(has_precision_loss(1000000001, 9, 6), 9005);
        assert!(!has_precision_loss(1000000000, 9, 6), 9006);
        assert!(convert_amount_exact(1000000000, 9, 6) == 1000000, 9007);
    }

    #[test]
    fun test_sui_price_based_conversion_helpers() {
        // price = $2.50 per SUI, represented as 250 cents
        let one_sui_mist = 1000000000;
        assert!(sui_to_usd_cents(one_sui_mist, 250) == 250, 9008);
        assert!(usd_cents_to_sui(250, 250) == one_sui_mist, 9009);
    }

    #[test]
    fun test_rounding_detection_for_sui_price_conversions() {
        // 1 mist at $2.50/SUI cannot represent full cents exactly
        assert!(has_rounding_in_sui_to_usd_cents(1, 250), 9010);
        // $1 at $2.50/SUI yields exact 0.4 SUI in mist units
        assert!(!has_rounding_in_usd_cents_to_sui(100, 250), 9011);
    }
} 
