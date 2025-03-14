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

    // Time constants (all in milliseconds)
    const MS_PER_DAY: u64 = 86_400_000;       // 24 * 60 * 60 * 1000
    const MS_PER_WEEK: u64 = 604_800_000;     // 7  * 24 * 60 * 60 * 1000
    const MS_PER_MONTH: u64 = 2_419_200_000;   // 28 * 24 * 60 * 60 * 1000
    const MS_PER_QUARTER: u64 = 7_776_000_000; // 90 * 24 * 60 * 60 * 1000

    // Day constants (as u64 for consistent % operations)
    const DAYS_IN_WEEK: u64 = 7;
    const DAYS_IN_MONTH: u64 = 28;
    const DAYS_IN_QUARTER: u64 = 90;

    // Member status constants
    const MEMBER_STATUS_ACTIVE: u8 = 0;
    const MEMBER_STATUS_SUSPENDED: u8 = 2;
    const MEMBER_STATUS_EXITED: u8 = 3;

    // Milestone type constants
    const MILESTONE_TYPE_MONETARY: u8 = 0;
    const MILESTONE_TYPE_TIME: u8 = 1;

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

    // ----------------------------------------------------------
    // Create Circle
    // ----------------------------------------------------------
    public fun create_circle(
        name: vector<u8>,
        contribution_amount: u64,
        security_deposit: u64,
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        max_members: u64,
        rotation_style: u8,
        penalty_rules: vector<bool>,
        goal_type: option::Option<u8>,
        target_amount: option::Option<u64>,
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
        };

        event::emit(CircleCreated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: tx_context::sender(ctx),
            name: string::utf8(name),
            contribution_amount: contribution_amount_scaled,
            max_members,
            cycle_length,
        });

        // Make the newly created `Circle` object shared
        transfer::share_object(circle);
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
        let day_ms = get_day_ms(current_time);
        let weekday = get_weekday(current_time);
        
        if (cycle_length == 0) {
            // Weekly
            let days_until = if (cycle_day > weekday) {
                (cycle_day - weekday) as u64
            } else if (cycle_day < weekday || (cycle_day == weekday && day_ms > 0)) {
                (DAYS_IN_WEEK - weekday + cycle_day) as u64
            } else {
                0
            };
            
            if (days_until == 0 && day_ms > 0) {
                current_time + (MS_PER_WEEK - day_ms)
            } else {
                current_time + (days_until * MS_PER_DAY) - day_ms
            }
        } else if (cycle_length == 1) {
            // Monthly
            let current_day = get_day_of_month(current_time);
            let days_until = if (cycle_day > current_day) {
                (cycle_day - current_day) as u64
            } else if (cycle_day < current_day || (cycle_day == current_day && day_ms > 0)) {
                (DAYS_IN_MONTH - current_day + cycle_day) as u64
            } else {
                0
            };
            
            if (days_until == 0 && day_ms > 0) {
                current_time + (MS_PER_MONTH - day_ms)
            } else {
                current_time + (days_until * MS_PER_DAY) - day_ms
            }
        } else {
            // Quarterly
            let current_day = get_day_of_quarter(current_time);
            let days_until = if (cycle_day > current_day) {
                (cycle_day - current_day) as u64
            } else if (cycle_day < current_day || (cycle_day == current_day && day_ms > 0)) {
                (DAYS_IN_QUARTER - current_day + cycle_day) as u64
            } else {
                0
            };
            
            if (days_until == 0 && day_ms > 0) {
                current_time + (MS_PER_QUARTER - day_ms)
            } else {
                current_time + (days_until * MS_PER_DAY) - day_ms
            }
        }
    }

    fun get_day_ms(timestamp: u64): u64 {
        timestamp % MS_PER_DAY
    }

    fun get_weekday(timestamp: u64): u64 {
        // Align Monday = 0
        ((timestamp / MS_PER_DAY + 3) % 7)
    }

    fun get_day_of_month(timestamp: u64): u64 {
        ((timestamp / MS_PER_DAY) % DAYS_IN_MONTH + 1)
    }

    fun get_day_of_quarter(timestamp: u64): u64 {
        ((timestamp / MS_PER_DAY) % DAYS_IN_QUARTER + 1)
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
        } = circle;
        
        // Need to consume these values since they're not droppable
        let _ = penalty_rules;
        let _ = milestones;
        
        // Destroy balances and tables
        balance::destroy_zero(contributions);
        balance::destroy_zero(deposits);
        balance::destroy_zero(penalties);
        table::drop(members);
        
        // Delete the object
        object::delete(id);
    }
}
