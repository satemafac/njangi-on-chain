module njangi::njangi_circle {
    use sui::object::{Self, ID, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::balance::{Self, Balance};
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::event;
    use std::string::{Self, String};
    use std::vector;
    use std::option::{Self, Option};

    // Update USDC import
    #[test_only]
    use sui::test_scenario;

    // Import USDC from testnet - using correct path
    use 0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC;

    // For testnet deployment uncomment:
    // use 0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC;
    // For mainnet deployment uncomment:
    // use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;

    // ======== Constants ========
    const MIN_MEMBERS: u64 = 3;
    const MAX_MEMBERS: u64 = 20;
    
    // USDC specific constants
    const USDC_DECIMALS: u8 = 6;
    const DECIMAL_SCALING: u64 = 1000000; // 10^6 for USDC decimals
    
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
    const EInvalidGoalAmount: u64 = 9;
    const EInvalidTargetDate: u64 = 10;
    const EInvalidUSDCAmount: u64 = 11;
    const EInsufficientBalance: u64 = 12;
    const EMemberSuspended: u64 = 13;
    const EMemberNotActive: u64 = 14;
    const EInvalidWarningCount: u64 = 15;
    const EInvalidReputation: u64 = 16;
    const EMemberAlreadyExists: u64 = 17;
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

    // Time constants for Sui clock (all in milliseconds)
    const MS_PER_DAY: u64 = 86400000; // 24 * 60 * 60 * 1000
    const MS_PER_WEEK: u64 = 604800000; // 7 * 24 * 60 * 60 * 1000
    const MS_PER_MONTH: u64 = 2419200000; // 28 * 24 * 60 * 60 * 1000
    const MS_PER_QUARTER: u64 = 7776000000; // 90 * 24 * 60 * 60 * 1000

    // Day constants
    const DAYS_IN_WEEK: u8 = 7;
    const DAYS_IN_MONTH: u8 = 28;
    const DAYS_IN_QUARTER: u8 = 90;

    // Add member status constants
    const MEMBER_STATUS_ACTIVE: u8 = 0;
    const MEMBER_STATUS_WARNING: u8 = 1;
    const MEMBER_STATUS_SUSPENDED: u8 = 2;
    const MEMBER_STATUS_EXITED: u8 = 3;

    // Add circle type constants
    const CIRCLE_TYPE_ROTATIONAL: u8 = 0;
    const CIRCLE_TYPE_SMART_GOAL: u8 = 1;
    const CIRCLE_TYPE_AUCTION: u8 = 2;

    // Add milestone type constants
    const MILESTONE_TYPE_MONETARY: u8 = 0;
    const MILESTONE_TYPE_TIME: u8 = 1;

    // ======== Helper Functions for USDC Decimal Handling ========
    fun to_decimals(amount: u64): u64 {
        amount * DECIMAL_SCALING
    }

    fun from_decimals(amount: u64): u64 {
        amount / DECIMAL_SCALING
    }

    // ======== Types ========
    struct Circle has key {
        id: UID,
        name: String,
        admin: address,
        contribution_amount: u64, // Stored in USDC decimals (6)
        security_deposit: u64,    // Stored in USDC decimals (6)
        cycle_length: u8,
        cycle_day: u8,
        circle_type: u8,
        rotation_style: u8,
        max_members: u64,
        current_members: u64,
        members: Table<address, Member>,
        contributions: Balance<USDC>,
        deposits: Balance<USDC>,
        penalties: Balance<USDC>,
        current_cycle: u64,
        next_payout_time: u64,
        goal_type: Option<u8>,
        target_amount: Option<u64>, // Stored in USDC decimals (6)
        target_date: Option<u64>,
        verification_required: bool,
        penalty_rules: PenaltyRules,
        created_at: u64,
        rotation_order: vector<address>,
        rotation_history: vector<address>,
        current_position: u64,
        active_auction: Option<Auction>,
        milestones: vector<Milestone>,
        goal_progress: u64,
        last_milestone_completed: u64,
    }

    struct Member has store {
        joined_at: u64,
        last_contribution: u64,
        total_contributed: u64,
        received_payout: bool,
        payout_position: Option<u64>,
        deposit_balance: u64,
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
        unpaid_penalties: u64,
        warnings_with_penalties: vector<u64>, // Timestamps of warnings with unpaid penalties
    }

    struct PenaltyRules has store {
        late_payment: bool,
        missed_meeting: bool,
        late_payment_fee: u64,
        missed_meeting_fee: u64,
        warning_penalty_amount: u64,  // Amount in USDC decimals
        allow_penalty_payments: bool,
    }

    // ======== Events ========
    struct CircleCreated has copy, drop {
        circle_id: ID,
        admin: address,
        name: String,
        contribution_amount: u64,
        max_members: u64,
        cycle_length: u8,
    }

    struct MemberJoined has copy, drop {
        circle_id: ID,
        member: address,
        position: Option<u64>,
    }

    struct ContributionMade has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        cycle: u64,
    }

    struct WarningIssued has copy, drop {
        circle_id: ID,
        member: address,
        warning_count: u8,
        penalty_amount: u64,
        reason: String,
    }

    struct PenaltyPaid has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        warnings_cleared: u8,
    }

    struct PayoutProcessed has copy, drop {
        circle_id: ID,
        recipient: address,
        amount: u64,
        cycle: u64,
        payout_type: u8,
    }

    struct TreasuryUpdated has copy, drop {
        circle_id: ID,
        contributions_balance: u64,
        deposits_balance: u64,
        penalties_balance: u64,
        cycle: u64,
    }

    // Add new events
    struct AuctionStarted has copy, drop {
        circle_id: ID,
        position: u64,
        minimum_bid: u64,
        end_time: u64,
    }

    struct BidPlaced has copy, drop {
        circle_id: ID,
        bidder: address,
        amount: u64,
        position: u64,
    }

    struct AuctionCompleted has copy, drop {
        circle_id: ID,
        winner: address,
        position: u64,
        winning_bid: u64,
    }

    struct MilestoneCompleted has copy, drop {
        circle_id: ID,
        milestone_number: u64,
        verified_by: address,
        amount_achieved: u64,
    }

    // Add new types for auction and milestone tracking
    struct Auction has store {
        position: u64,
        minimum_bid: u64,
        highest_bid: u64,
        highest_bidder: Option<address>,
        start_time: u64,
        end_time: u64,
        discount_rate: u64,
    }

    struct Milestone has store {
        milestone_type: u8,
        target_amount: Option<u64>,    // For monetary milestones (in USDC decimals)
        target_duration: Option<u64>,  // For time-based milestones (in milliseconds)
        start_time: u64,
        deadline: u64,
        completed: bool,
        verified_by: Option<address>,
        completion_time: Option<u64>,
        description: String,
        prerequisites: vector<u64>,    // Milestone numbers that must be completed first
        verification_requirements: vector<u8>, // Custom verification requirements
        verification_proofs: vector<vector<u8>>, // Proofs submitted for verification
    }

    // Add milestone verification event
    struct MilestoneVerificationSubmitted has copy, drop {
        circle_id: ID,
        milestone_number: u64,
        submitted_by: address,
        proof_type: u8,
        timestamp: u64,
    }

    // ======== Public Functions ========
    public fun create_circle(
        name: vector<u8>,
        contribution_amount: u64, // Input in whole USDC (will be converted to decimals)
        security_deposit: u64,    // Input in whole USDC (will be converted to decimals)
        cycle_length: u8,
        cycle_day: u8,
        circle_type: u8,
        max_members: u64,
        rotation_style: u8,
        penalty_rules: vector<bool>,
        goal_type: Option<u8>,
        target_amount: Option<u64>, // Input in whole USDC (will be converted to decimals)
        target_date: Option<u64>,
        verification_required: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Convert amounts to USDC decimals
        let contribution_amount_scaled = to_decimals(contribution_amount);
        let security_deposit_scaled = to_decimals(security_deposit);
        let target_amount_scaled = option::map(target_amount, |amount| to_decimals(*amount));

        // Validate inputs
        assert!(max_members >= MIN_MEMBERS && max_members <= MAX_MEMBERS, EInvalidMemberCount);
        assert!(contribution_amount_scaled > 0, EInvalidContributionAmount);
        assert!(security_deposit_scaled >= (contribution_amount_scaled / 2), EInvalidSecurityDeposit);
        assert!(cycle_length <= 2, EInvalidCycleLength);
        assert!(
            (cycle_length == 0 && cycle_day < 7) ||
            (cycle_length > 0 && cycle_day < 28),
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
            contributions: balance::zero<USDC>(),
            deposits: balance::zero<USDC>(),
            penalties: balance::zero<USDC>(),
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

        transfer::share_object(circle);
    }

    public fun join_circle(
        circle: &mut Circle,
        deposit: Coin<USDC>,
        position: Option<u64>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Validate join conditions with decimal-aware comparison
        assert!(circle.current_members < circle.max_members, ECircleFull);
        assert!(coin::value(&deposit) >= circle.security_deposit, EInsufficientDeposit);

        // Create new member with decimal-aware balance
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

        // Add member to circle
        table::add(&mut circle.members, sender, member);
        circle.current_members = circle.current_members + 1;

        // Add deposit to circle's deposit balance
        balance::join(&mut circle.deposits, coin::into_balance(deposit));

        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            position,
        });
    }

    public fun contribute(
        circle: &mut Circle,
        payment: Coin<USDC>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Verify member and payment amount with decimal-aware comparison
        assert!(table::contains(&circle.members, sender), ENotMember);
        assert!(coin::value(&payment) >= circle.contribution_amount, EInvalidContributionAmount);

        let member = table::borrow(&circle.members, sender);
        assert!(member.status == MEMBER_STATUS_ACTIVE, EMemberNotActive);
        assert!(option::is_none(&member.suspension_end_time), EMemberSuspended);

        // Update member's contribution record with decimal-aware amounts
        let member_mut = table::borrow_mut(&mut circle.members, sender);
        member_mut.last_contribution = clock::timestamp_ms(clock);
        member_mut.total_contributed = member_mut.total_contributed + circle.contribution_amount;

        // Add contribution to circle's balance
        balance::join(&mut circle.contributions, coin::into_balance(payment));

        event::emit(ContributionMade {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            amount: circle.contribution_amount,
            cycle: circle.current_cycle,
        });
    }

    // Add function to get human-readable amounts
    public fun get_contribution_amount(circle: &Circle): u64 {
        from_decimals(circle.contribution_amount)
    }

    public fun get_security_deposit(circle: &Circle): u64 {
        from_decimals(circle.security_deposit)
    }

    public fun get_target_amount(circle: &Circle): Option<u64> {
        option::map(circle.target_amount, |amount| from_decimals(*amount))
    }

    // ======== Helper Functions ========
    fun calculate_next_payout_time(cycle_length: u8, cycle_day: u8, current_time: u64): u64 {
        let day_ms = get_day_ms(current_time);
        let weekday = get_weekday(current_time);
        
        if (cycle_length == 0) {
            // Weekly cycle
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
            // Monthly cycle
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
            // Quarterly cycle
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

    // Time helper functions using Sui clock
    fun get_day_ms(timestamp: u64): u64 {
        timestamp % MS_PER_DAY
    }

    fun get_weekday(timestamp: u64): u8 {
        // Convert to days since epoch and align with Monday = 0
        ((timestamp / MS_PER_DAY + 3) % 7) as u8
    }

    fun get_day_of_month(timestamp: u64): u8 {
        ((timestamp / MS_PER_DAY) % DAYS_IN_MONTH as u64 + 1) as u8
    }

    fun get_day_of_quarter(timestamp: u64): u8 {
        ((timestamp / MS_PER_DAY) % DAYS_IN_QUARTER as u64 + 1) as u8
    }

    // Helper function to validate cycle day
    public fun is_valid_cycle_day(cycle_length: u8, cycle_day: u8): bool {
        if (cycle_length == 0) {
            // Weekly: 0-6 (Monday to Sunday)
            cycle_day < DAYS_IN_WEEK
        } else if (cycle_length == 1) {
            // Monthly: 1-28
            cycle_day > 0 && cycle_day <= DAYS_IN_MONTH
        } else {
            // Quarterly: 1-28 (mapped to each quarter)
            cycle_day > 0 && cycle_day <= DAYS_IN_MONTH
        }
    }

    // Add function to get next payout timestamp in human readable format
    public fun get_next_payout_info(circle: &Circle): (u64, u8, u8) {
        let timestamp = circle.next_payout_time;
        let weekday = get_weekday(timestamp);
        let day = if (circle.cycle_length == 0) {
            weekday
        } else if (circle.cycle_length == 1) {
            get_day_of_month(timestamp)
        } else {
            get_day_of_quarter(timestamp)
        };
        
        (timestamp, weekday, day)
    }

    fun create_penalty_rules(rules: vector<bool>): PenaltyRules {
        PenaltyRules {
            late_payment: *vector::borrow(&rules, 0),
            missed_meeting: *vector::borrow(&rules, 1),
            late_payment_fee: 5,
            missed_meeting_fee: 2,
            warning_penalty_amount: to_decimals(50), // 50 USDC penalty per warning
            allow_penalty_payments: true,
        }
    }

    // ======== Admin Functions ========
    public fun update_cycle(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
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

    // Modified payout function with decimal handling
    public fun distribute_payout(
        circle: &mut Circle,
        recipient: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(table::contains(&circle.members, recipient), ENotMember);

        let member = table::borrow_mut(&mut circle.members, recipient);
        assert!(!member.received_payout, 0);

        // Calculate payout with decimal-aware arithmetic
        let payout_amount = circle.contribution_amount * circle.current_members;
        assert!(balance::value(&circle.contributions) >= payout_amount, EInsufficientBalance);

        let payout_coin = coin::from_balance(
            balance::split(&mut circle.contributions, payout_amount),
            ctx
        );

        member.received_payout = true;
        transfer::public_transfer(payout_coin, recipient);
    }

    // Modified withdrawal function with decimal handling
    public fun withdraw_deposit(
        circle: &mut Circle,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&circle.members, sender), ENotMember);

        let member = table::borrow_mut(&mut circle.members, sender);
        let deposit_amount = member.deposit_balance;
        assert!(deposit_amount > 0, 0);
        assert!(balance::value(&circle.deposits) >= deposit_amount, EInsufficientBalance);

        member.deposit_balance = 0;

        let deposit_coin = coin::from_balance(
            balance::split(&mut circle.deposits, deposit_amount),
            ctx
        );

        transfer::public_transfer(deposit_coin, sender);
    }

    // Member Management Functions
    public fun issue_warning(
        circle: &mut Circle,
        member_addr: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        member.warning_count = member.warning_count + 1;
        member.last_warning_time = clock::timestamp_ms(clock);
        
        if (member.warning_count >= 3) {
            suspend_member(circle, member_addr, clock, ctx);
        };
    }

    public fun suspend_member(
        circle: &mut Circle,
        member_addr: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        member.status = MEMBER_STATUS_SUSPENDED;
        member.suspension_end_time = option::some(clock::timestamp_ms(clock) + MS_PER_MONTH);
    }

    public fun reactivate_member(
        circle: &mut Circle,
        member_addr: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        assert!(option::is_some(&member.suspension_end_time), EMemberNotActive);
        assert!(clock::timestamp_ms(clock) >= *option::borrow(&member.suspension_end_time), EMemberSuspended);
        
        member.status = MEMBER_STATUS_ACTIVE;
        member.warning_count = 0;
        member.suspension_end_time = option::none();
    }

    public fun request_exit(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
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
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        assert!(member.exit_requested, 0);
        assert!(member.total_contributed >= circle.contribution_amount * member.total_meetings_required, EMemberHasOutstandingObligations);
        
        // Return security deposit if member has good standing
        if (member.warning_count == 0 && member.reputation_score >= 80) {
            let deposit_coin = coin::from_balance(
                balance::split(&mut circle.deposits, member.deposit_balance),
                ctx
            );
            transfer::public_transfer(deposit_coin, member_addr);
        };
        
        member.status = MEMBER_STATUS_EXITED;
    }

    public fun update_member_reputation(
        circle: &mut Circle,
        member_addr: address,
        attended_meeting: bool,
        on_time_payment: bool,
        ctx: &mut TxContext
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
        
        // Calculate reputation score (0-100)
        let attendance_score = if (member.total_meetings_required == 0) { 100 } 
            else { (member.total_meetings_attended * 100) / member.total_meetings_required };
        let payment_score = if (member.consecutive_on_time_payments >= 12) { 100 }
            else { (member.consecutive_on_time_payments * 100) / 12 };
        
        member.reputation_score = ((attendance_score + payment_score) / 2) as u8;
    }

    // Add new functions for warning penalties
    public fun issue_warning_with_penalty(
        circle: &mut Circle,
        member_addr: address,
        reason: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
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
        
        if (member.warning_count >= 3) {
            suspend_member(circle, member_addr, clock, ctx);
        };
    }

    public fun pay_warning_penalties(
        circle: &mut Circle,
        payment: Coin<USDC>,
        warnings_to_clear: u8,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let member = table::borrow_mut(&mut circle.members, sender);
        
        assert!(member.warning_count > 0 && member.warning_count >= warnings_to_clear, ENoWarningToClear);
        assert!(vector::length(&member.warnings_with_penalties) >= (warnings_to_clear as u64), EPenaltyAlreadyPaid);
        
        let total_penalty = circle.penalty_rules.warning_penalty_amount * (warnings_to_clear as u64);
        assert!(coin::value(&payment) >= total_penalty, EInsufficientPenaltyPayment);
        
        // Add penalty payment to circle's penalty balance
        balance::join(&mut circle.penalties, coin::into_balance(payment));
        
        // Clear warnings
        member.warning_count = member.warning_count - warnings_to_clear;
        member.unpaid_penalties = member.unpaid_penalties - total_penalty;
        
        // Remove paid warnings from the penalties vector
        let i = 0;
        while (i < warnings_to_clear) {
            vector::pop_back(&mut member.warnings_with_penalties);
            i = i + 1;
        };
        
        event::emit(PenaltyPaid {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            amount: total_penalty,
            warnings_cleared: warnings_to_clear,
        });
        
        // If all warnings are cleared and member was suspended, reactivate them
        if (member.warning_count == 0 && member.status == MEMBER_STATUS_SUSPENDED) {
            member.status = MEMBER_STATUS_ACTIVE;
            member.suspension_end_time = option::none();
        };
    }

    // Add getter function for penalty amount
    public fun get_warning_penalty_amount(circle: &Circle): u64 {
        from_decimals(circle.penalty_rules.warning_penalty_amount)
    }

    public fun get_unpaid_penalties(circle: &Circle, member_addr: address): u64 {
        let member = table::borrow(&circle.members, member_addr);
        from_decimals(member.unpaid_penalties)
    }

    // Add treasury management functions
    public fun process_scheduled_payout(
        circle: &mut Circle,
        recipient: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(table::contains(&circle.members, recipient), ENotMember);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time >= circle.next_payout_time, EInvalidPayoutSchedule);
        
        let member = table::borrow_mut(&mut circle.members, recipient);
        assert!(!member.received_payout, EPayoutAlreadyProcessed);
        
        // Calculate payout amount based on circle type
        let payout_amount = if (option::is_some(&circle.goal_type)) {
            // Smart goal payout - proportional to contribution
            let total_contributions = balance::value(&circle.contributions);
            let member_share = (member.total_contributed * total_contributions) / (circle.contribution_amount * circle.current_members);
            member_share
        } else {
            // Regular rotational payout
            circle.contribution_amount * circle.current_members
        };
        
        assert!(balance::value(&circle.contributions) >= payout_amount, EInsufficientTreasuryBalance);
        
        // Process payout
        let payout_coin = coin::from_balance(
            balance::split(&mut circle.contributions, payout_amount),
            ctx
        );
        
        // Update member state
        member.received_payout = true;
        
        // Transfer payout
        transfer::public_transfer(payout_coin, recipient);
        
        // Emit event
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
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        
        // Get current balances
        let contributions = balance::value(&circle.contributions);
        let deposits = balance::value(&circle.deposits);
        let penalties = balance::value(&circle.penalties);
        
        // Emit treasury state
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
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        let member = table::borrow_mut(&mut circle.members, member_addr);
        
        // Check if member has completed obligations
        assert!(member.total_contributed >= circle.contribution_amount * member.total_meetings_required, EMemberHasOutstandingObligations);
        
        // Calculate returnable deposit (may be reduced by penalties)
        let returnable_amount = if (member.warning_count == 0 && member.reputation_score >= 80) {
            member.deposit_balance
        } else {
            // Return partial deposit based on reputation
            (member.deposit_balance * (member.reputation_score as u64)) / 100
        };
        
        assert!(returnable_amount > 0 && returnable_amount <= member.deposit_balance, EInvalidPayoutAmount);
        assert!(balance::value(&circle.deposits) >= returnable_amount, EInsufficientTreasuryBalance);
        
        // Process deposit return
        let deposit_coin = coin::from_balance(
            balance::split(&mut circle.deposits, returnable_amount),
            ctx
        );
        
        // Update member state
        member.deposit_balance = member.deposit_balance - returnable_amount;
        
        // Transfer deposit
        transfer::public_transfer(deposit_coin, member_addr);
    }

    // Add contribution history tracking
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

    // Add treasury balance getters
    public fun get_treasury_balances(circle: &Circle): (u64, u64, u64) {
        (
            from_decimals(balance::value(&circle.contributions)),
            from_decimals(balance::value(&circle.deposits)),
            from_decimals(balance::value(&circle.penalties))
        )
    }

    // Add function to check if member is eligible for payout
    public fun is_eligible_for_payout(
        circle: &Circle,
        member_addr: address,
        clock: &Clock
    ): bool {
        if (!table::contains(&circle.members, member_addr)) {
            return false
        };
        
        let member = table::borrow(&circle.members, member_addr);
        
        // Check eligibility conditions
        member.status == MEMBER_STATUS_ACTIVE &&
        !member.received_payout &&
        member.total_contributed >= circle.contribution_amount &&
        option::is_none(&member.suspension_end_time) &&
        clock::timestamp_ms(clock) >= circle.next_payout_time
    }

    // Add rotation management functions
    public fun set_rotation_position(
        circle: &mut Circle,
        member_addr: address,
        position: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(position < circle.max_members, EInvalidRotationPosition);
        assert!(table::contains(&circle.members, member_addr), ENotMember);
        
        let current_size = vector::length(&circle.rotation_order);
        if (position >= current_size) {
            // Fill gaps with empty addresses
            while (vector::length(&circle.rotation_order) < position) {
                vector::push_back(&mut circle.rotation_order, @0x0);
            };
            vector::push_back(&mut circle.rotation_order, member_addr);
        } else {
            assert!(vector::borrow(&circle.rotation_order, position) == &(@0x0), EPositionAlreadyTaken);
            *vector::borrow_mut(&mut circle.rotation_order, position) = member_addr;
        };
        
        let member = table::borrow_mut(&mut circle.members, member_addr);
        member.payout_position = option::some(position);
    }

    // Add auction management functions
    public fun start_position_auction(
        circle: &mut Circle,
        position: u64,
        minimum_bid: u64,
        duration_days: u64,
        discount_rate: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
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
        bid: Coin<USDC>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(option::is_some(&circle.active_auction), EAuctionNotActive);
        let auction = option::borrow_mut(&mut circle.active_auction);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= auction.end_time, EAuctionNotActive);
        
        let bid_amount = coin::value(&bid);
        assert!(bid_amount > auction.highest_bid, EInvalidBidAmount);
        
        // Return previous bid if exists
        if (option::is_some(&auction.highest_bidder)) {
            let prev_bidder = *option::borrow(&auction.highest_bidder);
            let refund = coin::from_balance(
                balance::split(&mut circle.contributions, auction.highest_bid),
                ctx
            );
            transfer::public_transfer(refund, prev_bidder);
        };
        
        // Update auction state
        auction.highest_bid = bid_amount;
        auction.highest_bidder = option::some(tx_context::sender(ctx));
        
        // Store bid
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
        clock: &Clock,
        ctx: &mut TxContext
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

    // Add smart goal management functions
    public fun add_monetary_milestone(
        circle: &mut Circle,
        target_amount: u64,
        deadline: u64,
        description: vector<u8>,
        prerequisites: vector<u64>,
        verification_requirements: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(option::is_some(&circle.goal_type), EInvalidMilestone);
        assert!(target_amount > 0, EMilestoneTargetInvalid);
        
        // Validate prerequisites
        let i = 0;
        let prereq_len = vector::length(&prerequisites);
        while (i < prereq_len) {
            let prereq_num = *vector::borrow(&prerequisites, i);
            assert!(prereq_num < vector::length(&circle.milestones), EMilestonePrerequisiteNotMet);
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
        clock: &Clock,
        ctx: &mut TxContext
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
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        assert!(milestone_number < vector::length(&circle.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow_mut(&mut circle.milestones, milestone_number);
        assert!(!milestone.completed, EMilestoneAlreadyVerified);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= milestone.deadline, EMilestoneDeadlinePassed);
        
        // Verify based on milestone type
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
        
        // Check verification requirements
        assert!(
            vector::length(&milestone.verification_proofs) >= 
            vector::length(&milestone.verification_requirements),
            EMilestoneVerificationFailed
        );
        
        milestone.completed = true;
        milestone.verified_by = option::some(tx_context::sender(ctx));
        milestone.completion_time = option::some(current_time);
        
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

    // Add verification submission function
    public fun submit_milestone_verification(
        circle: &mut Circle,
        milestone_number: u64,
        proof: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(milestone_number < vector::length(&circle.milestones), EInvalidMilestone);
        let milestone = vector::borrow_mut(&mut circle.milestones, milestone_number);
        
        // Check deadline
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= milestone.deadline, EMilestoneDeadlinePassed);
        
        // Check prerequisites
        let i = 0;
        let prereq_len = vector::length(&milestone.prerequisites);
        while (i < prereq_len) {
            let prereq_num = *vector::borrow(&milestone.prerequisites, i);
            let prereq = vector::borrow(&circle.milestones, prereq_num);
            assert!(prereq.completed, EMilestonePrerequisiteNotMet);
            i = i + 1;
        };
        
        // Add verification proof
        vector::push_back(&mut milestone.verification_proofs, proof);
        
        event::emit(MilestoneVerificationSubmitted {
            circle_id: object::uid_to_inner(&circle.id),
            milestone_number,
            submitted_by: tx_context::sender(ctx),
            proof_type: *vector::borrow(&milestone.verification_requirements, 
                vector::length(&milestone.verification_proofs) - 1),
            timestamp: current_time,
        });
    }

    // Add milestone info getter
    public fun get_milestone_info(
        circle: &Circle,
        milestone_number: u64
    ): (u8, Option<u64>, Option<u64>, u64, u64, bool, String) {
        assert!(milestone_number < vector::length(&circle.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow(&circle.milestones, milestone_number);
        (
            milestone.milestone_type,
            option::map(milestone.target_amount, |amt| from_decimals(*amt)),
            option::map(milestone.target_duration, |dur| dur / MS_PER_DAY),
            milestone.start_time,
            milestone.deadline,
            milestone.completed,
            milestone.description
        )
    }

    // Update milestone progress getter
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
        let count = 0;
        let i = 0;
        let total = vector::length(&circle.milestones);
        
        while (i < total) {
            if (vector::borrow(&circle.milestones, i).completed) {
                count = count + 1;
            };
            i = i + 1;
        };
        
        count
    }

    // Add getter functions
    public fun get_rotation_order(circle: &Circle): vector<address> {
        circle.rotation_order
    }

    public fun get_milestone_progress(circle: &Circle): (u64, u64, u64) {
        (
            from_decimals(circle.goal_progress),
            vector::length(&circle.milestones),
            circle.last_milestone_completed
        )
    }

    public fun get_active_auction(circle: &Circle): (Option<u64>, Option<u64>, Option<u64>) {
        if (option::is_none(&circle.active_auction)) {
            (option::none(), option::none(), option::none())
        } else {
            let auction = option::borrow(&circle.active_auction);
            (
                option::some(auction.position),
                option::some(from_decimals(auction.highest_bid)),
                option::some(auction.end_time)
            )
        }
    }
} 