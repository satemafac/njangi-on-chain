module njangi::njangi_circles {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::sui::SUI;
    use sui::dynamic_field;
    use std::string::{Self, String};
    use std::vector;
    use std::option::{Self, Option};
    use std::type_name;
    use std::ascii;
    use std::debug;
    
    use njangi::njangi_core::{Self as core};
    use njangi::njangi_members::{Self as members, Member};
    use njangi::njangi_custody::{Self as custody, CustodyWallet, CoinDeposited, CustodyDeposited};
    use njangi::njangi_circle_config::{Self as config};
    use njangi::njangi_milestones::{Self as milestones, MilestoneData};
    
    use pyth::price_info::PriceInfoObject;
    use njangi::njangi_price_validator as price_validator;
    
    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    const ECircleFull: u64 = 5;
    const EInsufficientDeposit: u64 = 6;
    const ENotAdmin: u64 = 7;
    const EWalletCircleMismatch: u64 = 46;
    const ECircleNotActive: u64 = 54;
    const ECircleIsActive: u64 = 55;
    const EInvalidMaxMembersLimit: u64 = 56;
    // Define constants locally based on values from other modules
    const EInvalidContributionAmount: u64 = 1; // From core
    const ENotMember: u64 = 8;                 // From core
    const EMemberNotActive: u64 = 14;          // From members
    const EMemberSuspended: u64 = 13;          // From members
    const EDepositAlreadyPaid: u64 = 21;       // From members
    const EIncorrectDepositAmount: u64 = 2;    // From core
    
    // Time constants (in milliseconds)
    const THIRTY_DAYS_MS: u64 = 2_592_000_000; // 30 days in milliseconds
    const SEVEN_DAYS_MS: u64 = 604_800_000;    // 7 days in milliseconds
    
    // ----------------------------------------------------------
    // Main Circle struct
    // ----------------------------------------------------------
    public struct Circle has key, store {
        id: UID,
        name: String,
        admin: address,
        current_members: u64,
        members: Table<address, Member>,
        contributions: Balance<SUI>,
        deposits: Balance<SUI>,
        penalties: Balance<SUI>,
        current_cycle: u64,
        next_payout_time: u64,
        created_at: u64,
        rotation_order: vector<address>,
        rotation_history: vector<address>,
        current_position: u64,
        active_auction: Option<Auction>,
        is_active: bool,
        contributions_this_cycle: u64, // Track total contributions for the current cycle
    }
    
    // ----------------------------------------------------------
    // Support structs for Circle
    // ----------------------------------------------------------
    public struct Auction has store, drop {
        position: u64,
        minimum_bid: u64,
        highest_bid: u64,
        highest_bidder: Option<address>,
        start_time: u64,
        end_time: u64,
        discount_rate: u64,
    }

    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    public struct CircleCreated has copy, drop {
        circle_id: ID,
        admin: address,
        name: String,
        contribution_amount: u64,
        contribution_amount_usd: u64, // USD amount in cents
        security_deposit_usd: u64,    // USD amount in cents
        max_members: u64,
        cycle_length: u64,
    }
    
    public struct CircleActivated has copy, drop {
        circle_id: ID,
        activated_by: address,
    }
    
    public struct CircleDeleted has copy, drop {
        circle_id: ID,
        admin: address,
        name: String,
    }
    
    public struct TreasuryUpdated has copy, drop {
        circle_id: ID,
        contributions_balance: u64,
        deposits_balance: u64,
        penalties_balance: u64,
        cycle: u64,
    }
    
    public struct AutoSwapToggled has copy, drop {
        circle_id: ID,
        enabled: bool,
        toggled_by: address,
    }
    
    // Add the MemberJoined event that we need
    public struct MemberJoined has copy, drop {
        circle_id: ID,
        member: address,
        position: Option<u64>,
    }

    // Add these events near other event definitions around line 140
    public struct MemberActivated has copy, drop {
        circle_id: ID,
        member: address,
        deposit_amount: u64,
    }

    // Event struct defined within this module
    /// Event emitted when a stablecoin contribution is made to a circle
    /// * `circle_id` - ID of the circle receiving the contribution
    /// * `member` - Address of the contributing member
    /// * `amount` - Contribution amount in stablecoin micro-units (varies by coin type)
    /// * `cycle` - Current cycle number of the circle
    /// * `coin_type` - Type of the stablecoin used for contribution
    public struct StablecoinContributionMade has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64, // Amount in stablecoin micro-units
        cycle: u64,
        coin_type: String, // Added coin type
    }

    public struct CircleMaxMembersUpdated has copy, drop {
        circle_id: ID,
        admin: address,
        old_max_members: u64,
        new_max_members: u64,
    }

    // ----------------------------------------------------------
    // Create Circle
    // ----------------------------------------------------------
    public fun create_circle(
        name: vector<u8>,
        contribution_amount: u64,
        contribution_amount_usd: u64, // USD amount in cents
        security_deposit: u64,
        security_deposit_usd: u64,    // USD amount in cents
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        max_members: u64,
        rotation_style: u8,
        penalty_rules: vector<bool>,
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_usd: Option<u64>, // USD amount in cents
        target_date: Option<u64>,
        verification_required: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // The frontend now sends properly formatted values with 9 decimals
        // No need for additional scaling, values are already in MIST format
        let contribution_amount_scaled = contribution_amount;
        let security_deposit_scaled = security_deposit;
        let target_amount_scaled = if (option::is_some(&target_amount)) {
            // Still need to extract the value from the option but no need to scale
            let amt_ref = option::borrow(&target_amount);
            option::some(*amt_ref)
        } else {
            option::none()
        };

        // Basic validations
        assert!(max_members >= core::get_min_members() && max_members <= core::get_max_members(), 0);
        assert!(contribution_amount_scaled > 0, 1);
        assert!(security_deposit_scaled >= core::min_security_deposit(contribution_amount_scaled), 2);
        assert!(cycle_length <= 3, 3); // Allow up to 3 (bi-weekly)
        assert!(
            (cycle_length == 0 && cycle_day < 7)   // weekly (weekday 0-6)
            || (cycle_length == 3 && cycle_day < 7)   // bi-weekly (weekday 0-6)
            || ((cycle_length == 1 || cycle_length == 2) && cycle_day > 0 && cycle_day <= 28), // monthly/quarterly (day 1-28)
            4 // EInvalidCycleDay
        );

        // Get admin address
        let admin = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Create the circle with minimal fields
        let mut circle = Circle {
            id: object::new(ctx),
            name: string::utf8(name),
            admin,
            current_members: 0,
            members: table::new(ctx),
            contributions: balance::zero<SUI>(),
            deposits: balance::zero<SUI>(),
            penalties: balance::zero<SUI>(),
            current_cycle: 0,
            next_payout_time: core::calculate_next_payout_time(cycle_length, cycle_day, clock::timestamp_ms(clock)),
            created_at: current_time,
            rotation_order: vector::empty(),
            rotation_history: vector::empty(),
            current_position: 0,
            active_auction: option::none(),
            is_active: false,
            contributions_this_cycle: 0, // Initialize to 0
        };
        
        // Create and attach configurations using the new module
        let circle_config = config::create_circle_config(
            contribution_amount_scaled,
            security_deposit_scaled,
            contribution_amount_usd,
            security_deposit_usd,
            cycle_length,
            cycle_day,
            circle_type,
            rotation_style,
            max_members,
            false // auto_swap_enabled starts as false
        );
        
        let milestone_config = config::create_milestone_config(
            goal_type,
            target_amount_scaled,
            target_amount_usd,
            target_date,
            verification_required
        );
        
        let penalty_config = config::create_penalty_rules(penalty_rules);
        
        // Attach configurations as dynamic fields
        config::attach_circle_config(&mut circle.id, circle_config);
        config::attach_milestone_config(&mut circle.id, milestone_config);
        config::attach_penalty_rules(&mut circle.id, penalty_config);
        
        // Create the circle's custody wallet
        let circle_id = object::uid_to_inner(&circle.id);
        custody::create_custody_wallet(circle_id, current_time, ctx);
        
        // Wait for the CustodyWalletCreated event to occur
        // In a real application, we would query for the wallet ID here
        // Since we can't, the frontend will need to use events to get the wallet ID
        
        // We'll create a dynamic field with a known key to access the wallet ID later
        // This field will be populated by wallet_id_updater or other modules
        dynamic_field::add(&mut circle.id, string::utf8(b"wallet_id"), circle_id);

        // Automatically add the admin as a member
        let admin_member = members::create_member(
            current_time,           // joined_at 
            option::some(0),        // payout_position - put admin in position 0
            0,                      // deposit_balance
            core::member_status_active() // status - use core definition consistently
        );
        
        // Add the admin to the circle members
        add_member(&mut circle, admin, admin_member);
        
        // Also add admin to rotation_order in position 0
        vector::push_back(&mut circle.rotation_order, admin);

        event::emit(CircleCreated {
            circle_id: object::uid_to_inner(&circle.id),
            admin,
            name: string::utf8(name),
            contribution_amount: contribution_amount_scaled,
            contribution_amount_usd,
            security_deposit_usd,
            max_members,
            cycle_length,
        });
        
        // Emit MemberJoined event for admin
        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: admin,
            position: option::some(0),
        });

        // Make the newly created `Circle` object shared
        transfer::share_object(circle);
    }
    
    // ----------------------------------------------------------
    // Admin activates the circle, requiring all members to have deposits
    // ----------------------------------------------------------
    public fun activate_circle(
        circle: &mut Circle,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can activate the circle
        assert!(sender == circle.admin, 7);
        
        // Get max members from config
        let max_members = config::get_max_members(&circle.id);
        
        // Circle must have at least 3 members (minimum required)
        assert!(circle.current_members >= 3, 22);
        
        // Get security deposit amount from config
        let security_deposit = config::get_security_deposit(&circle.id);
        
        // Check if admin has paid deposit
        if (table::contains(&circle.members, circle.admin)) {
            let admin_member = table::borrow(&circle.members, circle.admin);
            // Check the deposit_paid flag instead of balance
            assert!(members::has_paid_deposit(admin_member), 21);
        };
        
        // --- Check all other members directly using rotation_order --- 
        let rotation = &circle.rotation_order;
        let len = vector::length(rotation);
        let mut i = 0;
        while (i < len) {
            let member_addr = *vector::borrow(rotation, i);
            
            // Skip the admin (already checked) and placeholder addresses
            if (member_addr != circle.admin && member_addr != @0x0) {
                // Ensure member exists in the table (should always be true if rotation_order is correct)
                assert!(table::contains(&circle.members, member_addr), 8); 
                
                let member = table::borrow(&circle.members, member_addr);
                // Assert that the member has paid the required security deposit using the flag
                assert!(members::has_paid_deposit(member), 21);
            };
            i = i + 1;
        };
        // --- End of deposit check --- 
        
        // Set the circle to active
        circle.is_active = true;
        
        // Get cycle length and day from config
        let cycle_length = config::get_cycle_length(&circle.id);
        let cycle_day = config::get_cycle_day(&circle.id);
        
        // Recalculate next payout time now that circle is active
        circle.next_payout_time = core::calculate_next_payout_time(
            cycle_length, 
            cycle_day, 
            tx_context::epoch_timestamp_ms(ctx)
        );
        
        // Start cycle
        circle.current_cycle = 1;
        
        event::emit(CircleActivated {
            circle_id: object::uid_to_inner(&circle.id),
            activated_by: sender,
        });
    }
    
    // ----------------------------------------------------------
    // Toggle auto-swap enabled status (admin only)
    // ----------------------------------------------------------
    public fun toggle_auto_swap(
        circle: &mut Circle,
        enabled: bool,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can toggle auto-swap
        assert!(sender == circle.admin, 7);
        
        // Update config using the config module
        config::toggle_auto_swap(&mut circle.id, enabled);
        
        // Emit an event so frontend can track changes
        event::emit(AutoSwapToggled {
            circle_id: object::uid_to_inner(&circle.id),
            enabled,
            toggled_by: sender,
        });
    }
    
    // ----------------------------------------------------------
    // Treasury (payout scheduling, tracking balances)
    // ----------------------------------------------------------
    public fun manage_treasury_balances(
        circle: &mut Circle,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Circle must be active to manage treasury
        assert!(circle.is_active, ECircleNotActive);
        
        let contributions = balance::value(&circle.contributions);
        let deposits = balance::value(&circle.deposits);
        let penalties = balance::value(&circle.penalties);
        
        event::emit(TreasuryUpdated {
            circle_id: object::uid_to_inner(&circle.id),
            contributions_balance: contributions,
            deposits_balance: deposits,
            penalties_balance: penalties,
            cycle: circle.current_cycle,
        });
    }
    
    // ----------------------------------------------------------
    // Admin function: update cycle if we passed payout time
    // ----------------------------------------------------------
    public fun update_cycle(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Circle must be active to update cycle
        assert!(circle.is_active, ECircleNotActive);
        
        let current_time = clock::timestamp_ms(clock);
        if (current_time >= circle.next_payout_time) {
            circle.current_cycle = circle.current_cycle + 1;
            circle.next_payout_time = core::calculate_next_payout_time(
                config::get_cycle_length(&circle.id),
                config::get_cycle_day(&circle.id),
                current_time
            );
        };
    }
    
    // ----------------------------------------------------------
    // Check if circle is active
    // ----------------------------------------------------------
    public fun is_circle_active(circle: &Circle): bool {
        circle.is_active
    }
    
    // ----------------------------------------------------------
    // Check if a circle is eligible for deletion by admin
    // ----------------------------------------------------------
    public fun can_delete_circle(circle: &Circle, wallet: &CustodyWallet, admin_addr: address): bool {
        // Only admin can delete
        if (circle.admin != admin_addr) {
            return false
        };
        
        // Must have 0 or 1 members (only admin)
        if (circle.current_members > 1) {
            return false
        };
        
        // No contributions allowed
        if (balance::value(&circle.contributions) > 0) {
            return false
        };

        // No deposits allowed (security deposits should be returned to members first)
        if (balance::value(&circle.deposits) > 0) {
            return false
        };
        
        // Ensure the wallet belongs to this circle
        if (custody::get_circle_id(wallet) != object::uid_to_inner(&circle.id)) {
            return false
        };
        
        // Ensure the custody wallet has no SUI balance
        if (custody::get_wallet_balance(wallet) > 0) {
            return false
        };
        
        // Check for any stablecoin balances in the wallet
        if (custody::has_any_stablecoin_balance(wallet)) {
            return false
        };
        
        true
    }
    
    // ----------------------------------------------------------
    // Delete Circle
    // ----------------------------------------------------------
    public entry fun delete_circle(
        mut circle: Circle,
        wallet: &CustodyWallet,
        ctx: &mut TxContext
    ) {
        // Only admin can delete the circle
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Ensure there are no members other than the admin (current_members starts from 0)
        assert!(circle.current_members <= 1, ECircleFull);
        
        // Ensure no money has been contributed
        assert!(balance::value(&circle.contributions) == 0, ECircleFull);

        // Ensure no security deposits remain in the circle
        assert!(balance::value(&circle.deposits) == 0, ECircleFull);
        
        // Ensure the wallet belongs to this circle - check by ID value, not dynamic field relation
        // This is to avoid the dynamic_field::borrow_child_object error
        assert!(custody::get_circle_id(wallet) == object::uid_to_inner(&circle.id), EWalletCircleMismatch);
        
        // Ensure the custody wallet has no SUI balance
        assert!(custody::get_wallet_balance(wallet) == 0, EInsufficientDeposit);
        
        // Check for any stablecoin balances in the wallet
        assert!(!custody::has_any_stablecoin_balance(wallet), EInsufficientDeposit);
        
        // Get the wallet_id link in the circle dynamic fields - we'll clean this up
        let wallet_id_key = string::utf8(b"wallet_id");
        if (dynamic_field::exists_(&circle.id, wallet_id_key)) {
            // If the wallet ID field exists, remove it to clean up
            let _: ID = dynamic_field::remove(&mut circle.id, wallet_id_key);
        };
        
        // Return any deposits to the admin if they joined as a member
        if (circle.current_members == 1 && table::contains(&circle.members, circle.admin)) {
            let deposit_balance = balance::value(&circle.deposits);
            if (deposit_balance > 0) {
                let deposit_coin = coin::from_balance(
                    balance::withdraw_all(&mut circle.deposits),
                    ctx
                );
                transfer::public_transfer(deposit_coin, circle.admin);
            };
        };
        
        // Get circle ID for milestone cleanup
        let circle_id = object::uid_to_inner(&circle.id);
        
        // Delete milestone data (will be implemented in njangi_milestones)
        // njangi::njangi_milestones::delete_milestone_data(circle_id, ctx);
        
        // Emit event for circle deletion
        event::emit(CircleDeleted {
            circle_id,
            admin: circle.admin,
            name: circle.name,
        });
        
        // In Sui, we can directly delete a shared object if we have it by value
        // First, extract and destroy all balances if any remain
        let Circle { 
            id,
            name: _,
            admin: _,
            current_members: _,
            members,
            contributions,
            deposits,
            penalties,
            current_cycle: _,
            next_payout_time: _,
            rotation_order: _,
            rotation_history: _,
            current_position: _,
            active_auction: _,
            created_at: _,
            is_active: _,
            contributions_this_cycle: _,
        } = circle;
        
        // Destroy balances and tables
        balance::destroy_zero(contributions);
        balance::destroy_zero(deposits);
        balance::destroy_zero(penalties);
        table::drop(members);
        
        // Delete the object
        object::delete(id);
    }
    
    // ----------------------------------------------------------
    // Rotation management
    // ----------------------------------------------------------
    public fun set_rotation_position(
        circle: &mut Circle,
        member_addr: address,
        position: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        assert!(position < config::get_max_members(&circle.id), 29);
        assert!(table::contains(&circle.members, member_addr), 8);
        
        let current_size = vector::length(&circle.rotation_order);
        if (position >= current_size) {
            // fill gap with 0x0 addresses
            while (vector::length(&circle.rotation_order) < position) {
                vector::push_back(&mut circle.rotation_order, @0x0);
            };
            vector::push_back(&mut circle.rotation_order, member_addr);
        } else {
            // Must be empty OR already contain the same address
            assert!(
                vector::borrow(&circle.rotation_order, position) == &(@0x0) ||
                vector::borrow(&circle.rotation_order, position) == &member_addr, 
                30
            );
            *vector::borrow_mut(&mut circle.rotation_order, position) = member_addr;
        };
        
        let member = table::borrow_mut(&mut circle.members, member_addr);
        members::set_payout_position(member, option::some(position));
    }
    
    // ----------------------------------------------------------
    // Replace the entire rotation order at once
    // ----------------------------------------------------------
    public fun reorder_rotation_positions(
        circle: &mut Circle,
        new_order: vector<address>,
        ctx: &mut TxContext
    ) {
        // Only admin can reorder positions
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Order can't be larger than max members
        let order_length = vector::length(&new_order);
        assert!(order_length <= config::get_max_members(&circle.id), 29);
        
        // Verify all addresses in the new order are circle members
        let mut i = 0;
        while (i < order_length) {
            let member_addr = *vector::borrow(&new_order, i);
            assert!(table::contains(&circle.members, member_addr), 8);
            i = i + 1;
        };
        
        // Replace the rotation order completely
        circle.rotation_order = new_order;
        
        // Update each member's payout position
        let mut i = 0;
        while (i < order_length) {
            let member_addr = *vector::borrow(&circle.rotation_order, i);
            let member = table::borrow_mut(&mut circle.members, member_addr);
            members::set_payout_position(member, option::some(i));
            i = i + 1;
        };
    }
    
    // ----------------------------------------------------------
    // Replace the entire rotation order at once (entry function for frontend)
    // ----------------------------------------------------------
    public entry fun reorder_rotation_positions_entry(
        circle: &mut Circle,
        new_order: vector<address>,
        ctx: &mut TxContext
    ) {
        reorder_rotation_positions(circle, new_order, ctx);
    }
    
    // ----------------------------------------------------------
    // Treasury balance getters (human-friendly)
    // ----------------------------------------------------------
    public fun get_treasury_balances(circle: &Circle): (u64, u64, u64) {
        (
            core::from_decimals(balance::value(&circle.contributions)),
            core::from_decimals(balance::value(&circle.deposits)),
            core::from_decimals(balance::value(&circle.penalties))
        )
    }
    
    // ----------------------------------------------------------
    // Getters for UI display
    // ----------------------------------------------------------
    public fun get_contribution_amount(circle: &Circle): u64 {
        core::from_decimals(config::get_contribution_amount(&circle.id))
    }

    // Get the raw contribution amount (with 9 decimals) directly from config
    public fun get_contribution_amount_raw(circle: &Circle): u64 {
        config::get_contribution_amount(&circle.id)
    }

    public fun get_security_deposit(circle: &Circle): u64 {
        core::from_decimals(config::get_security_deposit(&circle.id))
    }

    public fun get_target_amount(circle: &Circle): Option<u64> {
        let target_opt = config::get_target_amount(&circle.id);
        if (option::is_some(&target_opt)) {
            let amt = *option::borrow(&target_opt);
            option::some(core::from_decimals(amt))
        } else {
            option::none()
        }
    }

    // USD value getters (in cents)
    public fun get_contribution_amount_usd(circle: &Circle): u64 {
        config::get_contribution_amount_usd(&circle.id)
    }

    public fun get_security_deposit_usd(circle: &Circle): u64 {
        config::get_security_deposit_usd(&circle.id)
    }

    public fun get_target_amount_usd(circle: &Circle): Option<u64> {
        config::get_target_amount_usd(&circle.id)
    }
    
    // ----------------------------------------------------------
    // Add to members table - shared helper to avoid table access error
    // ----------------------------------------------------------
    public(package) fun add_member(
        circle: &mut Circle, 
        addr: address, 
        member: Member
    ) {
        table::add(&mut circle.members, addr, member);
        circle.current_members = circle.current_members + 1;
    }
    
    // ----------------------------------------------------------
    // Get the members table - accessor for other modules
    // ----------------------------------------------------------
    public(package) fun get_members_table(circle: &Circle): &Table<address, Member> {
        &circle.members
    }
    
    public(package) fun get_members_table_mut(circle: &mut Circle): &mut Table<address, Member> {
        &mut circle.members
    }
    
    // ----------------------------------------------------------
    // Get member - accessor for other modules
    // ----------------------------------------------------------
    public fun get_member(circle: &Circle, addr: address): &Member {
        table::borrow(&circle.members, addr)
    }
    
    // ----------------------------------------------------------
    // Get mutable member - accessor for other modules
    // ----------------------------------------------------------
    public(package) fun get_member_mut(circle: &mut Circle, addr: address): &mut Member {
        table::borrow_mut(&mut circle.members, addr)
    }
    
    // ----------------------------------------------------------
    // Check if address is a member
    // ----------------------------------------------------------
    public fun is_member(circle: &Circle, addr: address): bool {
        table::contains(&circle.members, addr)
    }
    
    // ----------------------------------------------------------
    // Get circle admin
    // ----------------------------------------------------------
    public fun get_admin(circle: &Circle): address {
        circle.admin
    }
    
    // ----------------------------------------------------------
    // Get the circle ID
    // ----------------------------------------------------------
    public fun get_id(circle: &Circle): ID {
        object::uid_to_inner(&circle.id)
    }
    
    // ----------------------------------------------------------
    // Join penalty amount to penalties Balance
    // ----------------------------------------------------------
    public(package) fun add_to_penalties(circle: &mut Circle, amount: Balance<SUI>) {
        balance::join(&mut circle.penalties, amount);
    }
    
    // ----------------------------------------------------------
    // Join deposit amount to deposits Balance
    // ----------------------------------------------------------
    public(package) fun add_to_deposits(circle: &mut Circle, amount: Balance<SUI>) {
        balance::join(&mut circle.deposits, amount);
    }
    
    // ----------------------------------------------------------
    // Join contribution amount to contributions Balance
    // ----------------------------------------------------------
    public(package) fun add_to_contributions(circle: &mut Circle, amount: Balance<SUI>) {
        balance::join(&mut circle.contributions, amount);
    }
    
    // ----------------------------------------------------------
    // Split from deposits Balance
    // ----------------------------------------------------------
    public(package) fun split_from_deposits(circle: &mut Circle, amount: u64): Balance<SUI> {
        balance::split(&mut circle.deposits, amount)
    }
    
    // ----------------------------------------------------------
    // Split from contributions Balance
    // ----------------------------------------------------------
    public(package) fun split_from_contributions(circle: &mut Circle, amount: u64): Balance<SUI> {
        balance::split(&mut circle.contributions, amount)
    }
    
    // ----------------------------------------------------------
    // Get circle name
    // ----------------------------------------------------------
    public fun get_name(circle: &Circle): String {
        circle.name
    }
    
    // ----------------------------------------------------------
    // Get auto swap status
    // ----------------------------------------------------------
    public fun is_auto_swap_enabled(circle: &Circle): bool {
        config::is_auto_swap_enabled(&circle.id)
    }
    
    // ----------------------------------------------------------
    // Get next payout time
    // ----------------------------------------------------------
    public fun get_next_payout_time(circle: &Circle): u64 {
        circle.next_payout_time
    }
    
    // ----------------------------------------------------------
    // Get next payout info in a more readable manner
    // ----------------------------------------------------------
    public fun get_next_payout_info(circle: &Circle): (u64, u64, u64) {
        let timestamp = circle.next_payout_time;
        let weekday = core::get_weekday(timestamp);
        let day =
            if (config::get_cycle_length(&circle.id) == 0) {
                weekday
            } else if (config::get_cycle_length(&circle.id) == 1) {
                core::get_day_of_month(timestamp)
            } else {
                core::get_day_of_quarter(timestamp)
            };
        
        (timestamp, weekday, day)
    }
    
    // ----------------------------------------------------------
    // Get all members in a circle - for frontend access
    // ----------------------------------------------------------
    public fun get_circle_members(circle: &Circle): vector<address> {
        let mut members = vector::empty<address>();
        
        // First, add admin if they are a member
        if (table::contains(&circle.members, circle.admin)) {
            vector::push_back(&mut members, circle.admin);
        };
        
        // Add members from rotation order (if any)
        let rotation_members = circle.rotation_order;
        let mut i = 0;
        let len = vector::length(&rotation_members);
        
        while (i < len) {
            let addr = *vector::borrow(&rotation_members, i);
            // Only add non-zero addresses and avoid duplicates
            if (addr != @0x0 && !vector::contains(&members, &addr)) {
                vector::push_back(&mut members, addr);
            };
            i = i + 1;
        };
        
        // Try with some sample addresses as fallback
        let sample_addrs = core::get_sample_addresses();
        i = 0;
        let sample_len = vector::length(&sample_addrs);
        
        while (i < sample_len) {
            let addr = *vector::borrow(&sample_addrs, i);
            if (table::contains(&circle.members, addr) && !vector::contains(&members, &addr)) {
                vector::push_back(&mut members, addr);
            };
            i = i + 1;
        };
        
        members
    }
    
    // ----------------------------------------------------------
    // Get rotation order
    // ----------------------------------------------------------
    public fun get_rotation_order(circle: &Circle): vector<address> {
        circle.rotation_order
    }
    
    // ----------------------------------------------------------
    // Get current cycle
    // ----------------------------------------------------------
    public fun get_current_cycle(circle: &Circle): u64 {
        circle.current_cycle
    }
    
    // ----------------------------------------------------------
    // Get warning penalty amount
    // ----------------------------------------------------------
    public fun get_warning_penalty_amount(circle: &Circle): u64 {
        core::from_decimals(config::get_warning_penalty_amount(&circle.id))
    }

    // Add functions for auction management
    public fun has_active_auction(circle: &Circle): bool {
        option::is_some(&circle.active_auction)
    }

    public fun start_auction(
        circle: &mut Circle,
        position: u64,
        minimum_bid: u64,
        duration_days: u64,
        discount_rate: u64,
        start_time: u64
    ) {
        let end_time = start_time + (duration_days * core::ms_per_day());
        
        circle.active_auction = option::some(Auction {
            position,
            minimum_bid: core::to_decimals(minimum_bid),
            highest_bid: 0,
            highest_bidder: option::none(),
            start_time,
            end_time,
            discount_rate,
        });
    }

    public fun get_auction_info(circle: &Circle): (u64, u64, Option<address>, u64) {
        assert!(option::is_some(&circle.active_auction), 27); // EAuctionNotActive
        
        let auction = option::borrow(&circle.active_auction);
        (
            auction.position,
            auction.highest_bid,
            auction.highest_bidder,
            auction.end_time
        )
    }

    public fun update_auction_bid(circle: &mut Circle, bid_amount: u64, bidder: address) {
        assert!(option::is_some(&circle.active_auction), 27); // EAuctionNotActive
        
        let auction = option::borrow_mut(&mut circle.active_auction);
        auction.highest_bid = bid_amount;
        auction.highest_bidder = option::some(bidder);
    }

    public fun end_auction(circle: &mut Circle) {
        circle.active_auction = option::none();
    }

    // Add functions for milestone management
    public fun has_goal_type(circle: &Circle): bool {
        let goal_type_opt = config::get_goal_type(&circle.id);
        option::is_some(&goal_type_opt)
    }

    public fun get_goal_type(circle: &Circle): u8 {
        let goal_type_opt = config::get_goal_type(&circle.id);
        if (option::is_some(&goal_type_opt)) {
            *option::borrow(&goal_type_opt)
        } else {
            0 // Default to standard rotational type
        }
    }

    public fun get_member_count(circle: &Circle): u64 {
        circle.current_members
    }

    // ----------------------------------------------------------
    // Member exit
    // ----------------------------------------------------------
    public fun process_member_exit(
        circle: &mut Circle,
        member_addr: address,
        ctx: &mut TxContext
    ): bool {
        // Only admin can process member exits
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Check if member exists and is active
        assert!(is_member(circle, member_addr), 8);
        
        // In Move, we need to calculate the result differently
        if (table::contains(&circle.members, member_addr)) {
            let member = table::borrow_mut(&mut circle.members, member_addr);
            members::process_member_exit(member, config::get_contribution_amount(&circle.id))
        } else {
            false
        }
    }

    // ----------------------------------------------------------
    // Admin approve member to join circle - entry function for frontend use
    // ----------------------------------------------------------
    public entry fun admin_approve_member(
        circle: &mut Circle,
        member_addr: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Ensure that only the admin can approve members
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, 7);
        
        // Ensure the member isn't already part of the circle
        assert!(!is_member(circle, member_addr), ECircleFull);
        
        // Ensure the circle isn't at max capacity
        assert!(circle.current_members < config::get_max_members(&circle.id), 29);
        
        // Create a new Member object
        let current_time = clock::timestamp_ms(clock);
        let member = members::create_member(
            current_time,           // joined_at 
            option::none(),         // payout_position
            0,                      // deposit_balance
            core::member_status_active() // status - use core definition consistently
        );
        
        // Add the member to the circle
        add_member(circle, member_addr, member);
        
        // Emit MemberJoined event so the dashboard can detect this user's membership
        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            position: option::none(),
        });
    }
    
    // ----------------------------------------------------------
    // Admin approve multiple members to join circle at once - entry function for frontend
    // ----------------------------------------------------------
    public entry fun admin_approve_members(
        circle: &mut Circle,
        member_addrs: vector<address>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Ensure that only the admin can approve members
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, 7);
        
        // Get current time once for all members
        let current_time = clock::timestamp_ms(clock);
        
        // Track how many members we're adding
        let members_to_add = vector::length(&member_addrs);
        
        // Ensure the circle won't exceed max capacity
        assert!(circle.current_members + members_to_add <= config::get_max_members(&circle.id), 29);
        
        // Process each member address
        let mut i = 0;
        while (i < members_to_add) {
            let member_addr = *vector::borrow(&member_addrs, i);
            
            // Ensure the member isn't already part of the circle
            if (!is_member(circle, member_addr)) {
                // Create a new Member object
                let member = members::create_member(
                    current_time,           // joined_at 
                    option::none(),         // payout_position
                    0,                      // deposit_balance
                    core::member_status_active() // status - use core definition consistently
                );
                
                // Add the member to the circle
                add_member(circle, member_addr, member);
                
                // Emit MemberJoined event
                event::emit(MemberJoined {
                    circle_id: object::uid_to_inner(&circle.id),
                    member: member_addr,
                    position: option::none(),
                });
            };
            
            i = i + 1;
        };
    }

    // ----------------------------------------------------------
    // Get security deposit amount
    // ----------------------------------------------------------
    public fun get_security_deposit_amount(circle: &Circle): u64 {
        config::get_security_deposit(&circle.id)
    }

    // ----------------------------------------------------------
    // Member Entry function to deposit security deposit
    // Performs checks and updates Member state, then calls custody to store the coin.
    // ----------------------------------------------------------
    public entry fun member_deposit_security_deposit<CoinType>(
        circle: &mut Circle,
        wallet: &mut custody::CustodyWallet,
        deposit_coin: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&deposit_coin);

        // Read immutable values before getting mutable member reference
        let circle_id = get_id(circle);
        // Store admin address before mutable borrow
        let admin = circle.admin;
        
        // Get security deposit requirement for both SUI and USD
        let required_sui_amount = config::get_security_deposit(&circle.id);
        let required_usd_cents = config::get_security_deposit_usd(&circle.id);

        // --- Verification Steps (Now done in circles module) --- 
        // Verify wallet belongs to this circle
        assert!(custody::get_circle_id(wallet) == circle_id, EWalletCircleMismatch); 

        // Verify caller is a member
        assert!(is_member(circle, sender), 8); // Use existing error code for MemberNotFound

        // Get member data mutably to update deposit status
        let member = get_member_mut(circle, sender);

        // Verify member is active - use core constants only
        let member_status = members::get_status(member);
        assert!(
            member_status == core::member_status_active() ||
            sender == admin, // Special case: admin can always deposit
            14
        ); // EMemberNotActive

        // Verify security deposit hasn't already been paid
        assert!(members::get_deposit_balance(member) == 0, 21); // Reuse error code EDepositAlreadyPaid

        // --- Simplified Validation Logic ---
        // For USDC (6 decimals): Convert USD cents to microUSDC (multiply by 10000)
        // For SUI (9 decimals): Use the raw security_deposit amount
        
        // Check if it's SUI or stablecoin by comparing with SUI type
        if (std::type_name::get<CoinType>() == std::type_name::get<SUI>()) {
            // For SUI, validate against the SUI amount
            assert!(amount == required_sui_amount, 2); // EIncorrectDepositAmount
        } else {
            // For stablecoins like USDC, validate against USD amount
            // 20 cents ($0.20 USD) should equal 200,000 microUSDC (0.2 USDC)
            let expected_stablecoin_amount = required_usd_cents * 10000;
            assert!(amount == expected_stablecoin_amount, 2); // EIncorrectDepositAmount
        };

        // --- Update Member State --- 
        members::set_deposit_balance(member, amount);
        members::set_deposit_paid(member, true);

        // --- Call Custody to Store Coin --- 
        custody::internal_store_security_deposit_without_validation<CoinType>(
            wallet,
            deposit_coin,
            sender, // Pass sender as the member address
            clock,
            ctx
        );
    }

    // ----------------------------------------------------------
    // Deposit stablecoin to circle with price validation
    // ----------------------------------------------------------
    public entry fun deposit_stablecoin_with_price_validation<CoinType>(
        circle: &mut Circle,
        wallet: &mut custody::CustodyWallet,
        stablecoin: coin::Coin<CoinType>,
        mut required_amount: u64,
        price_info_object: &PriceInfoObject,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Circle must be active
        assert!(circle.is_active, ECircleNotActive);
        
        // Verify the sender is a member of the circle
        assert!(table::contains(&circle.members, sender), ENotMember);
        
        // If we're using custom validation requirements
        if (required_amount == 0) {
            required_amount = config::get_security_deposit(&circle.id);
        };
        
        // Process the deposit with price validation
        custody::internal_store_security_deposit<CoinType>(
            wallet,
            stablecoin,
            sender,
            required_amount,
            price_info_object,
            clock,
            ctx
        );
        
        // Update member status if deposit meets security deposit requirement
        update_member_status_after_deposit(circle, sender, required_amount, ctx);
    }
    
    // ----------------------------------------------------------
    // Update member status after deposit
    // ----------------------------------------------------------
    fun update_member_status_after_deposit(
        circle: &mut Circle,
        member_addr: address,
        amount: u64,
        ctx: &mut tx_context::TxContext
    ) {
        let current_time = tx_context::epoch_timestamp_ms(ctx);
        
        // Get the member record
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        // Check if member is pending and deposit is sufficient
        if (config::get_security_deposit(&circle.id) <= amount) {
            // If the member is pending, activate them
            let member_status = members::get_status(member);
            if (member_status == core::member_status_pending()) {
                // Change status to active - use core values consistently
                members::set_status(member, core::member_status_active());
                members::set_activated_at(member, current_time);
                
                // Update deposit balance
                members::set_deposit_balance(member, amount);
                
                // Emit member activated event
                event::emit(MemberActivated {
                    circle_id: object::uid_to_inner(&circle.id),
                    member: member_addr,
                    deposit_amount: amount
                });
            };
        };
    }

    // ----------------------------------------------------------
    // Deposit stablecoin to circle with price validation
    // ----------------------------------------------------------
    public fun process_member_deposit(
        circle: &mut Circle, 
        deposit_amount: u64,
        member_addr: address,
        ctx: &mut TxContext
    ): bool {
        // Make sure member exists in the circle
        assert!(is_member(circle, member_addr), 8);
        
        // Get security deposit requirement and USD value before getting mutable references
        let security_deposit = config::get_security_deposit(&circle.id);
        let security_deposit_usd = config::get_security_deposit_usd(&circle.id);
        
        // Now get the member object (after the immutable borrow is done)
        let member = get_member_mut(circle, member_addr);
        
        // --- Validate deposit amount directly ---
        // Check if deposit is sufficient
        assert!(deposit_amount >= security_deposit, 2); // EIncorrectDepositAmount

        // --- Update Member State --- 
        members::set_deposit_balance(member, deposit_amount);

        // Emit member activated event
        event::emit(MemberActivated {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            deposit_amount: deposit_amount,
        });
        true
    }

    // ----------------------------------------------------------
    // Update wallet ID for the circle - for admin use
    // ----------------------------------------------------------
    public entry fun update_wallet_id(
        circle: &mut Circle,
        wallet_id: ID,
        ctx: &mut TxContext
    ) {
        // Only the admin can update the wallet ID
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        
        // Update or create the wallet_id dynamic field
        let key = string::utf8(b"wallet_id");
        if (dynamic_field::exists_(&circle.id, key)) {
            *dynamic_field::borrow_mut(&mut circle.id, key) = wallet_id;
        } else {
            dynamic_field::add(&mut circle.id, key, wallet_id);
        };
    }
    
    // ----------------------------------------------------------
    // Get the wallet ID for the circle (if set)
    // ----------------------------------------------------------
    public fun get_wallet_id(circle: &Circle): Option<ID> {
        let key = string::utf8(b"wallet_id");
        if (dynamic_field::exists_(&circle.id, key)) {
            option::some(*dynamic_field::borrow(&circle.id, key))
        } else {
            option::none()
        }
    }

    // ----------------------------------------------------------
    // Member Entry function to deposit stablecoin contribution
    // ----------------------------------------------------------
    public entry fun contribute_stablecoin<CoinType>(
        circle: &mut Circle,
        wallet: &mut custody::CustodyWallet,
        payment: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&payment);

        // --- Basic Assertions --- 
        // Must be a circle member
        assert!(is_member(circle, sender), ENotMember); // Use local error code
        // Circle must be active to accept contributions
        assert!(is_circle_active(circle), ECircleNotActive);
        // Verify custody wallet belongs to this circle
        assert!(custody::get_circle_id(wallet) == get_id(circle), EWalletCircleMismatch);
        // Get member and assert status is active and not suspended
        let member = get_member(circle, sender);
        // Use local error codes
        assert!(members::get_status(member) == core::member_status_active(), EMemberNotActive); 
        assert!(option::is_none(&members::get_suspension_end_time(member)), EMemberSuspended); 

        // --- Amount Validation --- 
        // Get required contribution amount in USD cents from config
        let required_contribution_usd_cents = config::get_contribution_amount_usd(&circle.id);
        // Convert required USD cents to micro-units of the stablecoin (assuming 6 decimals for stablecoins like USDC)
        // 1 cent = 10,000 micro-units
        let required_stablecoin_amount = required_contribution_usd_cents * 10000;

        // Validate the payment amount against the required stablecoin amount
        // Allow slightly more for potential rounding, but not less
        assert!(amount >= required_stablecoin_amount, EInvalidContributionAmount); // Use local error code

        // --- Process Contribution --- 
        // IMPORTANT: First deposit the payment into the custody wallet BEFORE updating counters
        // This ensures the funds are available before any potential withdrawal attempt
        custody::deposit_contribution_coin<CoinType>(
            wallet,
            payment,
            sender,
            clock,
            ctx
        );

        // Record the contribution for the member AFTER the deposit
        let member_mut = get_member_mut(circle, sender);
        // Use the *required* amount for recording, not the potentially larger payment amount
        members::record_contribution(member_mut, required_stablecoin_amount, clock::timestamp_ms(clock));

        // Update circle's overall contribution tracking for stablecoins
        // Get the SUI equivalent contribution amount
        let contribution_amount = config::get_contribution_amount(&circle.id);
        let contribution_amount_raw = core::to_decimals(contribution_amount);
        add_to_contributions_this_cycle(circle, contribution_amount_raw);

        // Emit the locally defined StablecoinContributionMade event
        event::emit(StablecoinContributionMade {
            circle_id: get_id(circle),
            member: sender,
            // Report the required amount, consistent with member stats
            amount: required_stablecoin_amount, 
            cycle: get_current_cycle(circle),
            // Add coin type info using imported type_name and String
            // Convert ascii::String to string::String
            coin_type: string::utf8(ascii::into_bytes(type_name::into_string(type_name::get<CoinType>())))
        });

        // NOTE: We do NOT trigger automatic payout after stablecoin contribution
        // This avoids the race condition between contribution and withdrawal
        // Admin must explicitly trigger payouts with admin_trigger_payout
    }

    // ----------------------------------------------------------
    // Admin function to set maximum members for an inactive circle
    // ----------------------------------------------------------
    public entry fun admin_set_max_members(
        circle: &mut Circle,
        new_max_members: u64,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can update max members
        assert!(sender == circle.admin, ENotAdmin);
        
        // Circle must not be active
        assert!(!circle.is_active, ECircleIsActive);
        
        // Must be at least the minimum required members (3) and not less than current members
        assert!(new_max_members >= core::get_min_members(), EInvalidMaxMembersLimit);
        assert!(new_max_members >= circle.current_members, EInvalidMaxMembersLimit);
        
        // Get the old max_members value for the event
        let old_max_members = config::get_max_members(&circle.id);
        
        // Update the config
        config::set_max_members(&mut circle.id, new_max_members);
        
        // Emit event
        event::emit(CircleMaxMembersUpdated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: sender,
            old_max_members,
            new_max_members,
        });
    }

    // ----------------------------------------------------------
    // Automatic Payout Helper Functions
    // ----------------------------------------------------------
    
    // Get the current value of contributions for this cycle
    public fun get_contributions_this_cycle(circle: &Circle): u64 {
        circle.contributions_this_cycle
    }
    
    // Add to the contributions counter for this cycle
    public(package) fun add_to_contributions_this_cycle(circle: &mut Circle, amount: u64) {
        circle.contributions_this_cycle = circle.contributions_this_cycle + amount;
    }
    
    // Reset the contributions counter for this cycle (after a payout)
    public(package) fun reset_contributions_this_cycle(circle: &mut Circle) {
        circle.contributions_this_cycle = 0;
    }
    
    // Reset the payout status for all members in the rotation (for a new cycle)
    public(package) fun reset_all_members_payout_status(circle: &mut Circle) {
        // Get all the non-zero addresses from rotation_order
        let rotation = &circle.rotation_order;
        let len = vector::length(rotation);
        let mut i = 0;
        
        // Added clear log info
        std::debug::print(&len);
        std::debug::print(&b"Resetting payout status for all members");
        
        while (i < len) {
            let member_addr = *vector::borrow(rotation, i);
            
            // Skip placeholder addresses
            if (member_addr != @0x0 && table::contains(&circle.members, member_addr)) {
                let member = table::borrow_mut(&mut circle.members, member_addr);
                // Make sure to set received_payout to false regardless of current value
                members::set_received_payout(member, false);
                
                // Add debug output
                std::debug::print(&member_addr);
                std::debug::print(&b"Set payout status to false");
            };
            i = i + 1;
        };
    }
    
    // Reset contribution status for all members except the current recipient
    public(package) fun reset_all_members_contribution_status(circle: &mut Circle) {
        // Reset the contributions counter for this cycle
        circle.contributions_this_cycle = 0;
        std::debug::print(&b"Reset contributions counter to 0");
        
        // Get rotation info
        let rotation = &circle.rotation_order;
        let rotation_len = vector::length(rotation);
        
        // Reset contribution status for all members except the current recipient
        let mut i = 0;
        while (i < rotation_len) {
            let member_addr = *vector::borrow(rotation, i);
            
            // Skip placeholder addresses
            if (member_addr != @0x0 && table::contains(&circle.members, member_addr)) {
                // Skip the current recipient - they don't need to contribute for this cycle
                if (i != circle.current_position) {
                    let member = table::borrow_mut(&mut circle.members, member_addr);
                    // Reset contribution status
                    members::reset_contribution_status(member);
                    std::debug::print(&b"Reset contribution status for member:");
                    std::debug::print(&member_addr);
                };
            };
            i = i + 1;
        };
    }
    
    // Advance rotation position and cycle management
    public(package) fun advance_rotation_position_and_cycle(
        circle: &mut Circle, 
        paid_member_address: address,
        clock: &Clock
    ) {
        // Add the paid member to rotation history
        vector::push_back(&mut circle.rotation_history, paid_member_address);
        
        // Calculate next position
        let rotation_len = vector::length(&circle.rotation_order);
        
        // Print for debug purposes
        std::debug::print(&b"Advancing cycle...");
        std::debug::print(&circle.current_position);
        std::debug::print(&rotation_len);
        std::debug::print(&circle.current_cycle);
        
        // We reset all members' contribution status for the new position/cycle
        reset_all_members_contribution_status(circle);
        
        // If we're at the last position in the rotation, advance to next cycle
        if (circle.current_position + 1 >= rotation_len) {
            // Reset position to 0 for the next cycle
            circle.current_position = 0;
            // Increment cycle
            circle.current_cycle = circle.current_cycle + 1;
            // Reset all member payout status
            reset_all_members_payout_status(circle);
        } else {
            // Just move to the next position in the same cycle
            circle.current_position = circle.current_position + 1;
        };
        
        // Always update the next payout time, regardless of new cycle or just new position
        // Get cycle length and day from config
        let cycle_length = config::get_cycle_length(&circle.id);
        let cycle_day = config::get_cycle_day(&circle.id);
        
        // Calculate next payout time using the core helper function
        let now = clock::timestamp_ms(clock);
        circle.next_payout_time = core::calculate_next_payout_time(
            cycle_length, 
            cycle_day, 
            now
        );
        
        std::debug::print(&b"New payout time set to:");
        std::debug::print(&circle.next_payout_time);
        
        // Print debug info about the new position and cycle
        std::debug::print(&b"New position:");
        std::debug::print(&circle.current_position);
        std::debug::print(&b"New cycle:");
        std::debug::print(&circle.current_cycle);
    }
    
    // Get the next member in rotation order who should receive a payout
    public fun get_next_payout_recipient(circle: &Circle): Option<address> {
        let rotation = &circle.rotation_order;
        let rotation_len = vector::length(rotation);
        
        // Check if rotation is empty or invalid position
        if (rotation_len == 0 || circle.current_position >= rotation_len) {
            return option::none()
        };
        
        let recipient = *vector::borrow(rotation, circle.current_position);
        
        // Check if it's a placeholder address
        if (recipient == @0x0) {
            return option::none()
        };
        
        option::some(recipient)
    }
    
    // Check if all active members have contributed for the current cycle
    public fun has_all_members_contributed(circle: &Circle): bool {
        // Count active members in rotation
        let mut active_members = 0;
        let rotation = &circle.rotation_order;
        let len = vector::length(rotation);
        let mut i = 0;
        
        // Get current recipient (member at current_position)
        let current_recipient = if (circle.current_position < len) {
            *vector::borrow(rotation, circle.current_position)
        } else {
            @0x0 // Invalid recipient address
        };
        
        // Track if recipient is counted in active members
        let mut recipient_is_active = false;
        
        while (i < len) {
            let member_addr = *vector::borrow(rotation, i);
            if (member_addr != @0x0 && table::contains(&circle.members, member_addr)) {
                let member = table::borrow(&circle.members, member_addr);
                if (members::get_status(member) == core::member_status_active()) {
                    active_members = active_members + 1;
                    // Check if this active member is the recipient
                    if (member_addr == current_recipient) {
                        recipient_is_active = true;
                    };
                };
            };
            i = i + 1;
        };
        
        // If there are no active members, the check passes (sanity check)
        if (active_members == 0) {
            return true
        };
        
        // Calculate expected total contributions
        let contribution_amount = config::get_contribution_amount(&circle.id);
        
        // Adjust active_members to exclude recipient if they're active
        let contributing_members = if (recipient_is_active) {
            active_members - 1
        } else {
            active_members
        };
        
        let expected_contributions = contribution_amount * contributing_members;
        
        // Compare with actual contributions this cycle
        circle.contributions_this_cycle >= expected_contributions
    }

    // ----------------------------------------------------------
    // Set the current position in the rotation
    // ----------------------------------------------------------
    public(package) fun set_current_position(circle: &mut Circle, position: u64) {
        // Ensure position is valid
        let rotation_len = vector::length(&circle.rotation_order);
        assert!(position < rotation_len, 29); // Use existing EInvalidRotationPosition (29)
        
        circle.current_position = position;
    }

    // ----------------------------------------------------------
    // Get the current position in the rotation
    // ----------------------------------------------------------
    public fun get_current_position(circle: &Circle): u64 {
        circle.current_position
    }

    // ----------------------------------------------------------
    // Helper to convert cycle length to milliseconds
    // ----------------------------------------------------------
    public fun cycle_length_in_milliseconds(circle: &Circle): u64 {
        let cycle_length = config::get_cycle_length(&circle.id);
        
        // Convert cycle length to milliseconds
        // 0 = weekly, 1 = monthly, 2 = quarterly, 3 = bi-weekly
        if (cycle_length == 0) {
            SEVEN_DAYS_MS // Weekly
        } else if (cycle_length == 1) {
            THIRTY_DAYS_MS // Monthly (30 days)
        } else if (cycle_length == 2) {
            THIRTY_DAYS_MS * 3 // Quarterly (90 days)
        } else if (cycle_length == 3) {
            SEVEN_DAYS_MS * 2 // Bi-weekly (14 days)
        } else {
            THIRTY_DAYS_MS // Default to monthly if unknown
        }
    }
} 