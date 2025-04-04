#[allow(duplicate_alias)]
module njangi::njangi_circle {
    use sui::object;
    use sui::transfer;
    use sui::tx_context;
    use sui::coin;
    use sui::balance;
    use sui::table;
    use sui::clock;
    use sui::event;
    use sui::sui::SUI;
    use std::string;
    use std::vector;
    use std::option;

    // ----------------------------------------------------------
    // Constants and Error codes
    // ----------------------------------------------------------
    const MIN_MEMBERS: u64 = 3;
    const MAX_MEMBERS: u64 = 20;
    
    // SUI specific constants
    const DECIMAL_SCALING: u64 = 1_000_000_000; // 10^9 for SUI decimals
    
    // Error constants
    const EInvalidMemberCount: u64 = 0;
    const EInvalidContributionAmount: u64 = 1;
    const EInvalidSecurityDeposit: u64 = 2;
    const EInvalidCycleLength: u64 = 3;
    const EInvalidCycleDay: u64 = 4;
    const ECircleFull: u64 = 5;
    const EInsufficientDeposit: u64 = 6;
    const ENotAdmin: u64 = 7;
    const ENotMember: u64 = 8;
    const EInsufficientBalance: u64 = 12;
    const EMemberSuspended: u64 = 13;
    const EMemberNotActive: u64 = 14;
    const EMemberHasOutstandingObligations: u64 = 18;
    const EInsufficientPenaltyPayment: u64 = 19;
    const ENoWarningToClear: u64 = 20;
    const EPenaltyAlreadyPaid: u64 = 21;
    const EInvalidPayoutAmount: u64 = 22;
    const EPayoutAlreadyProcessed: u64 = 23;
    const EInvalidPayoutSchedule: u64 = 24;
    const EInsufficientTreasuryBalance: u64 = 25;
    const EInvalidBidAmount: u64 = 26;
    const EAuctionNotActive: u64 = 27;
    const EInvalidMilestone: u64 = 28;
    const EInvalidRotationPosition: u64 = 29;
    const EPositionAlreadyTaken: u64 = 30;
    const EMilestoneTypeInvalid: u64 = 31;
    const EMilestoneTargetInvalid: u64 = 32;
    const EMilestoneVerificationFailed: u64 = 33;
    const EMilestoneDeadlinePassed: u64 = 34;
    const EMilestoneAlreadyVerified: u64 = 35;
    const EMilestonePrerequisiteNotMet: u64 = 36;
    const ECircleHasActiveMembers: u64 = 37;
    const ECircleHasContributions: u64 = 38;
    const EMemberAlreadyExists: u64 = 39;
    const EMemberNotPending: u64 = 40;
    const EPendingMembersExist: u64 = 41;
    const ENotWalletOwner: u64 = 42;
    const EWalletNotActive: u64 = 43;
    const EFundsTimeLocked: u64 = 44;
    const EExceedsWithdrawalLimit: u64 = 45;
    const EWalletCircleMismatch: u64 = 46;

    // Time constants (all in milliseconds)
    const MS_PER_DAY: u64 = 86_400_000;       // 24 * 60 * 60 * 1000
    const MS_PER_WEEK: u64 = 604_800_000;     // 7  * 24 * 60 * 60 * 1000
    const MS_PER_MONTH: u64 = 2_419_200_000;   // 28 * 24 * 60 * 60 * 1000

    // Day constants (as u64 for consistent % operations)
    const DAYS_IN_WEEK: u64 = 7;
    const DAYS_IN_MONTH: u64 = 28;

    // Member status constants
    const MEMBER_STATUS_ACTIVE: u8 = 0;
    const MEMBER_STATUS_PENDING: u8 = 1;  // New status for members who joined without deposit
    const MEMBER_STATUS_SUSPENDED: u8 = 2;
    const MEMBER_STATUS_EXITED: u8 = 3;

    // Milestone type constants
    const MILESTONE_TYPE_MONETARY: u8 = 0;
    const MILESTONE_TYPE_TIME: u8 = 1;
    
    // Custody operation types
    const CUSTODY_OP_DEPOSIT: u8 = 0;
    const CUSTODY_OP_WITHDRAWAL: u8 = 1;
    const CUSTODY_OP_PAYOUT: u8 = 2;

    // ----------------------------------------------------------
    // Helper functions to handle SUI decimal scaling
    // ----------------------------------------------------------
    fun to_decimals(amount: u64): u64 {
        // We'll use a safer approach to handle very large amounts
        // DECIMAL_SCALING is 10^9 (1_000_000_000)
        // Max u64 is 18,446,744,073,709,551,615
        // So the safe limit for multiplication is 18,446,744,073 (without scaling)
        
        // Check if amount is too large to multiply safely
        if (amount > 18_446_744_073) {
            // If we have a huge amount, we'll return the max safe scaled value
            // This prevents runtime errors while still allowing very large values
            18_446_744_073_000_000_000 // Max safe value with 9 decimals
        } else {
            amount * DECIMAL_SCALING
        }
    }

    fun from_decimals(amount: u64): u64 {
        amount / DECIMAL_SCALING
    }

    // ----------------------------------------------------------
    // Main data structures
    // ----------------------------------------------------------
    
    // New struct to hold USD amounts
    public struct USDAmounts has store, drop {
        contribution_amount: u64, // USD amount * 100 (cents)
        security_deposit: u64,    // USD amount * 100 (cents)
        target_amount: option::Option<u64>, // USD amount * 100 (cents)
    }
    
    // Add a new struct for stablecoin configuration
    public struct StablecoinConfig has store, drop {
        enabled: bool,
        target_coin_type: string::String,    // Type of stablecoin to swap to
        dex_address: address,                // Address of the DEX to use
        slippage_tolerance: u64,             // Slippage tolerance in basis points (e.g., 50 = 0.5%)
        last_swap_time: u64,                 // Timestamp of last swap
        minimum_swap_amount: u64,            // Minimum amount to swap (to avoid dust)
    }
    
    // Custody wallet linked to a circle for secure fund storage
    public struct CustodyWallet has key, store {
        id: object::UID,
        circle_id: object::ID,
        balance: balance::Balance<SUI>,
        admin: address,
        created_at: u64,
        locked_until: option::Option<u64>,
        is_active: bool,
        daily_withdrawal_limit: u64,  // Maximum withdrawal per day
        last_withdrawal_time: u64,    // Timestamp of last withdrawal
        daily_withdrawal_total: u64,  // Running total of withdrawals for the day
        stablecoin_config: StablecoinConfig,  // Added stablecoin configuration
        stablecoin_balance: u64,              // Balance of stablecoins (in smallest unit)
    }
    
    // Transaction record for custody wallet operations
    public struct CustodyTransaction has store, drop {
        operation_type: u8,
        user: address,
        amount: u64,
        timestamp: u64,
    }
    
    public struct Circle has key, store {
        id: object::UID,
        name: string::String,
        admin: address,
        contribution_amount: u64, // in SUI decimals
        security_deposit: u64,    // in SUI decimals
        cycle_length: u64,        // Changed from u8 to u64
        cycle_day: u64,           // Changed from u8 to u64
        circle_type: u8,
        rotation_style: u8,
        max_members: u64,
        current_members: u64,
        members: table::Table<address, Member>,
        contributions: balance::Balance<SUI>,
        deposits: balance::Balance<SUI>,
        penalties: balance::Balance<SUI>,
        current_cycle: u64,
        next_payout_time: u64,
        goal_type: option::Option<u8>,
        target_amount: option::Option<u64>, // in SUI decimals
        target_date: option::Option<u64>,
        verification_required: bool,
        penalty_rules: PenaltyRules,
        created_at: u64,
        rotation_order: vector<address>,
        rotation_history: vector<address>,
        current_position: u64,
        active_auction: option::Option<Auction>,
        milestones: vector<Milestone>,
        goal_progress: u64,
        last_milestone_completed: u64,
        usd_amounts: USDAmounts,    // Combined field for all USD amounts
    }

    public struct Member has store, drop {
        joined_at: u64,
        last_contribution: u64,
        total_contributed: u64,   // in SUI decimals
        received_payout: bool,
        payout_position: Option<u64>,
        deposit_balance: u64,     // in SUI decimals
        missed_payments: u64,
        missed_meetings: u64,
        status: u8,
        warning_count: u8,
        reputation_score: u8,
        last_warning_time: u64,
        suspension_end_time: Option<u64>,
        total_meetings_attended: u64,
        total_meetings_required: u64,
        consecutive_on_time_payments: u64,
        exit_requested: bool,
        exit_request_time: Option<u64>,
        unpaid_penalties: u64,    // in SUI decimals
        warnings_with_penalties: vector<u64>, // Timestamps of each warning with penalty
    }

    public struct PenaltyRules has store, drop {
        late_payment: bool,
        missed_meeting: bool,
        late_payment_fee: u64,
        missed_meeting_fee: u64,
        warning_penalty_amount: u64,  // in SUI decimals
        allow_penalty_payments: bool,
    }

    // ----------------------------------------------------------
    // Auction / Milestone support
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

    public struct Milestone has store, drop {
        milestone_type: u8,
        target_amount: option::Option<u64>,        // For monetary (in SUI decimals)
        target_duration: option::Option<u64>,      // For time-based (in ms)
        start_time: u64,
        deadline: u64,
        completed: bool,
        verified_by: option::Option<address>,
        completion_time: option::Option<u64>,
        description: string::String,
        prerequisites: vector<u64>,        // Indices of prior milestones
        verification_requirements: vector<u8>,
        verification_proofs: vector<vector<u8>>,
    }

    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    public struct CircleCreated has copy, drop {
        circle_id: object::ID,
        admin: address,
        name: string::String,
        contribution_amount: u64,
        contribution_amount_usd: u64, // USD amount in cents
        security_deposit_usd: u64,    // USD amount in cents
        max_members: u64,
        cycle_length: u64,
    }

    public struct MemberJoined has copy, drop {
        circle_id: object::ID,
        member: address,
        position: option::Option<u64>,
    }

    public struct ContributionMade has copy, drop {
        circle_id: object::ID,
        member: address,
        amount: u64,
        cycle: u64,
    }

    public struct WarningIssued has copy, drop {
        circle_id: object::ID,
        member: address,
        warning_count: u8,
        penalty_amount: u64,
        reason: string::String,
    }

    public struct PenaltyPaid has copy, drop {
        circle_id: object::ID,
        member: address,
        amount: u64,
        warnings_cleared: u8,
    }

    public struct PayoutProcessed has copy, drop {
        circle_id: object::ID,
        recipient: address,
        amount: u64,
        cycle: u64,
        payout_type: u8,
    }

    public struct TreasuryUpdated has copy, drop {
        circle_id: object::ID,
        contributions_balance: u64,
        deposits_balance: u64,
        penalties_balance: u64,
        cycle: u64,
    }

    public struct AuctionStarted has copy, drop {
        circle_id: object::ID,
        position: u64,
        minimum_bid: u64,
        end_time: u64,
    }

    public struct BidPlaced has copy, drop {
        circle_id: object::ID,
        bidder: address,
        amount: u64,
        position: u64,
    }

    public struct AuctionCompleted has copy, drop {
        circle_id: object::ID,
        winner: address,
        position: u64,
        winning_bid: u64,
    }

    public struct MilestoneCompleted has copy, drop {
        circle_id: object::ID,
        milestone_number: u64,
        verified_by: address,
        amount_achieved: u64,
    }

    public struct MilestoneVerificationSubmitted has copy, drop {
        circle_id: object::ID,
        milestone_number: u64,
        submitted_by: address,
        proof_type: u8,
        timestamp: u64,
    }

    public struct CircleDeleted has copy, drop {
        circle_id: object::ID,
        admin: address,
        name: string::String,
    }

    // New event for admin approval
    public struct MemberApproved has copy, drop {
        circle_id: object::ID,
        member: address,
        approved_by: address,
    }
    
    // New event for circle activation
    public struct CircleActivated has copy, drop {
        circle_id: object::ID,
        activated_by: address,
    }
    
    // New event for member activation
    public struct MemberActivated has copy, drop {
        circle_id: object::ID,
        member: address,
        deposit_amount: u64,
    }

    // Custody wallet events
    public struct CustodyWalletCreated has copy, drop {
        circle_id: object::ID,
        wallet_id: object::ID,
        admin: address,
    }
    
    public struct CustodyDeposited has copy, drop {
        circle_id: object::ID,
        wallet_id: object::ID,
        member: address,
        amount: u64,
        operation_type: u8,
    }
    
    public struct CustodyWithdrawn has copy, drop {
        circle_id: object::ID,
        wallet_id: object::ID,
        recipient: address,
        amount: u64,
        operation_type: u8,
    }

    // Add a new event for swap operations
    public struct StablecoinSwapExecuted has copy, drop {
        circle_id: object::ID,
        wallet_id: object::ID,
        sui_amount: u64,
        stablecoin_amount: u64,
        stablecoin_type: string::String,
        timestamp: u64,
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
        goal_type: option::Option<u8>,
        target_amount: option::Option<u64>,
        target_amount_usd: option::Option<u64>, // USD amount in cents
        target_date: option::Option<u64>,
        verification_required: bool,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        // Convert to 9-decimal SUI
        let contribution_amount_scaled = to_decimals(contribution_amount);
        let security_deposit_scaled = to_decimals(security_deposit);
        let target_amount_scaled = if (option::is_some(&target_amount)) {
            let amt_ref = option::borrow(&target_amount);
            option::some(to_decimals(*amt_ref))
        } else {
            option::none()
        };

        // Basic validations
        assert!(max_members >= MIN_MEMBERS && max_members <= MAX_MEMBERS, EInvalidMemberCount);
        assert!(contribution_amount_scaled > 0, EInvalidContributionAmount);
        assert!(security_deposit_scaled >= (contribution_amount_scaled / 2), EInvalidSecurityDeposit);
        assert!(cycle_length <= 2, EInvalidCycleLength);
        assert!(
            (cycle_length == 0 && cycle_day < 7)   // weekly
            || (cycle_length > 0 && cycle_day < 28), // monthly/quarterly up to 28
            EInvalidCycleDay
        );
        
        // Create USDAmounts structure
        let usd_amounts = USDAmounts {
            contribution_amount: contribution_amount_usd,
            security_deposit: security_deposit_usd,
            target_amount: target_amount_usd,
        };

        let circle = Circle {
            id: object::new(ctx),
            name: string::utf8(name),
            admin: tx_context::sender(ctx),
            contribution_amount: contribution_amount_scaled,
            security_deposit: security_deposit_scaled,
            cycle_length,
            cycle_day,
            circle_type,
            rotation_style,
            max_members,
            current_members: 0,
            members: table::new(ctx),
            contributions: balance::zero<SUI>(),
            deposits: balance::zero<SUI>(),
            penalties: balance::zero<SUI>(),
            current_cycle: 0,
            next_payout_time: calculate_next_payout_time(cycle_length, cycle_day, clock::timestamp_ms(clock)),
            goal_type,
            target_amount: target_amount_scaled,
            target_date,
            verification_required,
            penalty_rules: create_penalty_rules(penalty_rules),
            created_at: clock::timestamp_ms(clock),
            rotation_order: vector::empty(),
            rotation_history: vector::empty(),
            current_position: 0,
            active_auction: option::none(),
            milestones: vector::empty(),
            goal_progress: 0,
            last_milestone_completed: 0,
            usd_amounts,
        };
        
        // Create the circle's custody wallet
        let circle_id = object::uid_to_inner(&circle.id);
        create_custody_wallet(circle_id, clock::timestamp_ms(clock), ctx);

        event::emit(CircleCreated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: tx_context::sender(ctx),
            name: string::utf8(name),
            contribution_amount: contribution_amount_scaled,
            contribution_amount_usd,
            security_deposit_usd,
            max_members,
            cycle_length,
        });

        // Make the newly created `Circle` object shared
        transfer::share_object(circle);
    }
    
    // ----------------------------------------------------------
    // Create a custody wallet for a circle
    // ----------------------------------------------------------
    fun create_custody_wallet(
        circle_id: object::ID,
        timestamp: u64,
        ctx: &mut tx_context::TxContext
    ) {
        let admin = tx_context::sender(ctx);
        
        // Create default stablecoin configuration
        let stablecoin_config = StablecoinConfig {
            enabled: false,                                // Disabled by default
            target_coin_type: string::utf8(b"USDC"),       // Default to USDC
            dex_address: @0x0,                             // Empty DEX address
            slippage_tolerance: 50,                        // 0.5% slippage tolerance
            last_swap_time: 0,
            minimum_swap_amount: to_decimals(1),           // 1 SUI minimum
        };
        
        // Create custody wallet with stablecoin config
        let wallet = CustodyWallet {
            id: object::new(ctx),
            circle_id,
            balance: balance::zero<SUI>(),
            admin,
            created_at: timestamp,
            locked_until: option::none(),
            is_active: true,
            daily_withdrawal_limit: to_decimals(10000),  // Default 10,000 SUI daily limit
            last_withdrawal_time: 0,
            daily_withdrawal_total: 0,
            stablecoin_config,
            stablecoin_balance: 0,
        };
        
        // Get the wallet ID before sharing
        let wallet_id = object::uid_to_inner(&wallet.id);
        
        // Share the wallet object - must be done in the same module
        transfer::share_object(wallet);
        
        event::emit(CustodyWalletCreated {
            circle_id,
            wallet_id,
            admin,
        });
    }
    
    // ----------------------------------------------------------
    // Create a transaction record for custody operations
    // ----------------------------------------------------------
    fun create_custody_transaction(
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
    // Configure stablecoin auto-swap settings
    // ----------------------------------------------------------
    public fun configure_stablecoin_swap(
        wallet: &mut CustodyWallet,
        enabled: bool,
        target_coin_type: vector<u8>,
        dex_address: address,
        slippage_tolerance: u64,
        minimum_swap_amount: u64,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can configure swap settings
        assert!(sender == wallet.admin, ENotAdmin);
        
        // Update configuration
        wallet.stablecoin_config.enabled = enabled;
        wallet.stablecoin_config.target_coin_type = string::utf8(target_coin_type);
        wallet.stablecoin_config.dex_address = dex_address;
        wallet.stablecoin_config.slippage_tolerance = slippage_tolerance;
        wallet.stablecoin_config.minimum_swap_amount = minimum_swap_amount;
    }
    
    // ----------------------------------------------------------
    // Execute stablecoin swap (simulated)
    // ----------------------------------------------------------
    fun execute_stablecoin_swap(
        wallet: &mut CustodyWallet,
        amount: u64,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        // Check if auto-swap is enabled and minimum amount is met
        if (!wallet.stablecoin_config.enabled || amount < wallet.stablecoin_config.minimum_swap_amount) {
            return
        };
        
        // In a real implementation, this function would:
        // 1. Connect to the specified DEX
        // 2. Get the current exchange rate
        // 3. Calculate the slippage-adjusted minimum output
        // 4. Execute the swap transaction
        // 5. Update the stablecoin balance
        
        // For now, we'll simulate the swap with a fixed rate
        // In production, this would call the DEX's swap function
        let estimated_stablecoin_amount = simulate_swap_rate(amount);
        
        // Update the stablecoin balance
        wallet.stablecoin_balance = wallet.stablecoin_balance + estimated_stablecoin_amount;
        wallet.stablecoin_config.last_swap_time = clock::timestamp_ms(clock);
        
        // Emit swap event
        event::emit(StablecoinSwapExecuted {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            sui_amount: amount,
            stablecoin_amount: estimated_stablecoin_amount,
            stablecoin_type: wallet.stablecoin_config.target_coin_type,
            timestamp: clock::timestamp_ms(clock),
        });
    }
    
    // ----------------------------------------------------------
    // Helper function to simulate swap rate (for demo purposes)
    // ----------------------------------------------------------
    fun simulate_swap_rate(sui_amount: u64): u64 {
        // Simulate a swap rate of 1 SUI = $2.50 USDC
        // In a real implementation, this would query the DEX for the current rate
        // This is just a placeholder
        let usdc_per_sui = 250_000_000; // $2.50 with 8 decimals
        (sui_amount * usdc_per_sui) / DECIMAL_SCALING
    }
    
    // ----------------------------------------------------------
    // Modified deposit_to_custody to include auto-swap
    // ----------------------------------------------------------
    public fun deposit_to_custody(
        wallet: &mut CustodyWallet,
        payment: coin::Coin<SUI>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&payment);
        
        // Wallet must be active
        assert!(wallet.is_active, EWalletNotActive);
        
        // Check if sender is admin or a member of the circle
        assert!(sender == wallet.admin || is_authorized_depositor(wallet.circle_id, sender, ctx), ENotWalletOwner);
        
        // Add to wallet balance
        balance::join(&mut wallet.balance, coin::into_balance(payment));
        
        // Create transaction record (not storing it yet, but using the struct)
        let _txn_record = create_custody_transaction(
            CUSTODY_OP_DEPOSIT,
            sender,
            amount,
            clock::timestamp_ms(clock)
        );
        
        // We'll handle transaction history through events only for now
        event::emit(CustodyDeposited {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            member: sender,
            amount,
            operation_type: CUSTODY_OP_DEPOSIT,
        });
        
        // If auto-swap is enabled, execute the swap
        if (wallet.stablecoin_config.enabled) {
            // For safety, we'll split the amount to swap from the wallet balance
            // instead of passing the new deposit directly
            let swap_amount = balance::value(&wallet.balance);
            
            // Only swap if we have enough to meet the minimum
            if (swap_amount >= wallet.stablecoin_config.minimum_swap_amount) {
                execute_stablecoin_swap(wallet, swap_amount, clock, ctx);
            };
        };
    }
    
    // Helper function to check if sender is authorized to deposit to the wallet
    fun is_authorized_depositor(_circle_id: object::ID, _sender: address, _ctx: &mut tx_context::TxContext): bool {
        // In a production implementation, this would check if sender is a member of the circle
        // For now, we'll just return true to simplify
        true
    }
    
    // ----------------------------------------------------------
    // Process payout from custody wallet
    // ----------------------------------------------------------
    public fun process_custody_payout(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        recipient: address,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        
        // Only circle admin can process payouts
        assert!(sender == circle.admin, ENotAdmin);
        
        // Verify custody wallet belongs to this circle
        assert!(wallet.circle_id == object::uid_to_inner(&circle.id), EWalletCircleMismatch);
        
        // Wallet must be active
        assert!(wallet.is_active, EWalletNotActive);
        
        // Check if wallet is time-locked
        if (option::is_some(&wallet.locked_until)) {
            let lock_time = *option::borrow(&wallet.locked_until);
            assert!(current_time >= lock_time, EFundsTimeLocked);
        };
        
        // Verify recipient is a member
        assert!(table::contains(&circle.members, recipient), ENotMember);
        
        // Check timing and member status for payout
        let member = table::borrow_mut(&mut circle.members, recipient);
        
        assert!(current_time >= circle.next_payout_time, EInvalidPayoutSchedule);
        assert!(!member.received_payout, EPayoutAlreadyProcessed);
        
        // Calculate payout amount
        let payout_amount = if (option::is_some(&circle.goal_type)) {
            // Proportional payout based on contribution
            let total_contributions = balance::value(&circle.contributions);
            (member.total_contributed * total_contributions)
            / (circle.contribution_amount * circle.current_members)
        } else {
            // Standard rotational payout
            circle.contribution_amount * circle.current_members
        };
        
        // Verify sufficient funds in wallet
        assert!(balance::value(&wallet.balance) >= payout_amount, EInsufficientBalance);
        
        // Check daily withdrawal limit
        let is_new_day = current_time > wallet.last_withdrawal_time + MS_PER_DAY;
        
        if (is_new_day) {
            // Reset daily total if it's a new day
            wallet.daily_withdrawal_total = payout_amount;
        } else {
            // Add to daily total and check limit
            let new_daily_total = wallet.daily_withdrawal_total + payout_amount;
            assert!(new_daily_total <= wallet.daily_withdrawal_limit, EExceedsWithdrawalLimit);
            wallet.daily_withdrawal_total = new_daily_total;
        };
        
        // Update last withdrawal time
        wallet.last_withdrawal_time = current_time;
        
        // Process payout
        let payout_balance = balance::split(&mut wallet.balance, payout_amount);
        let payout_coin = coin::from_balance(payout_balance, ctx);
        
        // Send the payout to recipient's zkLogin wallet
        transfer::public_transfer(payout_coin, recipient);
        
        // Mark member as paid
        member.received_payout = true;
        
        event::emit(CustodyWithdrawn {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            recipient,
            amount: payout_amount,
            operation_type: CUSTODY_OP_PAYOUT,
        });
        
        event::emit(PayoutProcessed {
            circle_id: object::uid_to_inner(&circle.id),
            recipient,
            amount: payout_amount,
            cycle: circle.current_cycle,
            payout_type: option::get_with_default(&circle.goal_type, 0),
        });
    }
    
    // ----------------------------------------------------------
    // Contribute to circle through custody wallet
    // ----------------------------------------------------------
    public fun contribute_from_custody(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        member_addr: address,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only circle admin can process contributions from custody
        assert!(sender == circle.admin, ENotAdmin);
        
        // Verify custody wallet belongs to this circle
        assert!(wallet.circle_id == object::uid_to_inner(&circle.id), EWalletCircleMismatch);
        
        // Wallet must be active
        assert!(wallet.is_active, EWalletNotActive);
        
        // Verify member is part of the circle
        assert!(table::contains(&circle.members, member_addr), ENotMember);
        
        // Check member status
        let member = table::borrow(&circle.members, member_addr);
        assert!(member.status == MEMBER_STATUS_ACTIVE, EMemberNotActive);
        assert!(option::is_none(&member.suspension_end_time), EMemberSuspended);
        
        // Verify sufficient balance in custody wallet
        assert!(balance::value(&wallet.balance) >= circle.contribution_amount, EInsufficientBalance);
        
        // Move funds from custody wallet to circle contributions
        let contribution = balance::split(&mut wallet.balance, circle.contribution_amount);
        balance::join(&mut circle.contributions, contribution);
        
        // Update member stats
        let member_mut = table::borrow_mut(&mut circle.members, member_addr);
        member_mut.last_contribution = clock::timestamp_ms(clock);
        member_mut.total_contributed = member_mut.total_contributed + circle.contribution_amount;
        
        event::emit(CustodyWithdrawn {
            circle_id: wallet.circle_id,
            wallet_id: object::uid_to_inner(&wallet.id),
            recipient: member_addr,
            amount: circle.contribution_amount,
            operation_type: CUSTODY_OP_WITHDRAWAL,
        });
        
        event::emit(ContributionMade {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            amount: circle.contribution_amount,
            cycle: circle.current_cycle,
        });
    }
    
    // ----------------------------------------------------------
    // Check custody wallet balance
    // ----------------------------------------------------------
    public fun get_custody_balance(wallet: &CustodyWallet): u64 {
        from_decimals(balance::value(&wallet.balance))
    }
    
    // ----------------------------------------------------------
    // Lock custody wallet until a specific time
    // ----------------------------------------------------------
    public fun lock_custody_wallet(
        wallet: &mut CustodyWallet,
        until_timestamp: u64,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can lock the wallet
        assert!(sender == wallet.admin, ENotAdmin);
        
        wallet.locked_until = option::some(until_timestamp);
    }
    
    // ----------------------------------------------------------
    // Unlock custody wallet
    // ----------------------------------------------------------
    public fun unlock_custody_wallet(
        wallet: &mut CustodyWallet,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can unlock the wallet
        assert!(sender == wallet.admin, ENotAdmin);
        
        wallet.locked_until = option::none();
    }

    // ----------------------------------------------------------
    // Join Circle (stake deposit in SUI)
    // ----------------------------------------------------------
    public fun join_circle(
        circle: &mut Circle,
        deposit: coin::Coin<SUI>,
        position: option::Option<u64>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Must not exceed max members
        assert!(circle.current_members < circle.max_members, ECircleFull);
        // Must have at least the required security deposit in SUI
        assert!(coin::value(&deposit) >= circle.security_deposit, EInsufficientDeposit);

        let member = Member {
            joined_at: clock::timestamp_ms(clock),
            last_contribution: 0,
            total_contributed: 0,
            received_payout: false,
            payout_position: position,
            deposit_balance: coin::value(&deposit),
            missed_payments: 0,
            missed_meetings: 0,
            status: MEMBER_STATUS_ACTIVE,
            warning_count: 0,
            reputation_score: 0,
            last_warning_time: 0,
            suspension_end_time: option::none(),
            total_meetings_attended: 0,
            total_meetings_required: 0,
            consecutive_on_time_payments: 0,
            exit_requested: false,
            exit_request_time: option::none(),
            unpaid_penalties: 0,
            warnings_with_penalties: vector::empty(),
        };

        // Add to members table, increase count
        table::add(&mut circle.members, sender, member);
        circle.current_members = circle.current_members + 1;

        // Move deposit coin -> circle's deposit balance
        balance::join(&mut circle.deposits, coin::into_balance(deposit));

        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            position,
        });
    }

    // ----------------------------------------------------------
    // Admin approves member to join without deposit
    // ----------------------------------------------------------
    public fun admin_approve_member(
        circle: &mut Circle,
        member_addr: address,
        position: option::Option<u64>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can approve members
        assert!(sender == circle.admin, ENotAdmin);
        // Must not exceed max members
        assert!(circle.current_members < circle.max_members, ECircleFull);
        // Member should not already be in the circle
        assert!(!table::contains(&circle.members, member_addr), EMemberAlreadyExists);

        let member = Member {
            joined_at: clock::timestamp_ms(clock),
            last_contribution: 0,
            total_contributed: 0,
            received_payout: false,
            payout_position: position,
            deposit_balance: 0, // No deposit yet
            missed_payments: 0,
            missed_meetings: 0,
            status: MEMBER_STATUS_PENDING, // Pending status until deposit is made
            warning_count: 0,
            reputation_score: 0,
            last_warning_time: 0,
            suspension_end_time: option::none(),
            total_meetings_attended: 0,
            total_meetings_required: 0,
            consecutive_on_time_payments: 0,
            exit_requested: false,
            exit_request_time: option::none(),
            unpaid_penalties: 0,
            warnings_with_penalties: vector::empty(),
        };

        // Add to members table, increase count
        table::add(&mut circle.members, member_addr, member);
        circle.current_members = circle.current_members + 1;

        event::emit(MemberApproved {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            approved_by: sender,
        });
        
        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            position,
        });
    }
    
    // ----------------------------------------------------------
    // Member provides deposit after being approved
    // ----------------------------------------------------------
    public fun provide_deposit(
        circle: &mut Circle,
        deposit: coin::Coin<SUI>,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Must be a circle member
        assert!(table::contains(&circle.members, sender), ENotMember);
        
        let member = table::borrow(&circle.members, sender);
        // Must be in pending status
        assert!(member.status == MEMBER_STATUS_PENDING, EMemberNotPending);
        // Must have at least the required security deposit in SUI
        assert!(coin::value(&deposit) >= circle.security_deposit, EInsufficientDeposit);
        
        // Store the deposit amount before consuming the coin
        let deposit_amount = coin::value(&deposit);
        
        // Update member status and balance
        let member_mut = table::borrow_mut(&mut circle.members, sender);
        member_mut.status = MEMBER_STATUS_ACTIVE;
        member_mut.deposit_balance = deposit_amount;
        
        // Move deposit coin -> circle's deposit balance
        balance::join(&mut circle.deposits, coin::into_balance(deposit));
        
        event::emit(MemberActivated {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            deposit_amount: deposit_amount,
        });
    }
    
    // ----------------------------------------------------------
    // Admin activates the circle, requiring all members to have deposits
    // ----------------------------------------------------------
    public fun activate_circle(
        circle: &mut Circle,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can activate the circle
        assert!(sender == circle.admin, ENotAdmin);
        
        // Scan for members in pending status and ensure none exist
        let mut found_pending = false;
        
        // First check the admin
        if (table::contains(&circle.members, circle.admin)) {
            let admin_member = table::borrow(&circle.members, circle.admin);
            if (admin_member.status == MEMBER_STATUS_PENDING) {
                found_pending = true;
            };
        };
        
        // Some sample checking of other potential members
        // In a real implementation, we would need a better way to iterate
        // This is a simplification for the current contract model
        if (!found_pending && circle.current_members > 0) {
            // Try to find any pending members among known addresses
            let mut i = 0;
            let addresses = get_sample_addresses();
            let len = vector::length(&addresses);
            
            while (i < len && !found_pending) {
                let addr = *vector::borrow(&addresses, i);
                if (table::contains(&circle.members, addr) && addr != circle.admin) {
                    let member = table::borrow(&circle.members, addr);
                    if (member.status == MEMBER_STATUS_PENDING) {
                        found_pending = true;
                        break
                    };
                };
                i = i + 1;
            };
        };
        
        // If any members are still pending, abort
        assert!(!found_pending, EPendingMembersExist);
        
        event::emit(CircleActivated {
            circle_id: object::uid_to_inner(&circle.id),
            activated_by: sender,
        });
    }
    
    


    // ----------------------------------------------------------
    // Contribute SUI to the circle
    // ----------------------------------------------------------
    public fun contribute(
        circle: &mut Circle,
        payment: coin::Coin<SUI>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Must be a circle member
        assert!(table::contains(&circle.members, sender), ENotMember);
        // Must be at least the `contribution_amount`
        assert!(coin::value(&payment) >= circle.contribution_amount, EInvalidContributionAmount);

        let member = table::borrow(&circle.members, sender);
        assert!(member.status == MEMBER_STATUS_ACTIVE, EMemberNotActive);
        assert!(option::is_none(&member.suspension_end_time), EMemberSuspended);

        // Update stats
        let member_mut = table::borrow_mut(&mut circle.members, sender);
        member_mut.last_contribution = clock::timestamp_ms(clock);
        member_mut.total_contributed = member_mut.total_contributed + circle.contribution_amount;

        // Join the coin into the circle's `contributions` balance
        balance::join(&mut circle.contributions, coin::into_balance(payment));

        event::emit(ContributionMade {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            amount: circle.contribution_amount,
            cycle: circle.current_cycle,
        });
    }

    // ----------------------------------------------------------
    // Read-Only Helpers (convert from decimals)
    // ----------------------------------------------------------
    public fun get_contribution_amount(circle: &Circle): u64 {
        from_decimals(circle.contribution_amount)
    }

    public fun get_security_deposit(circle: &Circle): u64 {
        from_decimals(circle.security_deposit)
    }

    public fun get_target_amount(circle: &Circle): Option<u64> {
        if (option::is_some(&circle.target_amount)) {
            let amt_ref = option::borrow(&circle.target_amount);
            option::some(from_decimals(*amt_ref))
        } else {
            option::none()
        }
    }

    // USD value getters (in cents)
    public fun get_contribution_amount_usd(circle: &Circle): u64 {
        circle.usd_amounts.contribution_amount
    }

    public fun get_security_deposit_usd(circle: &Circle): u64 {
        circle.usd_amounts.security_deposit
    }

    public fun get_target_amount_usd(circle: &Circle): Option<u64> {
        circle.usd_amounts.target_amount
    }

    // ----------------------------------------------------------
    // Check if a circle is eligible for deletion by admin
    // ----------------------------------------------------------
    public fun can_delete_circle(circle: &Circle, admin_addr: address): bool {
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
        
        true
    }

    // ----------------------------------------------------------
    // Calculate next payout time based on cycle
    // ----------------------------------------------------------
    fun calculate_next_payout_time(cycle_length: u64, cycle_day: u64, current_time: u64): u64 {
        // Extract year, month, day from the timestamp
        let (year, month, day) = timestamp_to_date(current_time);
        let day_ms = get_day_ms(current_time);
        
        if (cycle_length == 0) {
            // Weekly payouts - handle future tense
            let weekday = get_weekday(current_time);
            let days_until = if (cycle_day > weekday) {
                // Selected day is later this week
                (cycle_day - weekday) as u64
            } else if (cycle_day < weekday || (cycle_day == weekday && day_ms > 0)) {
                // Selected day is earlier than today, so schedule for next week
                (DAYS_IN_WEEK - weekday + cycle_day) as u64
            } else {
                // Selected day is today with no time elapsed
                0
            };
            
            if (days_until == 0 && day_ms > 0) {
                // We're on the selected day but with time elapsed, so schedule for next week
                current_time + (MS_PER_WEEK - day_ms)
            } else {
                // Schedule for the selected day this week (if it's in the future)
                // or next week (if it's in the past)
                current_time + (days_until * MS_PER_DAY) - day_ms
            }
        } else if (cycle_length == 1) {
            // Monthly payouts - always set future date
            let mut next_month = month;
            let mut next_year = year;
            
            // If today's date is greater than the selected day, move to next month
            // This ensures we get the next occurrence of the day
            if (day > cycle_day || (day == cycle_day && day_ms > 0)) {
                next_month = month + 1;
                if (next_month > 12) {
                    next_month = 1;
                    next_year = year + 1;
                };
            };
            
            // We know cycle_day is always ≤ 28 and all months have at least 28 days
            // So we don't need to check month length anymore
            
            // Get timestamp for the target day of next month/current month (always in the future)
            date_to_timestamp(next_year, next_month, cycle_day)
        } else {
            // Quarterly payouts - always set future date
            let mut next_month = month;
            let mut next_year = year;
            
            // If today's date is greater than the selected day, move to next quarter
            if (day > cycle_day || (day == cycle_day && day_ms > 0)) {
                next_month = month + 3;
                if (next_month > 12) {
                    next_month = next_month - 12;
                    next_year = year + 1;
                };
            };
            
            // We know cycle_day is always ≤ 28 and all months have at least 28 days
            // So we don't need to check month length anymore
            
            // Get timestamp for the target day of next quarter's month (always in the future)
            date_to_timestamp(next_year, next_month, cycle_day)
        }
    }

    // Convert timestamp to (year, month, day) tuple
    #[allow(unused_assignment)]
    fun timestamp_to_date(timestamp: u64): (u64, u64, u64) {
        // Start with Unix epoch: January 1, 1970
        let mut total_days = timestamp / MS_PER_DAY;
        
        // Initial values
        let mut year = 1970;
        let mut month = 1;
        let mut day = 1; // This is used at the end, so keep it
        
        // Calculate year
        while (true) {
            let days_in_year = if (is_leap_year(year)) { 366 } else { 365 };
            if (total_days >= days_in_year) {
                total_days = total_days - days_in_year;
                year = year + 1;
            } else {
                break
            }
        };
        
        // Calculate month
        let mut month_days = vector[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (is_leap_year(year)) {
            // Update February for leap year
            let feb_days = vector::borrow_mut(&mut month_days, 1);
            *feb_days = 29;
        };
        
        while (month <= 12) {
            let days_in_month = *vector::borrow(&month_days, month - 1);
            if (total_days >= days_in_month) {
                total_days = total_days - days_in_month;
                month = month + 1;
            } else {
                break
            }
        };
        
        // Calculate day (1-based)
        day = total_days + 1;
        
        (year, month, day)
    }

    // Convert (year, month, day) to timestamp
    fun date_to_timestamp(year: u64, month: u64, day: u64): u64 {
        // Calculate days since epoch (Jan 1, 1970)
        let mut days: u64 = 0;
        
        // Add days for years
        let mut y = 1970;
        while (y < year) {
            days = days + if (is_leap_year(y)) { 366 } else { 365 };
            y = y + 1;
        };
        
        // Add days for months
        let mut month_days = vector[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (is_leap_year(year)) {
            // Update February for leap year
            let feb_days = vector::borrow_mut(&mut month_days, 1);
            *feb_days = 29;
        };
        
        let mut m = 1;
        while (m < month) {
            days = days + *vector::borrow(&month_days, m - 1);
            m = m + 1;
        };
        
        // Add days of current month
        days = days + (day - 1);
        
        // Convert to milliseconds
        days * MS_PER_DAY
    }

    // Check if a year is a leap year
    fun is_leap_year(year: u64): bool {
        if (year % 400 == 0) {
            true
        } else if (year % 100 == 0) {
            false
        } else {
            year % 4 == 0
        }
    }

    fun get_day_ms(timestamp: u64): u64 {
        timestamp % MS_PER_DAY
    }

    fun get_weekday(timestamp: u64): u64 {
        // Align Monday = 0, Sunday = 6
        // Jan 1, 1970 was a Thursday (3)
        ((timestamp / MS_PER_DAY + 3) % 7)
    }

    fun get_day_of_month(timestamp: u64): u64 {
        let (_, _, day) = timestamp_to_date(timestamp);
        day
    }

    fun get_day_of_quarter(timestamp: u64): u64 {
        let (year, month, day) = timestamp_to_date(timestamp);
        
        // Calculate first month of the quarter
        let quarter_start_month = ((month - 1) / 3) * 3 + 1;
        
        // Calculate days since start of quarter
        let mut days_since_quarter_start = 0;
        
        // Add days for full months
        let mut month_days = vector[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (is_leap_year(year)) {
            // Update February for leap year
            let feb_days = vector::borrow_mut(&mut month_days, 1);
            *feb_days = 29;
        };
        
        let mut m = quarter_start_month;
        while (m < month) {
            days_since_quarter_start = days_since_quarter_start + *vector::borrow(&month_days, m - 1);
            m = m + 1;
        };
        
        // Add days in current month
        days_since_quarter_start = days_since_quarter_start + day;
        
        days_since_quarter_start
    }

    public fun is_valid_cycle_day(cycle_length: u64, cycle_day: u64): bool {
        if (cycle_length == 0) {
            // weekly
            cycle_day < DAYS_IN_WEEK
        } else if (cycle_length == 1) {
            // monthly
            cycle_day > 0 && cycle_day <= DAYS_IN_MONTH
        } else {
            // quarterly
            cycle_day > 0 && cycle_day <= DAYS_IN_MONTH
        }
    }

    // ----------------------------------------------------------
    // Get next payout info in a more readable manner
    // ----------------------------------------------------------
    public fun get_next_payout_info(circle: &Circle): (u64, u64, u64) {
        let timestamp = circle.next_payout_time;
        let weekday = get_weekday(timestamp);
        let day =
            if (circle.cycle_length == 0) {
                weekday
            } else if (circle.cycle_length == 1) {
                get_day_of_month(timestamp)
            } else {
                get_day_of_quarter(timestamp)
            };
        
        (timestamp, weekday, day)
    }

    // ----------------------------------------------------------
    // Create default penalty rules for the circle
    // ----------------------------------------------------------
    fun create_penalty_rules(rules: vector<bool>): PenaltyRules {
        PenaltyRules {
            late_payment: *vector::borrow(&rules, 0),
            missed_meeting: *vector::borrow(&rules, 1),
            late_payment_fee: 5,
            missed_meeting_fee: 2,
            // 50 SUI penalty per warning (scaled to 9 decimals)
            warning_penalty_amount: to_decimals(50),
            allow_penalty_payments: true,
        }
    }

    // ----------------------------------------------------------
    // Admin function: update cycle if we passed payout time
    // ----------------------------------------------------------
    public fun update_cycle(
        circle: &mut Circle,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        
        let current_time = clock::timestamp_ms(clock);
        if (current_time >= circle.next_payout_time) {
            circle.current_cycle = circle.current_cycle + 1;
            circle.next_payout_time = calculate_next_payout_time(
                circle.cycle_length,
                circle.cycle_day,
                current_time
            );
        };
    }

    // ----------------------------------------------------------
    // Payout to a specific member (admin-only)
    // ----------------------------------------------------------
    public fun distribute_payout(
        circle: &mut Circle,
        recipient: address,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(table::contains(&circle.members, recipient), ENotMember);

        let member = table::borrow_mut(&mut circle.members, recipient);
        // Simple check vs code=0 (unused in snippet)
        assert!(!member.received_payout, 0);

        // total => contribution_amount * current_members
        let payout_amount = circle.contribution_amount * circle.current_members;
        assert!(balance::value(&circle.contributions) >= payout_amount, EInsufficientBalance);

        let payout_coin = coin::from_balance(
            balance::split(&mut circle.contributions, payout_amount),
            ctx
        );

        member.received_payout = true;
        transfer::public_transfer(payout_coin, recipient);
    }

    // ----------------------------------------------------------
    // Member withdraw deposit
    // ----------------------------------------------------------
    public fun withdraw_deposit(
        circle: &mut Circle,
        amount: u64,
        ctx: &mut tx_context::TxContext
    ): coin::Coin<SUI> {
        let sender = tx_context::sender(ctx);
        
        let member = table::borrow_mut(&mut circle.members, sender);
        assert!(member.deposit_balance >= amount, EInsufficientBalance);
        
        member.deposit_balance = member.deposit_balance - amount;
        
        // Split from deposits balance and return coin
        let deposit_balance = balance::split(&mut circle.deposits, amount);
        coin::from_balance(deposit_balance, ctx)
    }

    // ----------------------------------------------------------
    // Admin can issue warnings, suspend, reactivate members
    // ----------------------------------------------------------
    public fun issue_warning(
        circle: &mut Circle,
        member_addr: address,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        member.warning_count = member.warning_count + 1;
        member.last_warning_time = clock::timestamp_ms(clock);
        
        // Auto-suspend on 3 warnings
        if (member.warning_count >= 3) {
            suspend_member(circle, member_addr, clock, ctx);
        };
    }

    public fun suspend_member(
        circle: &mut Circle,
        member_addr: address,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        member.status = MEMBER_STATUS_SUSPENDED;
        member.suspension_end_time = option::some(clock::timestamp_ms(clock) + MS_PER_MONTH);
    }

    public fun reactivate_member(
        circle: &mut Circle,
        member_addr: address,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        assert!(option::is_some(&member.suspension_end_time), EMemberNotActive);
        assert!(clock::timestamp_ms(clock) >= *option::borrow(&member.suspension_end_time), EMemberSuspended);
        
        member.status = MEMBER_STATUS_ACTIVE;
        member.warning_count = 0;
        member.suspension_end_time = option::none();
    }

    // ----------------------------------------------------------
    // Member exit handling
    // ----------------------------------------------------------
    public fun request_exit(
        circle: &mut Circle,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let member = table::borrow_mut(&mut circle.members, sender);
        
        assert!(member.status == MEMBER_STATUS_ACTIVE, EMemberNotActive);
        assert!(!member.exit_requested, 0);
        
        member.exit_requested = true;
        member.exit_request_time = option::some(clock::timestamp_ms(clock));
    }

    public fun process_member_exit(
        circle: &mut Circle,
        member_addr: address,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        assert!(member.exit_requested, 0);
        assert!(
            member.total_contributed >= circle.contribution_amount * member.total_meetings_required,
            EMemberHasOutstandingObligations
        );
        
        // If good standing, return deposit
        if (member.warning_count == 0 && member.reputation_score >= 80) {
            let deposit_coin = coin::from_balance(
                balance::split(&mut circle.deposits, member.deposit_balance),
                ctx
            );
            transfer::public_transfer(deposit_coin, member_addr);
        };
        
        member.status = MEMBER_STATUS_EXITED;
    }

    // ----------------------------------------------------------
    // Reputation / Payment tracking
    // ----------------------------------------------------------
    public fun update_member_reputation(
        circle: &mut Circle,
        member_addr: address,
        attended_meeting: bool,
        on_time_payment: bool,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        if (attended_meeting) {
            member.total_meetings_attended = member.total_meetings_attended + 1;
        };
        member.total_meetings_required = member.total_meetings_required + 1;
        
        if (on_time_payment) {
            member.consecutive_on_time_payments = member.consecutive_on_time_payments + 1;
        } else {
            member.consecutive_on_time_payments = 0;
        };
        
        // Score out of 100
        let attendance_score =
            if (member.total_meetings_required == 0) { 100 }
            else {
                (member.total_meetings_attended * 100) / member.total_meetings_required
            };
        let payment_score =
            if (member.consecutive_on_time_payments >= 12) { 100 }
            else {
                (member.consecutive_on_time_payments * 100) / 12
            };
        
        member.reputation_score = ((attendance_score + payment_score) / 2) as u8;
    }

    // ----------------------------------------------------------
    // Issue warnings with penalty
    // ----------------------------------------------------------
    public fun issue_warning_with_penalty(
        circle: &mut Circle,
        member_addr: address,
        reason: vector<u8>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        member.warning_count = member.warning_count + 1;
        member.last_warning_time = clock::timestamp_ms(clock);
        
        if (circle.penalty_rules.allow_penalty_payments) {
            member.unpaid_penalties = member.unpaid_penalties + circle.penalty_rules.warning_penalty_amount;
            vector::push_back(&mut member.warnings_with_penalties, clock::timestamp_ms(clock));
        };
        
        event::emit(WarningIssued {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            warning_count: member.warning_count,
            penalty_amount: circle.penalty_rules.warning_penalty_amount,
            reason: string::utf8(reason),
        });
        
        // Auto-suspend after 3 warnings
        if (member.warning_count >= 3) {
            suspend_member(circle, member_addr, clock, ctx);
        };
    }

    public fun pay_warning_penalties(
        circle: &mut Circle,
        payment: coin::Coin<SUI>,
        warnings_to_clear: u8,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let member = table::borrow_mut(&mut circle.members, sender);
        
        assert!(member.warning_count >= warnings_to_clear, ENoWarningToClear);
        assert!(vector::length(&member.warnings_with_penalties) >= (warnings_to_clear as u64), EPenaltyAlreadyPaid);
        
        let total_penalty = circle.penalty_rules.warning_penalty_amount * (warnings_to_clear as u64);
        assert!(coin::value(&payment) >= total_penalty, EInsufficientPenaltyPayment);
        
        // Move penalty payment -> circle's penalties balance
        balance::join(&mut circle.penalties, coin::into_balance(payment));
        
        // Decrement warnings
        member.warning_count = member.warning_count - warnings_to_clear;
        member.unpaid_penalties = member.unpaid_penalties - total_penalty;
        
        // Pop from warnings vector
        let mut i = 0;
        while (i < (warnings_to_clear as u64)) {
            vector::pop_back(&mut member.warnings_with_penalties);
            i = i + 1;
        };
        
        event::emit(PenaltyPaid {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            amount: total_penalty,
            warnings_cleared: warnings_to_clear,
        });
        
        // If no more warnings & was suspended, reactivate
        if (member.warning_count == 0 && member.status == MEMBER_STATUS_SUSPENDED) {
            member.status = MEMBER_STATUS_ACTIVE;
            member.suspension_end_time = option::none();
        };
    }

    public fun get_warning_penalty_amount(circle: &Circle): u64 {
        from_decimals(circle.penalty_rules.warning_penalty_amount)
    }

    public fun get_unpaid_penalties(circle: &Circle, member_addr: address): u64 {
        let member = table::borrow(&circle.members, member_addr);
        from_decimals(member.unpaid_penalties)
    }

    // ----------------------------------------------------------
    // Treasury (payout scheduling, tracking balances)
    // ----------------------------------------------------------
    public fun process_scheduled_payout(
        circle: &mut Circle,
        recipient: address,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(table::contains(&circle.members, recipient), ENotMember);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time >= circle.next_payout_time, EInvalidPayoutSchedule);
        
        let member = table::borrow_mut(&mut circle.members, recipient);
        assert!(!member.received_payout, EPayoutAlreadyProcessed);
        
        // For "smart goal" circles, might do proportion of total. Otherwise do the normal rotational approach.
        let payout_amount = if (option::is_some(&circle.goal_type)) {
            // Proportional to how much the user contributed, relative to total in the circle
            let total_contributions = balance::value(&circle.contributions);
            (member.total_contributed * total_contributions)
            / (circle.contribution_amount * circle.current_members)
        } else {
            // Rotational
            circle.contribution_amount * circle.current_members
        };
        
        assert!(balance::value(&circle.contributions) >= payout_amount, EInsufficientTreasuryBalance);
        
        let payout_coin = coin::from_balance(
            balance::split(&mut circle.contributions, payout_amount),
            ctx
        );
        
        member.received_payout = true;
        transfer::public_transfer(payout_coin, recipient);
        
        event::emit(PayoutProcessed {
            circle_id: object::uid_to_inner(&circle.id),
            recipient,
            amount: payout_amount,
            cycle: circle.current_cycle,
            payout_type: option::get_with_default(&circle.goal_type, 0),
        });
    }

    public fun manage_treasury_balances(
        circle: &mut Circle,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        
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

    public fun process_security_deposit_return(
        circle: &mut Circle,
        member_addr: address,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        // Ensure no obligations
        assert!(
            member.total_contributed >= circle.contribution_amount * member.total_meetings_required,
            EMemberHasOutstandingObligations
        );
        
        // Possibly partial if the user has warnings or low reputation
        let returnable_amount =
            if (member.warning_count == 0 && member.reputation_score >= 80) {
                member.deposit_balance
            } else {
                (member.deposit_balance * (member.reputation_score as u64)) / 100
            };
        
        assert!(returnable_amount > 0 && returnable_amount <= member.deposit_balance, EInvalidPayoutAmount);
        assert!(balance::value(&circle.deposits) >= returnable_amount, EInsufficientTreasuryBalance);
        
        let deposit_coin = coin::from_balance(
            balance::split(&mut circle.deposits, returnable_amount),
            ctx
        );
        
        member.deposit_balance = member.deposit_balance - returnable_amount;
        transfer::public_transfer(deposit_coin, member_addr);
    }

    // ----------------------------------------------------------
    // Contribution history
    // ----------------------------------------------------------
    public fun get_member_contribution_history(
        circle: &Circle,
        member_addr: address
    ): (u64, u64, u64, u64) {
        let member = table::borrow(&circle.members, member_addr);
        (
            from_decimals(member.total_contributed),
            member.consecutive_on_time_payments,
            member.missed_payments,
            member.total_meetings_required
        )
    }

    // ----------------------------------------------------------
    // Treasury balance getters (human-friendly)
    // ----------------------------------------------------------
    public fun get_treasury_balances(circle: &Circle): (u64, u64, u64) {
        (
            from_decimals(balance::value(&circle.contributions)),
            from_decimals(balance::value(&circle.deposits)),
            from_decimals(balance::value(&circle.penalties))
        )
    }

    // ----------------------------------------------------------
    // Eligibility check
    // ----------------------------------------------------------
    public fun is_eligible_for_payout(
        circle: &Circle,
        member_addr: address,
        clock: &clock::Clock
    ): bool {
        if (!table::contains(&circle.members, member_addr)) {
            return false
        };
        let member = table::borrow(&circle.members, member_addr);
        
        member.status == MEMBER_STATUS_ACTIVE
        && !member.received_payout
        && member.total_contributed >= circle.contribution_amount
        && option::is_none(&member.suspension_end_time)
        && clock::timestamp_ms(clock) >= circle.next_payout_time
    }

    // ----------------------------------------------------------
    // Rotation management
    // ----------------------------------------------------------
    public fun set_rotation_position(
        circle: &mut Circle,
        member_addr: address,
        position: u64,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(position < circle.max_members, EInvalidRotationPosition);
        assert!(table::contains(&circle.members, member_addr), ENotMember);
        
        let current_size = vector::length(&circle.rotation_order);
        if (position >= current_size) {
            // fill gap with 0x0 addresses
            while (vector::length(&circle.rotation_order) < position) {
                vector::push_back(&mut circle.rotation_order, @0x0);
            };
            vector::push_back(&mut circle.rotation_order, member_addr);
        } else {
            // Must be empty
            assert!(vector::borrow(&circle.rotation_order, position) == &(@0x0), EPositionAlreadyTaken);
            *vector::borrow_mut(&mut circle.rotation_order, position) = member_addr;
        };
        
        let member = table::borrow_mut(&mut circle.members, member_addr);
        member.payout_position = option::some(position);
    }

    // ----------------------------------------------------------
    // Auction management
    // ----------------------------------------------------------
    public fun start_position_auction(
        circle: &mut Circle,
        position: u64,
        minimum_bid: u64,
        duration_days: u64,
        discount_rate: u64,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        // If the `active_auction` is `Some`, we interpret that as an auction in progress
        assert!(option::is_none(&circle.active_auction), EAuctionNotActive);
        
        let start_time = clock::timestamp_ms(clock);
        let end_time = start_time + (duration_days * MS_PER_DAY);
        
        let auction = Auction {
            position,
            minimum_bid: to_decimals(minimum_bid),
            highest_bid: 0,
            highest_bidder: option::none(),
            start_time,
            end_time,
            discount_rate,
        };
        
        circle.active_auction = option::some(auction);
        
        event::emit(AuctionStarted {
            circle_id: object::uid_to_inner(&circle.id),
            position,
            minimum_bid: to_decimals(minimum_bid),
            end_time,
        });
    }

    public fun place_bid(
        circle: &mut Circle,
        bid: coin::Coin<SUI>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(option::is_some(&circle.active_auction), EAuctionNotActive);
        let auction = option::borrow_mut(&mut circle.active_auction);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= auction.end_time, EAuctionNotActive);
        
        let bid_amount = coin::value(&bid);
        assert!(bid_amount > auction.highest_bid, EInvalidBidAmount);
        
        // If there's a previous highest bidder, refund them
        if (option::is_some(&auction.highest_bidder)) {
            let prev_bidder = *option::borrow(&auction.highest_bidder);
            let refund = balance::split(&mut circle.contributions, auction.highest_bid);
            let refund_coin = coin::from_balance(refund, ctx);
            transfer::public_transfer(refund_coin, prev_bidder);
        };
        
        // Update auction state
        auction.highest_bid = bid_amount;
        auction.highest_bidder = option::some(tx_context::sender(ctx));
        
        // Auction proceeds are placed in the circle's contributions
        balance::join(&mut circle.contributions, coin::into_balance(bid));
        
        event::emit(BidPlaced {
            circle_id: object::uid_to_inner(&circle.id),
            bidder: tx_context::sender(ctx),
            amount: bid_amount,
            position: auction.position,
        });
    }

    public fun complete_auction(
        circle: &mut Circle,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(option::is_some(&circle.active_auction), EAuctionNotActive);
        
        let auction = option::extract(&mut circle.active_auction);
        assert!(clock::timestamp_ms(clock) > auction.end_time, EAuctionNotActive);
        
        if (option::is_some(&auction.highest_bidder)) {
            let winner = *option::borrow(&auction.highest_bidder);
            set_rotation_position(circle, winner, auction.position, ctx);
            
            event::emit(AuctionCompleted {
                circle_id: object::uid_to_inner(&circle.id),
                winner,
                position: auction.position,
                winning_bid: auction.highest_bid,
            });
        };
    }

    // ----------------------------------------------------------
    // Smart goal / Milestone management
    // ----------------------------------------------------------
    public fun add_monetary_milestone(
        circle: &mut Circle,
        target_amount: u64,
        deadline: u64,
        description: vector<u8>,
        prerequisites: vector<u64>,
        verification_requirements: vector<u8>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(option::is_some(&circle.goal_type), EInvalidMilestone);
        assert!(target_amount > 0, EMilestoneTargetInvalid);
        
        let total_milestones = vector::length(&circle.milestones);
        let mut i = 0;
        let prereq_len = vector::length(&prerequisites);
        while (i < prereq_len) {
            let prereq_num = *vector::borrow(&prerequisites, i);
            assert!(prereq_num < total_milestones, EMilestonePrerequisiteNotMet);
            i = i + 1;
        };
        
        let milestone = Milestone {
            milestone_type: MILESTONE_TYPE_MONETARY,
            target_amount: option::some(to_decimals(target_amount)),
            target_duration: option::none(),
            start_time: clock::timestamp_ms(clock),
            deadline,
            completed: false,
            verified_by: option::none(),
            completion_time: option::none(),
            description: string::utf8(description),
            prerequisites,
            verification_requirements,
            verification_proofs: vector::empty(),
        };
        
        vector::push_back(&mut circle.milestones, milestone);
    }

    public fun add_time_milestone(
        circle: &mut Circle,
        duration_days: u64,
        deadline: u64,
        description: vector<u8>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(option::is_some(&circle.goal_type), EInvalidMilestone);
        assert!(duration_days > 0, EMilestoneTargetInvalid);
        
        let milestone = Milestone {
            milestone_type: MILESTONE_TYPE_TIME,
            target_amount: option::none(),
            target_duration: option::some(duration_days * MS_PER_DAY),
            start_time: clock::timestamp_ms(clock),
            deadline,
            completed: false,
            verified_by: option::none(),
            completion_time: option::none(),
            description: string::utf8(description),
            prerequisites: vector::empty(),
            verification_requirements: vector::empty(),
            verification_proofs: vector::empty(),
        };
        
        vector::push_back(&mut circle.milestones, milestone);
    }

    public fun verify_milestone(
        circle: &mut Circle,
        milestone_number: u64,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(milestone_number < vector::length(&circle.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow_mut(&mut circle.milestones, milestone_number);
        assert!(!milestone.completed, EMilestoneAlreadyVerified);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= milestone.deadline, EMilestoneDeadlinePassed);
        
        // Based on milestone type
        if (milestone.milestone_type == MILESTONE_TYPE_MONETARY) {
            let target = *option::borrow(&milestone.target_amount);
            assert!(balance::value(&circle.contributions) >= target, EMilestoneTargetInvalid);
        } else if (milestone.milestone_type == MILESTONE_TYPE_TIME) {
            let target_duration = *option::borrow(&milestone.target_duration);
            let elapsed_time = current_time - milestone.start_time;
            assert!(elapsed_time >= target_duration, EMilestoneTargetInvalid);
        } else {
            abort EMilestoneTypeInvalid
        };
        
        // Check that we have enough proofs for each requirement
        assert!(
            vector::length(&milestone.verification_proofs) 
            >= vector::length(&milestone.verification_requirements),
            EMilestoneVerificationFailed
        );
        
        milestone.completed = true;
        milestone.verified_by = option::some(tx_context::sender(ctx));
        milestone.completion_time = option::some(current_time);
        
        // If it's a monetary milestone, add to circle.goal_progress
        if (milestone.milestone_type == MILESTONE_TYPE_MONETARY) {
            circle.goal_progress = circle.goal_progress + *option::borrow(&milestone.target_amount);
        };
        circle.last_milestone_completed = milestone_number;
        
        event::emit(MilestoneCompleted {
            circle_id: object::uid_to_inner(&circle.id),
            milestone_number,
            verified_by: tx_context::sender(ctx),
            amount_achieved: option::get_with_default(&milestone.target_amount, 0),
        });
    }

    public fun submit_milestone_verification(
        circle: &mut Circle,
        milestone_number: u64,
        proof: vector<u8>,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        assert!(milestone_number < vector::length(&circle.milestones), EInvalidMilestone);
        
        // First verify prerequisites are completed
        {
            let mut i = 0;
            let prereq_len = vector::length(&vector::borrow(&circle.milestones, milestone_number).prerequisites);
            while (i < prereq_len) {
                let prereq_num = *vector::borrow(&vector::borrow(&circle.milestones, milestone_number).prerequisites, i);
                assert!(
                    vector::borrow(&circle.milestones, prereq_num).completed,
                    EMilestonePrerequisiteNotMet
                );
                i = i + 1;
            };
        };

        let milestone = vector::borrow_mut(&mut circle.milestones, milestone_number);
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= milestone.deadline, EMilestoneDeadlinePassed);
        
        vector::push_back(&mut milestone.verification_proofs, proof);
        
        // Each new proof triggers an event
        let proof_index = vector::length(&milestone.verification_proofs) - 1;
        let proof_type = *vector::borrow(&milestone.verification_requirements, proof_index);
        
        event::emit(MilestoneVerificationSubmitted {
            circle_id: object::uid_to_inner(&circle.id),
            milestone_number,
            submitted_by: tx_context::sender(ctx),
            proof_type,
            timestamp: current_time,
        });
    }

    // ----------------------------------------------------------
    // Milestone info
    // ----------------------------------------------------------
    public fun get_milestone_info(
        circle: &Circle,
        milestone_number: u64
    ): (u8, option::Option<u64>, option::Option<u64>, u64, u64, bool, string::String) {
        assert!(milestone_number < vector::length(&circle.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow(&circle.milestones, milestone_number);

        let adjusted_target_amount = if (option::is_some(&milestone.target_amount)) {
            let amt_ref = option::borrow(&milestone.target_amount);
            option::some(from_decimals(*amt_ref))
        } else {
            option::none()
        };

        let adjusted_target_duration = if (option::is_some(&milestone.target_duration)) {
            let dur_ref = option::borrow(&milestone.target_duration);
            option::some(*dur_ref / MS_PER_DAY)
        } else {
            option::none()
        };

        (
            milestone.milestone_type,
            adjusted_target_amount,
            adjusted_target_duration,
            milestone.start_time,
            milestone.deadline,
            milestone.completed,
            milestone.description
        )
    }

    // ----------------------------------------------------------
    // Milestone progress (single implementation)
    // ----------------------------------------------------------
    public fun get_milestone_progress(circle: &Circle): (u64, u64, u64, u64) {
        let total_monetary_progress = from_decimals(circle.goal_progress);
        let total_milestones = vector::length(&circle.milestones);
        let completed_milestones = get_completed_milestone_count(circle);
        
        (
            total_monetary_progress,
            total_milestones,
            completed_milestones,
            circle.last_milestone_completed
        )
    }

    fun get_completed_milestone_count(circle: &Circle): u64 {
        let mut count = 0;
        let mut i = 0;
        let total = vector::length(&circle.milestones);
        
        while (i < total) {
            if (vector::borrow(&circle.milestones, i).completed) {
                count = count + 1;
            };
            i = i + 1;
        };
        count
    }

    // ----------------------------------------------------------
    // Rotation order
    // ----------------------------------------------------------
    public fun get_rotation_order(circle: &Circle): vector<address> {
        circle.rotation_order
    }

    // ----------------------------------------------------------
    // Delete Circle
    // ----------------------------------------------------------
    public entry fun delete_circle(
        mut circle: Circle,
        ctx: &mut tx_context::TxContext
    ) {
        // Only admin can delete the circle
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        
        // Ensure there are no members other than the admin (current_members starts from 0)
        assert!(circle.current_members <= 1, ECircleHasActiveMembers);
        
        // Ensure no money has been contributed
        assert!(balance::value(&circle.contributions) == 0, ECircleHasContributions);
        
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
        
        // Emit event for circle deletion
        event::emit(CircleDeleted {
            circle_id: object::uid_to_inner(&circle.id),
            admin: circle.admin,
            name: circle.name,
        });
        
        // In Sui, we can directly delete a shared object if we have it by value
        // First, extract and destroy all balances if any remain
        let Circle { 
            id,
            name: _,
            admin: _,
            contribution_amount: _,
            security_deposit: _,
            cycle_length: _,
            cycle_day: _,
            circle_type: _,
            rotation_style: _,
            max_members: _,
            current_members: _,
            members,
            contributions,
            deposits,
            penalties,
            current_cycle: _,
            next_payout_time: _,
            goal_type: _,
            target_amount: _,
            target_date: _,
            verification_required: _,
            penalty_rules,
            created_at: _,
            rotation_order: _,
            rotation_history: _,
            current_position: _,
            active_auction: _,
            milestones,
            goal_progress: _,
            last_milestone_completed: _,
            usd_amounts,
        } = circle;
        
        // Need to consume these values since they're not droppable
        let _ = penalty_rules;
        let _ = milestones;
        let _ = usd_amounts;
        
        // Destroy balances and tables
        balance::destroy_zero(contributions);
        balance::destroy_zero(deposits);
        balance::destroy_zero(penalties);
        table::drop(members);
        
        // Delete the object
        object::delete(id);
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
        let rotation_members = get_rotation_order(circle);
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
        let sample_addrs = get_sample_addresses();
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
    // Get members with specific status in a circle
    // ----------------------------------------------------------
    public fun get_members_by_status(circle: &Circle, status: u8): vector<address> {
        let all_members = get_circle_members(circle);
        let mut filtered_members = vector::empty<address>();
        
        let mut i = 0;
        let len = vector::length(&all_members);
        
        while (i < len) {
            let addr = *vector::borrow(&all_members, i);
            let member = table::borrow(&circle.members, addr);
            if (member.status == status) {
                vector::push_back(&mut filtered_members, addr);
            };
            i = i + 1;
        };
        
        filtered_members
    }
    
    // ----------------------------------------------------------
    // Get active members in a circle
    // ----------------------------------------------------------
    public fun get_active_members(circle: &Circle): vector<address> {
        get_members_by_status(circle, MEMBER_STATUS_ACTIVE)
    }
    
    // ----------------------------------------------------------
    // Get pending members in a circle
    // ----------------------------------------------------------
    public fun get_pending_members(circle: &Circle): vector<address> {
        get_members_by_status(circle, MEMBER_STATUS_PENDING)
    }

    // ----------------------------------------------------------
    // Helper function to get sample addresses for checking
    // Since we cannot iterate over table keys
    // ----------------------------------------------------------
    fun get_sample_addresses(): vector<address> {
        let mut addrs = vector::empty<address>();
        
        // In a real implementation, we would need a better approach
        // This is a simplified mock for demonstration purposes
        vector::push_back(&mut addrs, @0x1);
        
        addrs
    }
}
