module njangi::njangi_custody {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::sui::SUI;
    use sui::dynamic_field;
    use sui::dynamic_object_field;
    use sui::transfer;
    use std::option::{Self, Option};
    use std::string::{Self, String};
    use std::vector;
    use std::type_name;
    use std::ascii;
    
    use njangi::njangi_core as core;
    use njangi::njangi_price_validator as price_validator;
    use pyth::price_info::PriceInfoObject;
    
    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    const ENotWalletOwner: u64 = 42;
    const EWalletNotActive: u64 = 43;
    const EFundsTimeLocked: u64 = 44;
    const EExceedsWithdrawalLimit: u64 = 45;
    const EUnsupportedToken: u64 = 50;
    const EInsufficientAmount: u64 = 53;
    const EInvalidPriceInfo: u64 = 54;
    const EInsufficientDepositValue: u64 = 55;
    
    // ----------------------------------------------------------
    // Local constants from core
    // ----------------------------------------------------------
    const CUSTODY_OP_DEPOSIT: u8 = 0;
    const CUSTODY_OP_WITHDRAWAL: u8 = 1;
    const CUSTODY_OP_PAYOUT: u8 = 2;
    const CUSTODY_OP_STABLECOIN_DEPOSIT: u8 = 3;
    const MS_PER_DAY: u64 = 86_400_000;
    
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
        daily_withdrawal_limit: u64,  // Maximum withdrawal per day
        last_withdrawal_time: u64,    // Timestamp of last withdrawal
        daily_withdrawal_total: u64,  // Running total of withdrawals for the day
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
    // Create a new custody wallet
    // ----------------------------------------------------------
    public fun create_custody_wallet(
        circle_id: ID,
        timestamp: u64,
        ctx: &mut TxContext
    ) {
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
            daily_withdrawal_limit: core::to_decimals(10000),
            last_withdrawal_time: 0,
            daily_withdrawal_total: 0,
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
    }
    
    // ----------------------------------------------------------
    // Create a transaction record
    // ----------------------------------------------------------
    fun create_transaction(
        operation_type: u8,
        user: address,
        amount: u64,
        timestamp: u64
    ): CustodyTransaction {
        CustodyTransaction {
            operation_type,
            user,
            amount,
            timestamp
        }
    }
    
    // ----------------------------------------------------------
    // Deposit to custody wallet
    // ----------------------------------------------------------
    public fun deposit(
        wallet: &mut CustodyWallet,
        payment: Coin<SUI>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&payment);
        
        // Wallet must be active
        assert!(wallet.is_active, EWalletNotActive);
        
        // Check if sender is admin or authorized depositor
        assert!(sender == wallet.admin || is_authorized_depositor(wallet.circle_id, sender), ENotWalletOwner);
        
        // Add to wallet balance
        balance::join(&mut wallet.balance, coin::into_balance(payment));
        
        // Add transaction record to history
        let txn = create_transaction(
            core::custody_op_deposit(),
            sender,
            amount,
            tx_context::epoch_timestamp_ms(ctx)
        );
        vector::push_back(&mut wallet.transaction_history, txn);
        
        // Emit deposit event
        event::emit(CustodyDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            member: sender,
            amount,
            operation_type: core::custody_op_deposit(),
        });
    }
    
    // Helper to check if sender is authorized to deposit
    fun is_authorized_depositor(_circle_id: ID, _sender: address): bool {
        // In a production implementation, this would check if sender is a member of the circle
        // For now, we'll just return true to simplify
        true
    }
    
    // ----------------------------------------------------------
    // Withdraw from custody wallet
    // ----------------------------------------------------------
    public fun withdraw(
        wallet: &mut CustodyWallet,
        amount: u64,
        ctx: &mut TxContext
    ): Coin<SUI> {
        let sender = tx_context::sender(ctx);
        let current_time = tx_context::epoch_timestamp_ms(ctx);
        
        // Only admin can withdraw
        assert!(sender == wallet.admin, ENotWalletOwner);
        
        // Wallet must be active
        assert!(wallet.is_active, EWalletNotActive);
        
        // Check if wallet is time-locked
        if (option::is_some(&wallet.locked_until)) {
            let lock_time = *option::borrow(&wallet.locked_until);
            assert!(current_time >= lock_time, EFundsTimeLocked);
        };
        
        // Check sufficient balance
        assert!(balance::value(&wallet.balance) >= amount, 12); // EInsufficientBalance
        
        // Check daily withdrawal limit
        let is_new_day = current_time > wallet.last_withdrawal_time + core::ms_per_day();
        
        if (is_new_day) {
            // Reset daily total if it's a new day
            wallet.daily_withdrawal_total = amount;
        } else {
            // Add to daily total and check limit
            let new_daily_total = wallet.daily_withdrawal_total + amount;
            assert!(new_daily_total <= wallet.daily_withdrawal_limit, EExceedsWithdrawalLimit);
            wallet.daily_withdrawal_total = new_daily_total;
        };
        
        // Update last withdrawal time
        wallet.last_withdrawal_time = current_time;
        
        // Process withdrawal
        let withdrawal_balance = balance::split(&mut wallet.balance, amount);
        let withdrawal_coin = coin::from_balance(withdrawal_balance, ctx);
        
        // Add transaction record to history
        let txn = create_transaction(
            core::custody_op_withdrawal(),
            sender,
            amount,
            current_time
        );
        vector::push_back(&mut wallet.transaction_history, txn);
        
        // Emit withdrawal event
        event::emit(CustodyWithdrawn {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            recipient: sender,
            amount,
            operation_type: core::custody_op_withdrawal(),
        });
        
        withdrawal_coin
    }
    
    // ----------------------------------------------------------
    // Lock custody wallet until a specific time
    // ----------------------------------------------------------
    public fun lock_wallet(
        wallet: &mut CustodyWallet,
        until_timestamp: u64,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can lock the wallet
        assert!(sender == wallet.admin, ENotWalletOwner);
        
        wallet.locked_until = option::some(until_timestamp);
    }
    
    // ----------------------------------------------------------
    // Unlock custody wallet
    // ----------------------------------------------------------
    public fun unlock_wallet(
        wallet: &mut CustodyWallet,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can unlock the wallet
        assert!(sender == wallet.admin, ENotWalletOwner);
        
        wallet.locked_until = option::none();
    }
    
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
    // Check if withdrawal amount is within limit
    // ----------------------------------------------------------
    public fun check_withdrawal_limit(wallet: &CustodyWallet, amount: u64): bool {
        // Use the last withdrawal time as a reference instead of trying to get current time
        // This is a workaround since tx_context::dummy() is not available
        let current_time = if (wallet.last_withdrawal_time == 0) {
            // If no withdrawals yet, use a default timestamp
            1000000000000 // Some arbitrary future timestamp
        } else {
            // Otherwise, use last withdrawal time as reference
            wallet.last_withdrawal_time
        };
        
        let is_new_day = current_time > wallet.last_withdrawal_time + core::ms_per_day();
        
        if (is_new_day) {
            amount <= wallet.daily_withdrawal_limit
        } else {
            wallet.daily_withdrawal_total + amount <= wallet.daily_withdrawal_limit
        }
    }
    
    // ----------------------------------------------------------
    // Get wallet admin
    // ----------------------------------------------------------
    public fun get_admin(wallet: &CustodyWallet): address {
        wallet.admin
    }
    
    // ----------------------------------------------------------
    // Stablecoin Storage Helpers Using Dynamic Fields
    // ----------------------------------------------------------
    
    // Generate a key for storing coin objects
    fun coin_field_name<CoinType>(): String {
        // For Sui explorer compatibility, use the standard field name
        string::utf8(b"coin_objects")
    }
    
    // Check if a stablecoin balance exists
    public fun has_stablecoin_balance<CoinType>(wallet: &CustodyWallet): bool {
        let field_name = coin_field_name<CoinType>();
        dynamic_object_field::exists_(&wallet.id, field_name)
    }
    
    // Get a stablecoin balance from stored coins
    public fun get_stablecoin_balance<CoinType>(wallet: &CustodyWallet): u64 {
        let field_name = coin_field_name<CoinType>();
        if (!dynamic_object_field::exists_(&wallet.id, field_name)) {
            return 0
        };
        
        let coin = dynamic_object_field::borrow<String, Coin<CoinType>>(&wallet.id, field_name);
        coin::value(coin)
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
    
    // Get decimals for a specific coin type
    public fun get_coin_decimals(wallet: &CustodyWallet, coin_symbol: String): u8 {
        let mut metadata_key = string::utf8(b"metadata_");
        string::append(&mut metadata_key, coin_symbol);
        
        if (dynamic_field::exists_(&wallet.id, metadata_key)) {
            let metadata = *dynamic_field::borrow<String, vector<String>>(&wallet.id, metadata_key);
            if (vector::length(&metadata) >= 2) {
                // Convert ASCII character back to number (e.g., '6' -> 6)
                let decimal_str = *vector::borrow(&metadata, 1);
                if (string::length(&decimal_str) > 0) {
                    let decimal_bytes = *string::bytes(&decimal_str);
                    let decimal_ascii = *vector::borrow(&decimal_bytes, 0);
                    return (decimal_ascii - 48) as u8 // ASCII to number conversion
                }
            }
        };
        
        // Default to 9 if not found (SUI standard)
        9
    }
    
    // Get full type path for a coin symbol
    public fun get_coin_type_path(wallet: &CustodyWallet, coin_symbol: String): String {
        let mut metadata_key = string::utf8(b"metadata_");
        string::append(&mut metadata_key, coin_symbol);
        
        if (dynamic_field::exists_(&wallet.id, metadata_key)) {
            let metadata = *dynamic_field::borrow<String, vector<String>>(&wallet.id, metadata_key);
            if (vector::length(&metadata) >= 3) {
                return *vector::borrow(&metadata, 2)
            }
        };
        
        // Return empty string if not found
        string::utf8(b"")
    }
    
    // ----------------------------------------------------------
    // Internal function to store a security deposit coin in the custody wallet
    // Verification and member state updates are handled in the calling module (njangi_circles)
    // ----------------------------------------------------------
    public(package) fun internal_store_security_deposit<CoinType>(
        wallet: &mut CustodyWallet,
        stablecoin: Coin<CoinType>,
        member_addr: address,
        required_amount: u64,
        price_info_object: &PriceInfoObject,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&stablecoin);
        let current_time = clock::timestamp_ms(clock);

        assert!(wallet.is_active, EWalletNotActive);

        // Get the coin type name
        let coin_type_name = type_name::into_string(type_name::get<CoinType>());
        
        // Validate the deposit using Pyth price oracle
        let usd_value = price_validator::validate_stablecoin_deposit(
            price_info_object,
            amount,
            required_amount,
            coin_type_name,
            clock,
            ctx
        );
        
        // Ensure the deposit meets the required amount
        assert!(usd_value >= required_amount, EInsufficientDepositValue);

        // Register the coin type if not already registered
        let previous_balance = get_stablecoin_balance<CoinType>(wallet);
        let coin_type_field = coin_field_name<CoinType>();

        if (dynamic_object_field::exists_(&wallet.id, coin_type_field)) {
            let mut existing_coin = dynamic_object_field::remove<String, Coin<CoinType>>(
                &mut wallet.id, 
                coin_type_field
            );
            coin::join(&mut existing_coin, stablecoin);
            dynamic_object_field::add(&mut wallet.id, coin_type_field, existing_coin);
        } else {
            dynamic_object_field::add(&mut wallet.id, coin_type_field, stablecoin);
            register_stablecoin_type<CoinType>(wallet);
        };

        let new_balance = get_stablecoin_balance<CoinType>(wallet);

        let txn = create_transaction(
            core::custody_op_stablecoin_deposit(),
            member_addr,
            amount,
            current_time
        );
        vector::push_back(&mut wallet.transaction_history, txn);

        // Determine the correct coin type string based on the type
        let coin_type_str = if (std::type_name::get<CoinType>() == std::type_name::get<SUI>()) {
            // If it's SUI, use "sui" instead of "stablecoin"
            string::utf8(b"sui")
        } else {
            // For other coins (actual stablecoins), use "stablecoin"
            string::utf8(b"stablecoin")
        };

        event::emit(CustodyDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            member: member_addr,
            amount,
            operation_type: core::custody_op_stablecoin_deposit(),
        });

        event::emit(CoinDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            coin_type: coin_type_str,
            amount,
            member: member_addr,
            previous_balance,
            new_balance,
            timestamp: current_time,
        });
        
        // Emit new event with price information
        event::emit(StablecoinDepositWithPrice {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            coin_type: coin_type_str,
            amount,
            usd_value,
            member: member_addr,
            timestamp: current_time,
        });
    }
    
    // ----------------------------------------------------------
    // Withdraw stablecoin from custody wallet
    // ----------------------------------------------------------
    public fun withdraw_stablecoin<CoinType>(
        wallet: &mut CustodyWallet,
        amount: u64,
        recipient: address,
        clock: &Clock,
        ctx: &mut TxContext
    ): Coin<CoinType> {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        
        // Only admin can withdraw stablecoins
        assert!(sender == wallet.admin, ENotWalletOwner);
        
        // Wallet must be active
        assert!(wallet.is_active, EWalletNotActive);
        
        // Check if wallet is time-locked
        if (option::is_some(&wallet.locked_until)) {
            let lock_time = *option::borrow(&wallet.locked_until);
            assert!(current_time >= lock_time, EFundsTimeLocked);
        };
        
        // Check if we have this stablecoin type and sufficient balance
        let field_name = coin_field_name<CoinType>();
        assert!(dynamic_object_field::exists_(&wallet.id, field_name), EUnsupportedToken);
        
        // Get previous balance for events
        let previous_balance = get_stablecoin_balance<CoinType>(wallet);
        assert!(previous_balance >= amount, 12); // EInsufficientBalance
        
        // Remove the coin, split it, and store back the remainder
        let mut stored_coin = dynamic_object_field::remove<String, Coin<CoinType>>(&mut wallet.id, field_name);
        let coin_to_send = coin::split<CoinType>(&mut stored_coin, amount, ctx);
        
        // If the remainder has value, store it back
        if (coin::value(&stored_coin) > 0) {
            dynamic_object_field::add(&mut wallet.id, field_name, stored_coin);
        } else {
            // If no remaining value, destroy the empty coin
            coin::destroy_zero(stored_coin);
        };
        
        // Get new balance for events
        let new_balance = get_stablecoin_balance<CoinType>(wallet);
        
        // Add transaction record to history
        let txn = create_transaction(
            core::custody_op_withdrawal(), 
            sender, 
            amount, 
            current_time
        );
        vector::push_back(&mut wallet.transaction_history, txn);
        
        // Emit updated balance event
        let coin_type_str = string::utf8(b"stablecoin");
        
        event::emit(StablecoinHoldingUpdated {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            coin_type: coin_type_str,
            previous_balance,
            new_balance,
            timestamp: current_time,
        });
        
        coin_to_send
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
    // Add a public function to validate deposit amounts using Pyth
    // ----------------------------------------------------------
    public fun validate_deposit_amount<CoinType>(
        amount: u64,
        required_amount: u64,
        price_info_object: &PriceInfoObject,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        let coin_type_name = type_name::into_string(type_name::get<CoinType>());
        
        price_validator::validate_stablecoin_deposit(
            price_info_object,
            amount,
            required_amount,
            coin_type_name,
            clock,
            ctx
        )
    }
    
    // ----------------------------------------------------------
    // Internal function to store a security deposit coin without price validation
    // For backward compatibility during transition to price validation
    // ----------------------------------------------------------
    public(package) fun internal_store_security_deposit_without_validation<CoinType>(
        wallet: &mut CustodyWallet,
        stablecoin: Coin<CoinType>,
        member_addr: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&stablecoin);
        let current_time = clock::timestamp_ms(clock);

        assert!(wallet.is_active, EWalletNotActive);

        // Register the coin type if not already registered
        let previous_balance = get_stablecoin_balance<CoinType>(wallet);
        let coin_type_field = coin_field_name<CoinType>();

        if (dynamic_object_field::exists_(&wallet.id, coin_type_field)) {
            let mut existing_coin = dynamic_object_field::remove<String, Coin<CoinType>>(
                &mut wallet.id,
                coin_type_field
            );
            coin::join(&mut existing_coin, stablecoin);
            dynamic_object_field::add(&mut wallet.id, coin_type_field, existing_coin);
        } else {
            dynamic_object_field::add(&mut wallet.id, coin_type_field, stablecoin);
            register_stablecoin_type<CoinType>(wallet);
        };

        let new_balance = get_stablecoin_balance<CoinType>(wallet);

        let txn = create_transaction(
            core::custody_op_stablecoin_deposit(),
            member_addr,
            amount,
            current_time
        );
        vector::push_back(&mut wallet.transaction_history, txn);

        // Determine the correct coin type string based on the type
        let coin_type_str = if (std::type_name::get<CoinType>() == std::type_name::get<SUI>()) {
            // If it's SUI, use "sui" instead of "stablecoin"
            string::utf8(b"sui")
        } else {
            // For other coins (actual stablecoins), use "stablecoin"
            string::utf8(b"stablecoin")
        };

        event::emit(CustodyDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            member: member_addr,
            amount,
            operation_type: core::custody_op_stablecoin_deposit(),
        });

        event::emit(CoinDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            coin_type: coin_type_str,
            amount,
            member: member_addr,
            previous_balance,
            new_balance,
            timestamp: current_time,
        });
    }
    
    // ----------------------------------------------------------
    // Internal function to deposit a contribution coin (generic type)
    // ----------------------------------------------------------
    public(package) fun deposit_contribution_coin<CoinType>(
        wallet: &mut CustodyWallet,
        contribution_coin: Coin<CoinType>,
        member_addr: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = coin::value(&contribution_coin);
        let current_time = clock::timestamp_ms(clock);

        assert!(wallet.is_active, EWalletNotActive);

        // Register the coin type if not already registered
        let previous_balance = get_stablecoin_balance<CoinType>(wallet);
        let coin_type_field = coin_field_name<CoinType>();

        if (dynamic_object_field::exists_(&wallet.id, coin_type_field)) {
            let mut existing_coin = dynamic_object_field::remove<String, Coin<CoinType>>(
                &mut wallet.id,
                coin_type_field
            );
            coin::join(&mut existing_coin, contribution_coin);
            dynamic_object_field::add(&mut wallet.id, coin_type_field, existing_coin);
        } else {
            dynamic_object_field::add(&mut wallet.id, coin_type_field, contribution_coin);
            register_stablecoin_type<CoinType>(wallet);
        };

        let new_balance = get_stablecoin_balance<CoinType>(wallet);

        // Use CUSTODY_OP_DEPOSIT for generic contributions
        let txn = create_transaction(
            core::custody_op_deposit(),
            member_addr,
            amount,
            current_time
        );
        vector::push_back(&mut wallet.transaction_history, txn);

        // Determine the correct coin type string based on the type
        let coin_type_str = if (std::type_name::get<CoinType>() == std::type_name::get<SUI>()) {
            string::utf8(b"sui")
        } else {
            // Use a generic term or maybe the actual type name? Let's stick to stablecoin for now.
            string::utf8(b"stablecoin")
        };

        // Emit CoinDeposited event - CustodyDeposited might be misleading here
        event::emit(CoinDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            coin_type: coin_type_str,
            amount,
            member: member_addr,
            previous_balance,
            new_balance,
            timestamp: current_time,
        });
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
        
        // Check for any coin_objects field that might contain a stablecoin
        let coin_objects_key = string::utf8(b"coin_objects");
        
        // If the dynamic field exists, we need to check if the balance is non-zero
        if (dynamic_object_field::exists_(&wallet.id, coin_objects_key)) {
            // We need to check if the actual coin has a non-zero balance
            // This is a simplified check - in a real implementation, we would
            // need to check each specific coin type's balance
            
            // Unfortunately, we cannot enumerate the specific coin types here,
            // but if the dynamic field exists and contains a non-empty SUI coin,
            // get_stablecoin_balance<SUI> will return a non-zero value
            if (get_stablecoin_balance<SUI>(wallet) > 0) {
                return true
            }
        };
        
        false
    }
} 