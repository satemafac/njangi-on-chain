module njangi::circle {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::tx_context::{Self, TxContext};
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use std::vector;
    use std::option::{Self, Option};
    // Import USDC type
    use sui_ext::usdc::USDC;

    // Constants for circle status
    const CIRCLE_STATUS_CREATED: u8 = 0;
    const CIRCLE_STATUS_ACTIVE: u8 = 1;
    const CIRCLE_STATUS_PAUSED: u8 = 2;
    const CIRCLE_STATUS_COMPLETED: u8 = 3;

    // Constants for member status
    const MEMBER_STATUS_ACTIVE: u8 = 0;
    const MEMBER_STATUS_WARNING: u8 = 1;
    const MEMBER_STATUS_SUSPENDED: u8 = 2;

    // ====== Errors ======
    const ENO_PERMISSION: u64 = 0;
    const EINVALID_MEMBER_COUNT: u64 = 1;
    const EINVALID_CONTRIBUTION: u64 = 2;
    const EINVALID_SECURITY_DEPOSIT: u64 = 3;
    const EINVALID_CYCLE_TYPE: u64 = 4;
    const EMEMBER_ALREADY_EXISTS: u64 = 5;
    const EMEMBER_NOT_FOUND: u64 = 6;
    const EINSUFFICIENT_BALANCE: u64 = 7;
    const EINVALID_PROPOSAL: u64 = 8;
    const EPROPOSAL_EXPIRED: u64 = 9;
    const EALREADY_VOTED: u64 = 10;
    const EINSUFFICIENT_TREASURY_BALANCE: u64 = 11;
    const EINVALID_TREASURY_OPERATION: u64 = 12;
    const ECIRCLE_NOT_ACTIVE: u64 = 13;
    const EINVALID_PROPOSAL_TYPE: u64 = 14;
    const EINSUFFICIENT_REPUTATION: u64 = 15;
    const EMEMBER_SUSPENDED: u64 = 16;
    const EDEFAULT_IN_PROGRESS: u64 = 17;
    const EGOAL_ALREADY_REACHED: u64 = 18;
    const EINVALID_GOAL_TYPE: u64 = 19;
    const EINVALID_GOAL_AMOUNT: u64 = 20;
    const EINVALID_CYCLE_STATE: u64 = 21;
    const EINVALID_CONTRIBUTION_TIMING: u64 = 22;
    const EINVALID_MEMBER_STATE: u64 = 23;
    const EINVALID_AUTHENTICATION: u64 = 24;
    const EINVALID_OPERATION_SEQUENCE: u64 = 25;
    const EINVALID_TREASURY_STATE: u64 = 26;
    const ECYCLE_ALREADY_COMPLETED: u64 = 27;
    const EINVALID_ROTATION_ORDER: u64 = 28;
    const EMEMBER_LIMIT_EXCEEDED: u64 = 29;
    const EINVALID_TIMESTAMP: u64 = 30;
    const ETREASURY_RECONCILIATION_FAILED: u64 = 31;
    const EROTATION_ORDER_LOCKED: u64 = 32;
    const EINVALID_SHUFFLE_SEED: u64 = 33;
    const EPROPOSAL_EXECUTION_FAILED: u64 = 34;
    const EINVALID_RECONCILIATION: u64 = 35;

    // ====== Constants ======
    const VOTING_DURATION: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const MIN_MEMBERS: u64 = 3;
    const MAX_MEMBERS: u64 = 20;

    // ====== Types ======
    struct NjangiCircle has key {
        id: UID,
        name: vector<u8>,
        admin: address,
        contribution_amount: u64,
        security_deposit: u64,
        cycle_length: u8, // 0: Weekly, 1: Monthly, 2: Quarterly
        cycle_day: u8,
        cycle_type: u8, // 0: Rotational, 1: Auction-based
        member_count: u64,
        max_members: u64,
        current_cycle: u64,
        next_payout_time: u64,
        treasury_id: ID,  // Reference to shared treasury
        members: vector<address>,
        rotation_order: vector<address>,
        proposals: Table<ID, Proposal>,
        penalty_rules: PenaltyRules,
        member_deposits: Table<address, u64>, // Track security deposits separately
        status: u8,  // New field to track circle status
        pending_invites: vector<address>, // Track invited members
        governance_config: GovernanceConfig,
        member_states: Table<address, MemberState>,
        default_records: Table<address, vector<DefaultRecord>>,
        smart_goal: Option<SmartGoal>,  // Only set for smart goal circles
        rotation_history: Option<RotationHistory>,
        current_cycle_info: Option<CycleInfo>,
        state: CircleState,
        max_concurrent_operations: u64,
        current_concurrent_operations: u64,
        treasury_reconciliation: TreasuryReconciliation,
        rotation_config: RotationOrderConfig,
        member_index: Table<address, u64>, // For O(1) member lookups
    }

    struct PenaltyRules has store {
        late_payment: bool,
        missed_meeting: bool,
        late_payment_fee: u64,
        missed_meeting_fee: u64,
    }

    struct Proposal has store {
        id: UID,
        proposer: address,
        proposal_type: u8, // 0: Change Contribution, 1: Change Rules, 2: Remove Member
        description: vector<u8>,
        value: vector<u8>,
        start_time: u64,
        end_time: u64,
        votes_for: u64,
        votes_against: u64,
        executed: bool,
        voters: vector<address>,
    }

    struct CircleTreasury has key {
        id: UID,
        circle_id: ID,
        balance: Coin<USDC>,
        total_contributions: u64,
        last_payout_time: u64,
    }

    // ====== Events ======
    struct CircleCreated has copy, drop {
        circle_id: ID,
        admin: address,
        name: vector<u8>,
        contribution_amount: u64,
    }

    struct MemberJoined has copy, drop {
        circle_id: ID,
        member: address,
    }

    struct ContributionMade has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        cycle: u64,
    }

    struct PayoutMade has copy, drop {
        circle_id: ID,
        recipient: address,
        amount: u64,
        cycle: u64,
    }

    struct ProposalCreated has copy, drop {
        circle_id: ID,
        proposal_id: ID,
        proposer: address,
        proposal_type: u8,
    }

    struct VoteCast has copy, drop {
        circle_id: ID,
        proposal_id: ID,
        voter: address,
        vote: bool,
    }

    // ====== Core Functions ======
    public fun create_circle(
        name: vector<u8>,
        contribution_amount: u64,
        security_deposit: u64,
        cycle_length: u8,
        cycle_day: u8,
        circle_type: u8,
        max_members: u64,
        late_payment: bool,
        missed_meeting: bool,
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_date: Option<u64>,
        verification_required: bool,
        ctx: &mut TxContext
    ) {
        assert!(max_members >= MIN_MEMBERS && max_members <= MAX_MEMBERS, EINVALID_MEMBER_COUNT);
        assert!(contribution_amount > 0, EINVALID_CONTRIBUTION);
        assert!(security_deposit >= contribution_amount / 2, EINVALID_SECURITY_DEPOSIT); // Require at least 50% of contribution
        assert!(circle_type <= 2, EINVALID_CYCLE_TYPE);

        // Initialize smart goal with enhanced features
        let smart_goal = if (circle_type == CIRCLE_TYPE_SMART_GOAL) {
            assert!(option::is_some(&goal_type), EINVALID_GOAL_TYPE);
            let goal_type_val = *option::borrow(&goal_type);
            assert!(goal_type_val <= 1, EINVALID_GOAL_TYPE);

            option::some(SmartGoal {
                goal_type: goal_type_val,
                target_amount: option::get_with_default(&target_amount, 0),
                target_date: option::get_with_default(&target_date, 0),
                current_amount: 0,
                start_date: tx_context::epoch(ctx),
                completed: false,
                distribution_type: 0,
                milestones: vector::empty(),
                verification_required,
                verified_by: option::none(),
                last_update_time: tx_context::epoch(ctx),
                contribution_history: table::new(ctx),
            })
        } else {
            option::none()
        };

        // Create shared treasury
        let treasury = CircleTreasury {
            id: object::new(ctx),
            circle_id: object::uid_to_inner(&object::new(ctx)),
            balance: coin::zero(ctx),
            total_contributions: 0,
            last_payout_time: 0,
        };
        let treasury_id = object::uid_to_inner(&treasury.id);

        let circle = NjangiCircle {
            id: object::new(ctx),
            name,
            admin: tx_context::sender(ctx),
            contribution_amount,
            security_deposit,
            cycle_length,
            cycle_day,
            cycle_type,
            member_count: 1,
            max_members,
            current_cycle: 0,
            next_payout_time: 0,
            treasury_id,
            members: vector::singleton(tx_context::sender(ctx)),
            rotation_order: vector::empty(),
            proposals: table::new(ctx),
            penalty_rules: PenaltyRules {
                late_payment,
                missed_meeting,
                late_payment_fee: contribution_amount / 10,
                missed_meeting_fee: contribution_amount / 20,
            },
            member_deposits: table::new(ctx),
            status: CIRCLE_STATUS_CREATED,
            pending_invites: vector::empty(),
            governance_config: GovernanceConfig {
                proposal_threshold: 0,
                voting_period: 0,
                execution_delay: 0,
                quorum_threshold: 0,
                majority_threshold: 0,
                slash_percentage: 0,
                max_warnings: 0,
                warning_duration: 0,
                suspension_duration: 0,
            },
            member_states: table::new(ctx),
            default_records: table::new(ctx),
            smart_goal,
            rotation_history: option::none(),
            current_cycle_info: option::none(),
            state: CircleState {
                last_operation_time: tx_context::epoch(ctx),
                last_operation_type: 0,
                operation_sequence: 0,
                is_locked: false,
                lock_reason: option::none(),
                last_state_update: tx_context::epoch(ctx),
            },
            max_concurrent_operations: 5, // Configurable based on requirements
            current_concurrent_operations: 0,
            treasury_reconciliation: TreasuryReconciliation {
                last_reconciliation_time: tx_context::epoch(ctx),
                total_recorded_contributions: 0,
                actual_balance: 0,
                discrepancy_amount: 0,
                reconciliation_status: 0,
                reconciliation_history: vector::empty(),
            },
            rotation_config: RotationOrderConfig {
                is_locked: false,
                last_modified: tx_context::epoch(ctx),
                modification_count: 0,
                seed: vector::empty(),
                order_type: ROTATION_ORDER_RANDOM,
                custom_priority: table::new(ctx),
            },
            member_index: table::new(ctx),
        };

        // Update treasury with circle ID
        treasury.circle_id = object::uid_to_inner(&circle.id);

        event::emit(CircleCreated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: tx_context::sender(ctx),
            name: *&circle.name,
            contribution_amount,
        });

        // Share both objects
        transfer::share_object(treasury);
        transfer::share_object(circle);

        if (circle_type == CIRCLE_TYPE_ROTATIONAL) {
            initialize_rotation_tracking(&mut circle, clock, ctx);
        };

        // Create and transfer admin capability
        let admin_cap = create_admin_cap(&circle, ctx);
        transfer::transfer(admin_cap, tx_context::sender(ctx));
    }

    public fun join_circle(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        security_deposit: Coin<USDC>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(!vector::contains(&circle.members, &sender), EMEMBER_ALREADY_EXISTS);
        assert!(vector::contains(&circle.pending_invites, &sender), EMEMBER_NOT_FOUND);
        assert!(circle.member_count < circle.max_members, EINVALID_MEMBER_COUNT);
        assert!(coin::value(&security_deposit) >= circle.security_deposit, EINVALID_SECURITY_DEPOSIT);
        assert!(object::uid_to_inner(&treasury.id) == circle.treasury_id, EINVALID_TREASURY_OPERATION);

        // Remove from pending invites
        let (contains, index) = vector::index_of(&circle.pending_invites, &sender);
        if (contains) {
            vector::remove(&mut circle.pending_invites, index);
        };

        // Store security deposit in treasury
        coin::join(&mut treasury.balance, security_deposit);
        
        vector::push_back(&mut circle.members, sender);
        table::add(&mut circle.member_deposits, sender, circle.security_deposit);
        
        // Initialize member state
        table::add(&mut circle.member_states, sender, initialize_member_state(ctx));
        
        circle.member_count = circle.member_count + 1;

        // If we have reached minimum members, activate the circle
        if (circle.member_count >= MIN_MEMBERS && circle.status == CIRCLE_STATUS_CREATED) {
            circle.status = CIRCLE_STATUS_ACTIVE;
            circle.rotation_order = *&circle.members;
        };

        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
        });
    }

    public fun make_contribution(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        payment: Coin<USDC>,
        clock: &Clock,
        member_cap: &MemberCap,
        ctx: &mut TxContext
    ) {
        // Validate member capability
        assert!(object::uid_to_inner(&circle.id) == member_cap.circle_id, EINVALID_AUTHENTICATION);
        assert!(tx_context::sender(ctx) == member_cap.member, EINVALID_AUTHENTICATION);
        
        // Validate circle state
        validate_circle_state(circle, OPERATION_CONTRIBUTION, clock);
        
        assert!(circle.status == CIRCLE_STATUS_ACTIVE, ECIRCLE_NOT_ACTIVE);
        let sender = tx_context::sender(ctx);
        assert!(vector::contains(&circle.members, &sender), EMEMBER_NOT_FOUND);
        assert!(coin::value(&payment) >= circle.contribution_amount, EINVALID_CONTRIBUTION);
        assert!(object::uid_to_inner(&treasury.id) == circle.treasury_id, EINVALID_TREASURY_OPERATION);

        if (circle.cycle_type == CIRCLE_TYPE_ROTATIONAL) {
            // Check for double contribution
            let cycle_info = option::borrow(&circle.current_cycle_info);
            assert!(!vector::contains(&cycle_info.contributors, &sender), EINVALID_CONTRIBUTION);
            
            // Record contribution
            let cycle_info = option::borrow_mut(&mut circle.current_cycle_info);
            vector::push_back(&mut cycle_info.contributors, sender);
            cycle_info.total_collected = cycle_info.total_collected + circle.contribution_amount;

            let remaining = circle.member_count - vector::length(&cycle_info.contributors);
            
            event::emit(ContributionRecorded {
                circle_id: object::uid_to_inner(&circle.id),
                cycle_number: cycle_info.cycle_number,
                contributor: sender,
                amount: circle.contribution_amount,
                remaining_contributors: remaining,
            });

            // Check if all contributions received
            if (vector::length(&cycle_info.contributors) == circle.member_count) {
                process_rotational_payout(circle, treasury, clock, ctx);
            };
        } else {
            // Handle non-rotational contributions
            // ... existing non-rotational contribution code ...
        };

        // Add contribution to treasury
        let payment_amount = coin::value(&payment);
        coin::join(&mut treasury.balance, payment);
        treasury.total_contributions = treasury.total_contributions + payment_amount;

        event::emit(ContributionMade {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            amount: payment_amount,
            cycle: circle.current_cycle,
        });

        // Release operation lock
        release_operation(circle);
    }

    // ====== DAO Functions ======
    public fun create_proposal(
        circle: &mut NjangiCircle,
        proposal_type: u8,
        description: vector<u8>,
        value: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(vector::contains(&circle.members, &sender), EMEMBER_NOT_FOUND);
        
        // Check member status and reputation
        let member_state = table::borrow(&circle.member_states, sender);
        assert!(member_state.status != MEMBER_STATUS_SUSPENDED, EMEMBER_SUSPENDED);
        assert!(member_state.reputation_score >= circle.governance_config.proposal_threshold, 
            EINSUFFICIENT_REPUTATION);

        let proposal = Proposal {
            id: object::new(ctx),
            proposer: sender,
            proposal_type,
            description,
            value,
            start_time: clock::timestamp_ms(clock),
            end_time: clock::timestamp_ms(clock) + VOTING_DURATION,
            votes_for: 0,
            votes_against: 0,
            executed: false,
            voters: vector::empty(),
        };

        let proposal_id = object::uid_to_inner(&proposal.id);
        table::add(&mut circle.proposals, proposal_id, proposal);

        event::emit(ProposalCreated {
            circle_id: object::uid_to_inner(&circle.id),
            proposal_id,
            proposer: sender,
            proposal_type,
        });
    }

    public fun vote_on_proposal(
        circle: &mut NjangiCircle,
        proposal_id: ID,
        vote: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(vector::contains(&circle.members, &sender), EMEMBER_NOT_FOUND);
        
        // Check member status
        let member_state = table::borrow(&circle.member_states, sender);
        assert!(member_state.status != MEMBER_STATUS_SUSPENDED, EMEMBER_SUSPENDED);

        let proposal = table::borrow_mut(&mut circle.proposals, proposal_id);
        assert!(!proposal.executed, EINVALID_PROPOSAL);
        assert!(clock::timestamp_ms(clock) <= proposal.end_time, EPROPOSAL_EXPIRED);
        assert!(!vector::contains(&proposal.voters, &sender), EALREADY_VOTED);

        if (vote) {
            proposal.votes_for = proposal.votes_for + 1;
        } else {
            proposal.votes_against = proposal.votes_against + 1;
        };

        vector::push_back(&mut proposal.voters, sender);

        event::emit(VoteCast {
            circle_id: object::uid_to_inner(&circle.id),
            proposal_id,
            voter: sender,
            vote,
        });

        // Check if proposal can be executed
        if (can_execute_proposal(circle, proposal)) {
            execute_proposal(circle, proposal_id, ctx);
        };
    }

    // ====== Helper Functions ======
    fun process_payout(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        admin_cap: &AdminCap,
        ctx: &mut TxContext
    ) {
        // Validate admin capability
        assert!(object::uid_to_inner(&circle.id) == admin_cap.circle_id, EINVALID_AUTHENTICATION);
        
        // Validate circle state
        validate_circle_state(circle, OPERATION_PAYOUT, clock);
        
        // Implementation for payout logic based on cycle type
        if (circle.cycle_type == CIRCLE_TYPE_ROTATIONAL) { // Rotational
            process_rotational_payout(circle, treasury, clock, ctx);
        } else if (circle.cycle_type == CIRCLE_TYPE_SMART_GOAL) {
            // For smart goals, check if goal is reached
            let (reached, _) = check_goal_progress(circle, treasury, clock);
            if (reached) {
                process_goal_completion(circle, treasury, clock, ctx);
            };
        } else { // Auction-based
            process_auction_payout(circle, treasury, ctx);
        };

        // Update cycle and next payout time
        circle.current_cycle = circle.current_cycle + 1;
        circle.next_payout_time = calculate_next_payout_time(circle, clock);
        treasury.last_payout_time = clock::timestamp_ms(clock);

        // Release operation lock
        release_operation(circle);
    }

    fun process_rotational_payout(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let cycle_info = option::borrow(&circle.current_cycle_info);
        
        // Check if this is the final cycle (all members have received payout)
        let is_final_cycle = if (option::is_some(&circle.rotation_history)) {
            let history = option::borrow(&circle.rotation_history);
            history.total_cycles_completed + 1 == circle.member_count
        } else {
            false
        };

        if (is_final_cycle) {
            process_final_rotational_cycle(circle, treasury, clock, ctx);
        } else {
            // ... existing rotational payout code ...
            let total_payout = circle.contribution_amount * circle.member_count;
            assert!(coin::value(&treasury.balance) >= total_payout, EINSUFFICIENT_TREASURY_BALANCE);
            
            // Transfer payout
            let payout = coin::split(&mut treasury.balance, total_payout, ctx);
            transfer::public_transfer(payout, cycle_info.payout_recipient);

            // Record payout
            let cycle_info = option::borrow_mut(&mut circle.current_cycle_info);
            cycle_info.payout_completed = true;
            cycle_info.payout_time = option::some(clock::timestamp_ms(clock));

            event::emit(PayoutMade {
                circle_id: object::uid_to_inner(&circle.id),
                recipient: cycle_info.payout_recipient,
                amount: total_payout,
                cycle: cycle_info.cycle_number,
            });

            // Store completed cycle in history and setup next cycle
            if (option::is_some(&mut circle.rotation_history)) {
                let history = option::borrow_mut(&mut circle.rotation_history);
                table::add(&mut history.cycles, cycle_info.cycle_number, *cycle_info);
                history.last_completed_cycle = cycle_info.cycle_number;
                history.total_cycles_completed = history.total_cycles_completed + 1;

                event::emit(CycleCompleted {
                    circle_id: object::uid_to_inner(&circle.id),
                    cycle_number: cycle_info.cycle_number,
                    total_collected: cycle_info.total_collected,
                    completion_time: clock::timestamp_ms(clock),
                });

                setup_next_cycle(circle, clock);
            };
        };
    }

    fun process_auction_payout(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        ctx: &mut TxContext
    ) {
        let total_payout = circle.contribution_amount * circle.member_count;
        assert!(coin::value(&treasury.balance) >= total_payout, EINSUFFICIENT_TREASURY_BALANCE);
        
        // Get winning bid from auction table (would be stored during bidding phase)
        let winning_bid = get_winning_bid(circle);
        assert!(option::is_some(&winning_bid), EINVALID_PROPOSAL);
        
        let bid = option::extract(&mut winning_bid);
        let discount = bid.bid_amount;
        let payout_amount = total_payout - discount;
        
        // Transfer discounted amount to winner
        let payout = coin::split(&mut treasury.balance, payout_amount, ctx);
        transfer::public_transfer(payout, bid.bidder);
        
        // Distribute discount among other members
        let member_share = discount / (circle.member_count - 1);
        let mut i = 0;
        while (i < vector::length(&circle.members)) {
            let member = vector::borrow(&circle.members, i);
            if (*member != bid.bidder) {
                let share = coin::split(&mut treasury.balance, member_share, ctx);
                transfer::public_transfer(share, *member);
            };
            i = i + 1;
        };

        event::emit(PayoutMade {
            circle_id: object::uid_to_inner(&circle.id),
            recipient: bid.bidder,
            amount: payout_amount,
            cycle: circle.current_cycle,
        });
    }

    fun get_winning_bid(circle: &NjangiCircle): Option<AuctionBid> {
        // TODO: Implement actual auction bid storage and retrieval
        // For now return none to indicate no winning bid
        option::none()
    }

    fun calculate_next_payout_time(circle: &NjangiCircle, clock: &Clock): u64 {
        let current_time = clock::timestamp_ms(clock);
        let cycle_duration = if (circle.cycle_length == 0) {
            7 * 24 * 60 * 60 * 1000 // Weekly
        } else if (circle.cycle_length == 1) {
            30 * 24 * 60 * 60 * 1000 // Monthly
        } else {
            90 * 24 * 60 * 60 * 1000 // Quarterly
        };

        current_time + cycle_duration
    }

    fun can_execute_proposal(circle: &NjangiCircle, proposal: &Proposal): bool {
        let total_votes = proposal.votes_for + proposal.votes_against;
        let quorum = (circle.member_count * 2) / 3; // 66% quorum
        
        total_votes >= quorum && proposal.votes_for > proposal.votes_against
    }

    fun execute_proposal(circle: &mut NjangiCircle, proposal_id: ID, ctx: &mut TxContext) {
        let proposal = table::borrow_mut(&mut circle.proposals, proposal_id);
        if (proposal.executed) return;

        // Parse value based on proposal type
        let value_bytes = *&proposal.value;
        
        if (proposal.proposal_type == PROPOSAL_TYPE_CHANGE_CONTRIBUTION) {
            // Update contribution amount
            let new_amount = from_bytes_u64(&value_bytes);
            circle.contribution_amount = new_amount;
        } else if (proposal.proposal_type == PROPOSAL_TYPE_CHANGE_CYCLE_LENGTH) {
            // Update cycle length
            let new_length = from_bytes_u8(&value_bytes);
            assert!(new_length <= 2, EINVALID_PROPOSAL); // 0: Weekly, 1: Monthly, 2: Quarterly
            circle.cycle_length = new_length;
        } else if (proposal.proposal_type == PROPOSAL_TYPE_CHANGE_SECURITY_DEPOSIT) {
            // Update security deposit
            let new_deposit = from_bytes_u64(&value_bytes);
            circle.security_deposit = new_deposit;
        } else if (proposal.proposal_type == PROPOSAL_TYPE_CHANGE_PENALTY_RULES) {
            // Update penalty rules
            let new_rules = deserialize_penalty_rules(&value_bytes);
            circle.penalty_rules = new_rules;
        } else if (proposal.proposal_type == PROPOSAL_TYPE_REMOVE_MEMBER) {
            // Remove member
            let member_to_remove = from_bytes_address(&value_bytes);
            remove_member(circle, member_to_remove, ctx);
        } else if (proposal.proposal_type == PROPOSAL_TYPE_CHANGE_GOVERNANCE) {
            // Update governance config
            let new_config = deserialize_governance_config(&value_bytes);
            circle.governance_config = new_config;
        } else if (proposal.proposal_type == PROPOSAL_TYPE_EMERGENCY_PAUSE) {
            // Pause circle operations
            circle.status = CIRCLE_STATUS_PAUSED;
        } else if (proposal.proposal_type == PROPOSAL_TYPE_COMMUNITY_FUND) {
            // Handle community fund allocation
            let fund_proposal = deserialize_community_fund_proposal(&value_bytes);
            process_community_fund(circle, fund_proposal, ctx);
        };

        proposal.executed = true;
    }

    // Add function to invite members
    public fun invite_member(
        circle: &mut NjangiCircle,
        member_address: address,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENO_PERMISSION);
        assert!(!vector::contains(&circle.members, &member_address), EMEMBER_ALREADY_EXISTS);
        assert!(!vector::contains(&circle.pending_invites, &member_address), EMEMBER_ALREADY_EXISTS);
        assert!(circle.member_count < circle.max_members, EINVALID_MEMBER_COUNT);

        vector::push_back(&mut circle.pending_invites, member_address);
    }

    // Add function to check if circle is active
    public fun is_circle_active(circle: &NjangiCircle): bool {
        circle.status == CIRCLE_STATUS_ACTIVE
    }

    // Add function to withdraw security deposit when leaving circle
    public fun withdraw_security_deposit(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        ctx: &mut TxContext
    ): Coin<USDC> {
        let sender = tx_context::sender(ctx);
        assert!(vector::contains(&circle.members, &sender), EMEMBER_NOT_FOUND);
        assert!(object::uid_to_inner(&treasury.id) == circle.treasury_id, EINVALID_TREASURY_OPERATION);
        
        let deposit_amount = *table::borrow(&circle.member_deposits, sender);
        assert!(coin::value(&treasury.balance) >= deposit_amount, EINSUFFICIENT_TREASURY_BALANCE);
        
        // Remove member's deposit record
        table::remove(&mut circle.member_deposits, sender);
        
        // Return security deposit
        coin::split(&mut treasury.balance, deposit_amount, ctx)
    }

    // Add new structs for governance
    struct GovernanceConfig has store {
        proposal_threshold: u64,      // Minimum deposit required to create proposal
        voting_period: u64,          // Duration of voting period in milliseconds
        execution_delay: u64,        // Delay before executing approved proposals
        quorum_threshold: u8,        // Percentage required for quorum
        majority_threshold: u8,      // Percentage required for majority
        slash_percentage: u8,        // Percentage of deposit to slash for defaults
        max_warnings: u8,            // Maximum warnings before suspension
        warning_duration: u64,       // How long warnings last
        suspension_duration: u64,     // How long suspensions last
    }

    struct MemberState has store {
        status: u8,                  // Active, Warning, or Suspended
        reputation_score: u64,       // Member's reputation score
        warning_count: u8,           // Number of active warnings
        last_warning_time: u64,      // Timestamp of last warning
        suspension_end_time: u64,    // When suspension ends (if suspended)
        missed_contributions: u64,    // Count of missed contributions
        total_contributions: u64,     // Total contributions made
        active_installment_plan: Option<InstallmentPlan>, // Current installment plan if any
    }

    struct DefaultRecord has store {
        cycle: u64,                  // Cycle when default occurred
        amount: u64,                 // Amount defaulted
        timestamp: u64,              // When the default occurred
        resolved: bool,              // Whether default has been resolved
        resolution_type: u8,         // How it was resolved (payment, slashing, etc.)
    }

    // Add new events
    struct MemberWarned has copy, drop {
        circle_id: ID,
        member: address,
        warning_count: u8,
        reason: vector<u8>,
    }

    struct MemberSuspended has copy, drop {
        circle_id: ID,
        member: address,
        duration: u64,
        reason: vector<u8>,
    }

    struct DefaultRecorded has copy, drop {
        circle_id: ID,
        member: address,
        cycle: u64,
        amount: u64,
    }

    struct PenaltyApplied has copy, drop {
        circle_id: ID,
        member: address,
        penalty_type: u8,
        amount: u64,
    }

    // Add function to initialize member state
    fun initialize_member_state(ctx: &mut TxContext): MemberState {
        MemberState {
            status: MEMBER_STATUS_ACTIVE,
            reputation_score: 100,    // Start with base reputation
            warning_count: 0,
            last_warning_time: 0,
            suspension_end_time: 0,
            missed_contributions: 0,
            total_contributions: 0,
            active_installment_plan: option::none(),
        }
    }

    // Add function to check member status
    public fun check_member_status(
        circle: &NjangiCircle,
        member: address,
        clock: &Clock
    ): u8 {
        let member_state = table::borrow(&circle.member_states, member);
        
        // Check if suspension has expired
        if (member_state.status == MEMBER_STATUS_SUSPENDED) {
            if (clock::timestamp_ms(clock) >= member_state.suspension_end_time) {
                return MEMBER_STATUS_ACTIVE
            };
        };
        
        member_state.status
    }

    // Add function to record default
    public fun record_default(
        circle: &mut NjangiCircle,
        member: address,
        amount: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let default_record = DefaultRecord {
            cycle: circle.current_cycle,
            amount,
            timestamp: clock::timestamp_ms(clock),
            resolved: false,
            resolution_type: 0,
        };

        if (!table::contains(&circle.default_records, member)) {
            table::add(&mut circle.default_records, member, vector::empty());
        };
        
        let records = table::borrow_mut(&mut circle.default_records, member);
        vector::push_back(records, default_record);

        let member_state = table::borrow_mut(&mut circle.member_states, member);
        member_state.missed_contributions = member_state.missed_contributions + 1;
        member_state.reputation_score = 
            if (member_state.reputation_score > 10) member_state.reputation_score - 10 
            else 0;

        // Issue warning if needed
        if (member_state.warning_count < circle.governance_config.max_warnings) {
            issue_warning(circle, member, clock, ctx);
        } else {
            suspend_member(circle, member, clock, ctx);
        };

        event::emit(DefaultRecorded {
            circle_id: object::uid_to_inner(&circle.id),
            member,
            cycle: circle.current_cycle,
            amount,
        });
    }

    // Add function to issue warning
    fun issue_warning(
        circle: &mut NjangiCircle,
        member: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let member_state = table::borrow_mut(&mut circle.member_states, member);
        member_state.warning_count = member_state.warning_count + 1;
        member_state.last_warning_time = clock::timestamp_ms(clock);
        member_state.status = MEMBER_STATUS_WARNING;

        event::emit(MemberWarned {
            circle_id: object::uid_to_inner(&circle.id),
            member,
            warning_count: member_state.warning_count,
            reason: b"Missed contribution payment",
        });
    }

    // Add function to suspend member
    fun suspend_member(
        circle: &mut NjangiCircle,
        member: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let member_state = table::borrow_mut(&mut circle.member_states, member);
        member_state.status = MEMBER_STATUS_SUSPENDED;
        member_state.suspension_end_time = 
            clock::timestamp_ms(clock) + circle.governance_config.suspension_duration;

        event::emit(MemberSuspended {
            circle_id: object::uid_to_inner(&circle.id),
            member,
            duration: circle.governance_config.suspension_duration,
            reason: b"Exceeded maximum warnings",
        });
    }

    // Add function to resolve default
    public fun resolve_default(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        member: address,
        payment: Coin<USDC>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == member || sender == circle.admin, ENO_PERMISSION);
        
        let records = table::borrow_mut(&mut circle.default_records, member);
        let latest_default = vector::borrow_mut(records, vector::length(records) - 1);
        assert!(!latest_default.resolved, EINVALID_PROPOSAL);
        
        // Add payment to treasury
        coin::join(&mut treasury.balance, payment);
        latest_default.resolved = true;
        latest_default.resolution_type = 1; // Payment resolution

        // Update member state
        let member_state = table::borrow_mut(&mut circle.member_states, member);
        if (member_state.status == MEMBER_STATUS_WARNING) {
            member_state.status = MEMBER_STATUS_ACTIVE;
        };
        member_state.reputation_score = 
            if (member_state.reputation_score <= 90) member_state.reputation_score + 10 
            else 100;
    }

    // Add new proposal type constants
    const PROPOSAL_TYPE_CHANGE_CONTRIBUTION: u8 = 0;
    const PROPOSAL_TYPE_CHANGE_CYCLE_LENGTH: u8 = 1;
    const PROPOSAL_TYPE_CHANGE_SECURITY_DEPOSIT: u8 = 2;
    const PROPOSAL_TYPE_CHANGE_PENALTY_RULES: u8 = 3;
    const PROPOSAL_TYPE_REMOVE_MEMBER: u8 = 4;
    const PROPOSAL_TYPE_CHANGE_GOVERNANCE: u8 = 5;
    const PROPOSAL_TYPE_EMERGENCY_PAUSE: u8 = 6;
    const PROPOSAL_TYPE_COMMUNITY_FUND: u8 = 7;

    // Add penalty resolution types
    const RESOLUTION_TYPE_PAYMENT: u8 = 0;
    const RESOLUTION_TYPE_SECURITY_DEPOSIT_SLASH: u8 = 1;
    const RESOLUTION_TYPE_COMMUNITY_PAYMENT: u8 = 2;
    const RESOLUTION_TYPE_INSTALLMENT_PLAN: u8 = 3;

    // Add new struct for installment plans
    struct InstallmentPlan has store {
        total_amount: u64,
        amount_paid: u64,
        installment_size: u64,
        next_payment_due: u64,
        payments_remaining: u8,
    }

    // Add function to create installment plan for defaulters
    public fun create_installment_plan(
        circle: &mut NjangiCircle,
        member: address,
        installment_size: u64,
        number_of_payments: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENO_PERMISSION);
        
        let records = table::borrow_mut(&mut circle.default_records, member);
        let latest_default = vector::borrow_mut(records, vector::length(records) - 1);
        assert!(!latest_default.resolved, EINVALID_PROPOSAL);
        
        let total_amount = latest_default.amount;
        let plan = InstallmentPlan {
            total_amount,
            amount_paid: 0,
            installment_size,
            next_payment_due: clock::timestamp_ms(clock) + (7 * 24 * 60 * 60 * 1000), // 1 week
            payments_remaining: number_of_payments,
        };
        
        // Store plan in member state
        let member_state = table::borrow_mut(&mut circle.member_states, member);
        member_state.status = MEMBER_STATUS_WARNING; // Change status to warning during repayment
        member_state.active_installment_plan = option::some(plan);
        
        latest_default.resolution_type = RESOLUTION_TYPE_INSTALLMENT_PLAN;
    }

    // Add function to make installment payment
    public fun make_installment_payment(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        payment: Coin<USDC>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let records = table::borrow_mut(&mut circle.default_records, sender);
        let latest_default = vector::borrow_mut(records, vector::length(records) - 1);
        assert!(latest_default.resolution_type == RESOLUTION_TYPE_INSTALLMENT_PLAN, EINVALID_PROPOSAL);
        
        // Add payment to treasury
        coin::join(&mut treasury.balance, payment);
        
        // Update installment plan
        let member_state = table::borrow_mut(&mut circle.member_states, sender);
        assert!(option::is_some(&member_state.active_installment_plan), EINVALID_PROPOSAL);
        let plan = option::borrow_mut(&mut member_state.active_installment_plan);
        
        plan.amount_paid = plan.amount_paid + coin::value(&payment);
        plan.payments_remaining = plan.payments_remaining - 1;
        plan.next_payment_due = clock::timestamp_ms(clock) + (7 * 24 * 60 * 60 * 1000);
        
        // Check if plan is completed
        if (plan.payments_remaining == 0) {
            latest_default.resolved = true;
            member_state.status = MEMBER_STATUS_ACTIVE;
            member_state.active_installment_plan = option::none();
        };
    }

    // Add helper functions for proposal value parsing
    fun from_bytes_u64(bytes: &vector<u8>): u64 {
        // Implementation for converting bytes to u64
        0
    }

    fun from_bytes_u8(bytes: &vector<u8>): u8 {
        // Implementation for converting bytes to u8
        0
    }

    fun from_bytes_address(bytes: &vector<u8>): address {
        // Implementation for converting bytes to address
        @0x0
    }

    fun deserialize_penalty_rules(bytes: &vector<u8>): PenaltyRules {
        // Implementation for deserializing penalty rules
        PenaltyRules {
            late_payment: false,
            missed_meeting: false,
            late_payment_fee: 0,
            missed_meeting_fee: 0,
        }
    }

    fun deserialize_governance_config(bytes: &vector<u8>): GovernanceConfig {
        // Implementation for deserializing governance config
        GovernanceConfig {
            proposal_threshold: 0,
            voting_period: 0,
            execution_delay: 0,
            quorum_threshold: 0,
            majority_threshold: 0,
            slash_percentage: 0,
            max_warnings: 0,
            warning_duration: 0,
            suspension_duration: 0,
        }
    }

    fun deserialize_community_fund_proposal(bytes: &vector<u8>): vector<u8> {
        // Implementation for deserializing community fund proposal
        vector::empty()
    }

    fun process_community_fund(circle: &mut NjangiCircle, proposal: vector<u8>, ctx: &mut TxContext) {
        // Implementation for processing community fund allocation
    }

    fun remove_member(circle: &mut NjangiCircle, member: address, ctx: &mut TxContext) {
        // Implementation for removing a member
        let (contains, index) = vector::index_of(&circle.members, &member);
        if (contains) {
            vector::remove(&mut circle.members, index);
            circle.member_count = circle.member_count - 1;
        };
    }

    // Add circle type constants
    const CIRCLE_TYPE_ROTATIONAL: u8 = 0;
    const CIRCLE_TYPE_SMART_GOAL: u8 = 1;
    const CIRCLE_TYPE_AUCTION: u8 = 2;

    // Add goal type constants
    const GOAL_TYPE_AMOUNT: u8 = 0;
    const GOAL_TYPE_TIME: u8 = 1;

    // Add SmartGoal struct
    struct SmartGoal has store {
        goal_type: u8,           // Amount-based or Time-based
        target_amount: u64,      // Target amount for amount-based goals
        target_date: u64,        // Target date for time-based goals
        current_amount: u64,     // Current amount saved
        start_date: u64,         // When the goal started
        completed: bool,         // Whether goal is reached
        distribution_type: u8,   // How to distribute funds (equal/proportional)
        milestones: vector<Milestone>,  // Track progress milestones
        verification_required: bool,     // Whether goal completion needs verification
        verified_by: Option<address>,    // Address that verified the goal
        last_update_time: u64,          // Last time goal was updated
        contribution_history: Table<address, vector<ContributionRecord>>, // Track individual contributions
    }

    // Add new structs for enhanced goal tracking
    struct Milestone has store {
        description: vector<u8>,
        target_amount: u64,
        target_date: u64,
        completed: bool,
        completion_date: Option<u64>,
    }

    struct ContributionRecord has store {
        amount: u64,
        timestamp: u64,
        cycle: u64,
    }

    // Add new events for goal tracking
    struct GoalProgressUpdated has copy, drop {
        circle_id: ID,
        current_amount: u64,
        progress_percentage: u64,
        update_time: u64,
    }

    struct MilestoneCompleted has copy, drop {
        circle_id: ID,
        description: vector<u8>,
        completion_time: u64,
    }

    struct GoalVerified has copy, drop {
        circle_id: ID,
        verifier: address,
        verification_time: u64,
    }

    // Add function to add milestone
    public fun add_goal_milestone(
        circle: &mut NjangiCircle,
        description: vector<u8>,
        target_amount: u64,
        target_date: u64,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENO_PERMISSION);
        assert!(option::is_some(&circle.smart_goal), EINVALID_GOAL_TYPE);
        
        let goal = option::borrow_mut(&mut circle.smart_goal);
        let milestone = Milestone {
            description,
            target_amount,
            target_date,
            completed: false,
            completion_date: option::none(),
        };
        
        vector::push_back(&mut goal.milestones, milestone);
    }

    // Add function to update goal progress
    public fun update_goal_progress(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(option::is_some(&circle.smart_goal), EINVALID_GOAL_TYPE);
        let goal = option::borrow_mut(&mut circle.smart_goal);
        
        // Update current amount from treasury
        goal.current_amount = treasury.total_contributions;
        goal.last_update_time = clock::timestamp_ms(clock);
        
        // Calculate progress percentage
        let progress_percentage = if (goal.goal_type == GOAL_TYPE_AMOUNT) {
            (goal.current_amount * 100) / goal.target_amount
        } else {
            let total_duration = goal.target_date - goal.start_date;
            let elapsed = clock::timestamp_ms(clock) - goal.start_date;
            (elapsed * 100) / total_duration
        };

        // Check and update milestones
        let i = 0;
        while (i < vector::length(&goal.milestones)) {
            let milestone = vector::borrow_mut(&mut goal.milestones, i);
            if (!milestone.completed) {
                if (goal.current_amount >= milestone.target_amount || 
                    clock::timestamp_ms(clock) >= milestone.target_date) {
                    milestone.completed = true;
                    milestone.completion_date = option::some(clock::timestamp_ms(clock));
                    
                    event::emit(MilestoneCompleted {
                        circle_id: object::uid_to_inner(&circle.id),
                        description: *&milestone.description,
                        completion_time: clock::timestamp_ms(clock),
                    });
                }
            };
            i = i + 1;
        };

        event::emit(GoalProgressUpdated {
            circle_id: object::uid_to_inner(&circle.id),
            current_amount: goal.current_amount,
            progress_percentage,
            update_time: clock::timestamp_ms(clock),
        });

        // Check if goal is completed
        let (reached, _) = check_goal_progress(circle, treasury, clock);
        if (reached && !goal.completed) {
            if (!goal.verification_required) {
                process_goal_completion(circle, treasury, clock, ctx);
            };
        };
    }

    // Add function to verify goal completion
    public fun verify_goal_completion(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENO_PERMISSION);
        assert!(option::is_some(&circle.smart_goal), EINVALID_GOAL_TYPE);
        
        let goal = option::borrow_mut(&mut circle.smart_goal);
        assert!(goal.verification_required, EINVALID_PROPOSAL);
        
        let (reached, _) = check_goal_progress(circle, treasury, clock);
        assert!(reached, EGOAL_ALREADY_REACHED);
        
        goal.verified_by = option::some(sender);
        
        event::emit(GoalVerified {
            circle_id: object::uid_to_inner(&circle.id),
            verifier: sender,
            verification_time: clock::timestamp_ms(clock),
        });
        
        process_goal_completion(circle, treasury, clock, ctx);
    }

    // Add function to record individual contribution
    fun record_goal_contribution(
        circle: &mut NjangiCircle,
        member: address,
        amount: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        if (option::is_some(&mut circle.smart_goal)) {
            let goal = option::borrow_mut(&mut circle.smart_goal);
            let contribution = ContributionRecord {
                amount,
                timestamp: clock::timestamp_ms(clock),
                cycle: circle.current_cycle,
            };
            
            if (!table::contains(&goal.contribution_history, member)) {
                table::add(&mut goal.contribution_history, member, vector::empty());
            };
            
            let history = table::borrow_mut(&mut goal.contribution_history, member);
            vector::push_back(history, contribution);
        };
    }

    // Add function to get goal progress
    public fun get_goal_progress(
        circle: &NjangiCircle,
        treasury: &CircleTreasury,
        clock: &Clock,
    ): (u64, u64, vector<Milestone>) {
        assert!(option::is_some(&circle.smart_goal), EINVALID_GOAL_TYPE);
        let goal = option::borrow(&circle.smart_goal);
        
        let progress_percentage = if (goal.goal_type == GOAL_TYPE_AMOUNT) {
            (goal.current_amount * 100) / goal.target_amount
        } else {
            let total_duration = goal.target_date - goal.start_date;
            let elapsed = clock::timestamp_ms(clock) - goal.start_date;
            (elapsed * 100) / total_duration
        };
        
        (goal.current_amount, progress_percentage, *&goal.milestones)
    }

    // Add function to process goal completion
    fun process_goal_completion(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let goal = option::borrow(&circle.smart_goal);
        let total_amount = goal.current_amount;
        
        if (goal.distribution_type == 0) {
            // Equal distribution - automatically transfer to each member
            let share_amount = total_amount / circle.member_count;
            let i = 0;
            while (i < vector::length(&circle.members)) {
                let member = vector::borrow(&circle.members, i);
                let payout = coin::split(&mut treasury.balance, share_amount, ctx);
                transfer::public_transfer(payout, *member);
                
                // Return security deposit for member in good standing
                if (table::contains(&circle.member_deposits, *member)) {
                    let deposit_amount = *table::borrow(&circle.member_deposits, *member);
                    let deposit = coin::split(&mut treasury.balance, deposit_amount, ctx);
                    transfer::public_transfer(deposit, *member);
                    table::remove(&mut circle.member_deposits, *member);
                    
                    event::emit(SecurityDepositReturned {
                        circle_id: object::uid_to_inner(&circle.id),
                        member: *member,
                        amount: deposit_amount,
                        reason: b"Smart goal completed",
                    });
                };
                
                event::emit(PayoutMade {
                    circle_id: object::uid_to_inner(&circle.id),
                    recipient: *member,
                    amount: share_amount,
                    cycle: circle.current_cycle,
                });
                
                i = i + 1;
            };
        } else {
            // Proportional distribution based on contributions
            let i = 0;
            while (i < vector::length(&circle.members)) {
                let member = vector::borrow(&circle.members, i);
                let member_state = table::borrow(&circle.member_states, *member);
                let contribution_ratio = (member_state.total_contributions * 100) / total_amount;
                let payout_amount = (total_amount * contribution_ratio) / 100;
                
                let payout = coin::split(&mut treasury.balance, payout_amount, ctx);
                transfer::public_transfer(payout, *member);
                
                // Return security deposit for member in good standing
                if (table::contains(&circle.member_deposits, *member)) {
                    let deposit_amount = *table::borrow(&circle.member_deposits, *member);
                    let deposit = coin::split(&mut treasury.balance, deposit_amount, ctx);
                    transfer::public_transfer(deposit, *member);
                    table::remove(&mut circle.member_deposits, *member);
                    
                    event::emit(SecurityDepositReturned {
                        circle_id: object::uid_to_inner(&circle.id),
                        member: *member,
                        amount: deposit_amount,
                        reason: b"Smart goal completed",
                    });
                };
                
                event::emit(PayoutMade {
                    circle_id: object::uid_to_inner(&circle.id),
                    recipient: *member,
                    amount: payout_amount,
                    cycle: circle.current_cycle,
                });
                
                i = i + 1;
            };
        };

        // Update goal status
        if (option::is_some(&mut circle.smart_goal)) {
            let goal = option::borrow_mut(&mut circle.smart_goal);
            goal.completed = true;
            circle.status = CIRCLE_STATUS_COMPLETED;
        };

        event::emit(GoalDistributionCompleted {
            circle_id: object::uid_to_inner(&circle.id),
            total_amount,
            distribution_type: goal.distribution_type,
            completion_time: clock::timestamp_ms(clock),
        });
    }

    // Add function to process final rotational cycle
    fun process_final_rotational_cycle(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let cycle_info = option::borrow(&circle.current_cycle_info);
        let total_payout = circle.contribution_amount * circle.member_count;
        assert!(coin::value(&treasury.balance) >= total_payout, EINSUFFICIENT_TREASURY_BALANCE);
        
        // Process final payout
        let payout = coin::split(&mut treasury.balance, total_payout, ctx);
        transfer::public_transfer(payout, cycle_info.payout_recipient);

        // Return security deposits to all members in good standing
        let i = 0;
        while (i < vector::length(&circle.members)) {
            let member = vector::borrow(&circle.members, i);
            if (table::contains(&circle.member_deposits, *member)) {
                let member_state = table::borrow(&circle.member_states, *member);
                if (member_state.status == MEMBER_STATUS_ACTIVE) {
                    let deposit_amount = *table::borrow(&circle.member_deposits, *member);
                    let deposit = coin::split(&mut treasury.balance, deposit_amount, ctx);
                    transfer::public_transfer(deposit, *member);
                    table::remove(&mut circle.member_deposits, *member);
                    
                    event::emit(SecurityDepositReturned {
                        circle_id: object::uid_to_inner(&circle.id),
                        member: *member,
                        amount: deposit_amount,
                        reason: b"Rotational circle completed",
                    });
                };
            };
            i = i + 1;
        };

        // Update circle status
        circle.status = CIRCLE_STATUS_COMPLETED;

        event::emit(CircleCompleted {
            circle_id: object::uid_to_inner(&circle.id),
            completion_time: clock::timestamp_ms(clock),
            total_cycles: circle.current_cycle,
        });
    }

    // Add new events
    struct SecurityDepositReturned has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        reason: vector<u8>,
    }

    struct CircleCompleted has copy, drop {
        circle_id: ID,
        completion_time: u64,
        total_cycles: u64,
    }

    // Add function to check if payout is due and process it
    public fun check_and_process_payout(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(circle.status == CIRCLE_STATUS_ACTIVE, ECIRCLE_NOT_ACTIVE);
        
        if (clock::timestamp_ms(clock) >= circle.next_payout_time) {
            process_payout(circle, treasury, clock, ctx);
        };
    }

    // Add event for goal distribution
    struct GoalDistributionCompleted has copy, drop {
        circle_id: ID,
        total_amount: u64,
        distribution_type: u8,
        completion_time: u64,
    }

    struct AuctionBid has store {
        bidder: address,
        bid_amount: u64,
        timestamp: u64,
    }

    // Add new structs for cycle management
    struct CycleInfo has store {
        cycle_number: u64,
        start_time: u64,
        end_time: u64,
        total_collected: u64,
        contributors: vector<address>,
        payout_recipient: address,
        payout_completed: bool,
        payout_time: Option<u64>,
    }

    struct RotationHistory has store {
        cycles: Table<u64, CycleInfo>,  // Map cycle number to cycle info
        last_completed_cycle: u64,
        total_cycles_completed: u64,
    }

    // Add new events for cycle management
    struct CycleStarted has copy, drop {
        circle_id: ID,
        cycle_number: u64,
        start_time: u64,
        expected_end_time: u64,
        payout_recipient: address,
    }

    struct CycleCompleted has copy, drop {
        circle_id: ID,
        cycle_number: u64,
        total_collected: u64,
        completion_time: u64,
    }

    struct ContributionRecorded has copy, drop {
        circle_id: ID,
        cycle_number: u64,
        contributor: address,
        amount: u64,
        remaining_contributors: u64,
    }

    // Add function to initialize rotation tracking
    fun initialize_rotation_tracking(
        circle: &mut NjangiCircle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(circle.cycle_type == CIRCLE_TYPE_ROTATIONAL, EINVALID_CYCLE_TYPE);
        
        // Initialize rotation history
        let rotation_history = RotationHistory {
            cycles: table::new(ctx),
            last_completed_cycle: 0,
            total_cycles_completed: 0,
        };

        // Initialize first cycle
        let current_recipient = vector::borrow(&circle.rotation_order, 0);
        let current_cycle = CycleInfo {
            cycle_number: 1,
            start_time: clock::timestamp_ms(clock),
            end_time: calculate_next_payout_time(circle, clock),
            total_collected: 0,
            contributors: vector::empty(),
            payout_recipient: *current_recipient,
            payout_completed: false,
            payout_time: option::none(),
        };

        circle.rotation_history = option::some(rotation_history);
        circle.current_cycle_info = option::some(current_cycle);

        event::emit(CycleStarted {
            circle_id: object::uid_to_inner(&circle.id),
            cycle_number: 1,
            start_time: clock::timestamp_ms(clock),
            expected_end_time: calculate_next_payout_time(circle, clock),
            payout_recipient: *current_recipient,
        });
    }

    // Add function to setup next cycle
    fun setup_next_cycle(
        circle: &mut NjangiCircle,
        clock: &Clock,
    ) {
        let next_cycle_number = circle.current_cycle + 1;
        let next_recipient_index = (next_cycle_number - 1) % vector::length(&circle.rotation_order);
        let next_recipient = *vector::borrow(&circle.rotation_order, next_recipient_index);

        let next_cycle = CycleInfo {
            cycle_number: next_cycle_number,
            start_time: clock::timestamp_ms(clock),
            end_time: calculate_next_payout_time(circle, clock),
            total_collected: 0,
            contributors: vector::empty(),
            payout_recipient: next_recipient,
            payout_completed: false,
            payout_time: option::none(),
        };

        circle.current_cycle = next_cycle_number;
        circle.current_cycle_info = option::some(next_cycle);

        event::emit(CycleStarted {
            circle_id: object::uid_to_inner(&circle.id),
            cycle_number: next_cycle_number,
            start_time: clock::timestamp_ms(clock),
            expected_end_time: calculate_next_payout_time(circle, clock),
            payout_recipient: next_recipient,
        });
    }

    // Add function to get cycle information
    public fun get_cycle_info(
        circle: &NjangiCircle,
        cycle_number: u64,
    ): Option<CycleInfo> {
        if (option::is_some(&circle.rotation_history)) {
            let history = option::borrow(&circle.rotation_history);
            if (table::contains(&history.cycles, cycle_number)) {
                option::some(*table::borrow(&history.cycles, cycle_number))
            } else {
                option::none()
            }
        } else {
            option::none()
        }
    }

    // Add function to get current cycle status
    public fun get_current_cycle_status(
        circle: &NjangiCircle,
    ): (u64, u64, vector<address>, address, bool) {
        let cycle_info = option::borrow(&circle.current_cycle_info);
        (
            cycle_info.cycle_number,
            cycle_info.total_collected,
            *&cycle_info.contributors,
            cycle_info.payout_recipient,
            cycle_info.payout_completed
        )
    }

    // Add authentication capability
    struct AdminCap has key {
        id: UID,
        circle_id: ID,
    }

    // Add verification capability
    struct VerifierCap has key {
        id: UID,
        circle_id: ID,
        expiry: u64,
    }

    // Add member capability for secure operations
    struct MemberCap has key {
        id: UID,
        circle_id: ID,
        member: address,
        join_time: u64,
    }

    // Add state validation struct
    struct CircleState has store {
        last_operation_time: u64,
        last_operation_type: u8,
        operation_sequence: u64,
        is_locked: bool,
        lock_reason: Option<vector<u8>>,
        last_state_update: u64,
    }

    // Constants for operation types
    const OPERATION_CONTRIBUTION: u8 = 0;
    const OPERATION_PAYOUT: u8 = 1;
    const OPERATION_MEMBER_UPDATE: u8 = 2;
    const OPERATION_GOAL_UPDATE: u8 = 3;
    const OPERATION_GOVERNANCE: u8 = 4;

    // Add function to create admin capability
    public fun create_admin_cap(
        circle: &NjangiCircle,
        ctx: &mut TxContext
    ): AdminCap {
        assert!(tx_context::sender(ctx) == circle.admin, ENO_PERMISSION);
        AdminCap {
            id: object::new(ctx),
            circle_id: object::uid_to_inner(&circle.id),
        }
    }

    // Add function to create verifier capability
    public fun create_verifier_cap(
        circle: &NjangiCircle,
        expiry: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): VerifierCap {
        assert!(tx_context::sender(ctx) == circle.admin, ENO_PERMISSION);
        assert!(expiry > clock::timestamp_ms(clock), EINVALID_TIMESTAMP);
        
        VerifierCap {
            id: object::new(ctx),
            circle_id: object::uid_to_inner(&circle.id),
            expiry,
        }
    }

    // Add function to create member capability
    public fun create_member_cap(
        circle: &NjangiCircle,
        clock: &Clock,
        ctx: &mut TxContext
    ): MemberCap {
        let sender = tx_context::sender(ctx);
        assert!(vector::contains(&circle.members, &sender), EMEMBER_NOT_FOUND);
        
        MemberCap {
            id: object::new(ctx),
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            join_time: clock::timestamp_ms(clock),
        }
    }

    // Add function to validate circle state
    fun validate_circle_state(
        circle: &mut NjangiCircle,
        operation_type: u8,
        clock: &Clock,
    ) {
        assert!(!circle.state.is_locked, EINVALID_CYCLE_STATE);
        assert!(circle.current_concurrent_operations < circle.max_concurrent_operations, 
            EINVALID_OPERATION_SEQUENCE);

        // Validate operation sequence
        if (operation_type == OPERATION_PAYOUT) {
            assert!(circle.state.last_operation_type == OPERATION_CONTRIBUTION, 
                EINVALID_OPERATION_SEQUENCE);
        };

        // Update state
        circle.state.last_operation_time = clock::timestamp_ms(clock);
        circle.state.last_operation_type = operation_type;
        circle.state.operation_sequence = circle.state.operation_sequence + 1;
        circle.current_concurrent_operations = circle.current_concurrent_operations + 1;
    }

    // Add function to release operation lock
    fun release_operation(circle: &mut NjangiCircle) {
        assert!(circle.current_concurrent_operations > 0, EINVALID_OPERATION_SEQUENCE);
        circle.current_concurrent_operations = circle.current_concurrent_operations - 1;
    }

    // Add function to handle concurrent contribution validation
    fun validate_concurrent_contributions(
        circle: &NjangiCircle,
        cycle_info: &CycleInfo,
        member: address
    ): bool {
        // Check if member has already contributed
        if (vector::contains(&cycle_info.contributors, &member)) {
            return false
        };
        
        // Check if member is allowed to contribute in current state
        let member_state = table::borrow(&circle.member_states, member);
        member_state.status == MEMBER_STATUS_ACTIVE
    }

    // Add function for secure rotation order management
    fun validate_and_update_rotation_order(
        circle: &mut NjangiCircle,
        admin_cap: &AdminCap,
        ctx: &mut TxContext
    ) {
        assert!(object::uid_to_inner(&circle.id) == admin_cap.circle_id, EINVALID_AUTHENTICATION);
        assert!(vector::length(&circle.members) <= circle.max_members, EMEMBER_LIMIT_EXCEEDED);
        
        // Create new rotation order based on current members
        let new_rotation = *&circle.members;
        // TODO: Implement shuffle or custom ordering logic
        
        circle.rotation_order = new_rotation;
    }

    // Add function to verify treasury state
    fun verify_treasury_state(
        circle: &NjangiCircle,
        treasury: &CircleTreasury,
    ): bool {
        // Verify treasury belongs to circle
        if (object::uid_to_inner(&treasury.id) != circle.treasury_id) {
            return false
        };
        
        // Verify treasury balance matches recorded contributions
        coin::value(&treasury.balance) >= treasury.total_contributions
    }

    // Add new struct for treasury reconciliation
    struct TreasuryReconciliation has store {
        last_reconciliation_time: u64,
        total_recorded_contributions: u64,
        actual_balance: u64,
        discrepancy_amount: u64,
        reconciliation_status: u8,
        reconciliation_history: vector<ReconciliationRecord>,
    }

    struct ReconciliationRecord has store {
        timestamp: u64,
        discrepancy_amount: u64,
        resolution_type: u8,
        resolved: bool,
    }

    // Add new struct for rotation order management
    struct RotationOrderConfig has store {
        is_locked: bool,
        last_modified: u64,
        modification_count: u64,
        seed: vector<u8>,
        order_type: u8, // 0: Random, 1: First-come, 2: Custom
        custom_priority: Table<address, u64>,
    }

    // Constants for rotation order types
    const ROTATION_ORDER_RANDOM: u8 = 0;
    const ROTATION_ORDER_FIRST_COME: u8 = 1;
    const ROTATION_ORDER_CUSTOM: u8 = 2;

    // Add function to reconcile treasury
    public fun reconcile_treasury(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        admin_cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(object::uid_to_inner(&circle.id) == admin_cap.circle_id, EINVALID_AUTHENTICATION);
        
        let actual_balance = coin::value(&treasury.balance);
        let recorded_total = treasury.total_contributions;
        
        if (actual_balance != recorded_total) {
            let discrepancy = if (actual_balance > recorded_total) {
                actual_balance - recorded_total
            } else {
                recorded_total - actual_balance
            };
            
            let record = ReconciliationRecord {
                timestamp: clock::timestamp_ms(clock),
                discrepancy_amount: discrepancy,
                resolution_type: 0,
                resolved: false,
            };
            
            vector::push_back(&mut circle.treasury_reconciliation.reconciliation_history, record);
            circle.treasury_reconciliation.discrepancy_amount = discrepancy;
            circle.treasury_reconciliation.actual_balance = actual_balance;
            circle.treasury_reconciliation.total_recorded_contributions = recorded_total;
            
            // Emit reconciliation event
            event::emit(TreasuryReconciled {
                circle_id: object::uid_to_inner(&circle.id),
                discrepancy_amount: discrepancy,
                timestamp: clock::timestamp_ms(clock),
            });
        };
        
        circle.treasury_reconciliation.last_reconciliation_time = clock::timestamp_ms(clock);
    }

    // Add function to implement secure rotation order
    public fun set_rotation_order(
        circle: &mut NjangiCircle,
        order_type: u8,
        seed: vector<u8>,
        admin_cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(object::uid_to_inner(&circle.id) == admin_cap.circle_id, EINVALID_AUTHENTICATION);
        assert!(!circle.rotation_config.is_locked, EROTATION_ORDER_LOCKED);
        
        if (order_type == ROTATION_ORDER_RANDOM) {
            // Implement Fisher-Yates shuffle with seed
            let members_copy = *&circle.members;
            let len = vector::length(&members_copy);
            let i = len;
            
            while (i > 1) {
                i = i - 1;
                let seed_byte = if (i < vector::length(&seed)) {
                    *vector::borrow(&seed, i)
                } else {
                    (clock::timestamp_ms(clock) as u8)
                };
                let j = ((seed_byte as u64) % i) as u64;
                vector::swap(&mut circle.rotation_order, i, j);
            };
        } else if (order_type == ROTATION_ORDER_FIRST_COME) {
            // Use existing member order
            circle.rotation_order = *&circle.members;
        };
        
        // Lock rotation order
        circle.rotation_config.is_locked = true;
        circle.rotation_config.last_modified = clock::timestamp_ms(clock);
        circle.rotation_config.modification_count = circle.rotation_config.modification_count + 1;
        
        // Update member indices for O(1) lookups
        let i = 0;
        while (i < vector::length(&circle.rotation_order)) {
            let member = vector::borrow(&circle.rotation_order, i);
            table::upsert(&mut circle.member_index, *member, i);
            i = i + 1;
        };
        
        event::emit(RotationOrderSet {
            circle_id: object::uid_to_inner(&circle.id),
            order_type,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // Add function to handle proposal execution failures
    fun handle_proposal_execution_failure(
        circle: &mut NjangiCircle,
        proposal_id: ID,
        error_code: u64,
        ctx: &mut TxContext
    ) {
        let proposal = table::borrow_mut(&mut circle.proposals, proposal_id);
        
        // Record failure
        event::emit(ProposalExecutionFailed {
            circle_id: object::uid_to_inner(&circle.id),
            proposal_id,
            error_code,
        });
        
        // Reset proposal state
        proposal.executed = false;
        
        // Optionally refund proposal deposit
        if (proposal.proposal_type == PROPOSAL_TYPE_GOVERNANCE) {
            // Handle governance proposal failure
            circle.governance_config.proposal_threshold = 
                circle.governance_config.proposal_threshold / 2; // Reduce threshold temporarily
        };
    }

    // Add function to get circle summary
    public fun get_circle_summary(
        circle: &NjangiCircle,
        treasury: &CircleTreasury,
        clock: &Clock,
    ): CircleSummary {
        let (current_cycle, total_collected, contributors, recipient, completed) = 
            get_current_cycle_status(circle);
            
        CircleSummary {
            circle_id: object::uid_to_inner(&circle.id),
            member_count: circle.member_count,
            total_contributions: treasury.total_contributions,
            current_cycle,
            cycle_progress: calculate_cycle_progress(circle, clock),
            active_proposals: count_active_proposals(circle),
            treasury_balance: coin::value(&treasury.balance),
            next_payout_time: circle.next_payout_time,
            circle_status: circle.status,
            current_recipient: recipient,
        }
    }

    // Add helper function to calculate cycle progress
    fun calculate_cycle_progress(circle: &NjangiCircle, clock: &Clock): u64 {
        let current_time = clock::timestamp_ms(clock);
        let cycle_start = if (option::is_some(&circle.current_cycle_info)) {
            option::borrow(&circle.current_cycle_info).start_time
        } else {
            current_time
        };
        
        let cycle_duration = circle.next_payout_time - cycle_start;
        let elapsed = current_time - cycle_start;
        
        if (cycle_duration == 0) {
            return 100
        };
        
        (elapsed * 100) / cycle_duration
    }

    // Add helper function to count active proposals
    fun count_active_proposals(circle: &NjangiCircle): u64 {
        let count = 0;
        let proposals = &circle.proposals;
        let keys = table::keys(proposals);
        let i = 0;
        
        while (i < vector::length(&keys)) {
            let proposal = table::borrow(proposals, *vector::borrow(&keys, i));
            if (!proposal.executed) {
                count = count + 1;
            };
            i = i + 1;
        };
        
        count
    }

    // Add new events
    struct TreasuryReconciled has copy, drop {
        circle_id: ID,
        discrepancy_amount: u64,
        timestamp: u64,
    }

    struct RotationOrderSet has copy, drop {
        circle_id: ID,
        order_type: u8,
        timestamp: u64,
    }

    struct ProposalExecutionFailed has copy, drop {
        circle_id: ID,
        proposal_id: ID,
        error_code: u64,
    }

    // Add struct for circle summary
    struct CircleSummary has copy, drop {
        circle_id: ID,
        member_count: u64,
        total_contributions: u64,
        current_cycle: u64,
        cycle_progress: u64,
        active_proposals: u64,
        treasury_balance: u64,
        next_payout_time: u64,
        circle_status: u8,
        current_recipient: address,
    }

    // Update member lookup to use index
    fun get_member_index(circle: &NjangiCircle, member: address): Option<u64> {
        if (table::contains(&circle.member_index, member)) {
            option::some(*table::borrow(&circle.member_index, member))
        } else {
            option::none()
        }
    }

    // Update member validation to use index
    fun is_member(circle: &NjangiCircle, member: address): bool {
        table::contains(&circle.member_index, member)
    }

    // Add batch operation struct for optimized processing
    struct BatchOperation has store {
        operation_type: u8,
        items: vector<ID>,
        batch_size: u64,
        processed_count: u64,
        start_time: u64,
        status: u8,
    }

    // Constants for batch operations
    const BATCH_SIZE: u64 = 50;
    const BATCH_STATUS_PENDING: u8 = 0;
    const BATCH_STATUS_PROCESSING: u8 = 1;
    const BATCH_STATUS_COMPLETED: u8 = 2;

    // Optimize rotation order update with batching
    public fun update_rotation_order_batch(
        circle: &mut NjangiCircle,
        admin_cap: &AdminCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(object::uid_to_inner(&circle.id) == admin_cap.circle_id, EINVALID_AUTHENTICATION);
        
        let total_members = vector::length(&circle.members);
        let batch_count = (total_members + BATCH_SIZE - 1) / BATCH_SIZE;
        let mut i = 0;
        
        while (i < batch_count) {
            let start_idx = i * BATCH_SIZE;
            let end_idx = if (start_idx + BATCH_SIZE > total_members) {
                total_members
            } else {
                start_idx + BATCH_SIZE
            };
            
            process_rotation_order_batch(circle, start_idx, end_idx, clock, ctx);
            i = i + 1;
        };
    }

    // Process rotation order in batches
    fun process_rotation_order_batch(
        circle: &mut NjangiCircle,
        start_idx: u64,
        end_idx: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let i = start_idx;
        while (i < end_idx && i < vector::length(&circle.members)) {
            let member = vector::borrow(&circle.members, i);
            table::upsert(&mut circle.member_index, *member, i);
            i = i + 1;
        };
    }

    // Optimize treasury reconciliation with checkpoints
    struct ReconciliationCheckpoint has store {
        checkpoint_time: u64,
        last_processed_contribution: u64,
        processed_members: vector<address>,
        interim_balance: u64,
    }

    // Add checkpoint to treasury reconciliation
    public fun create_reconciliation_checkpoint(
        circle: &mut NjangiCircle,
        treasury: &CircleTreasury,
        clock: &Clock,
        ctx: &mut TxContext
    ): ReconciliationCheckpoint {
        ReconciliationCheckpoint {
            checkpoint_time: clock::timestamp_ms(clock),
            last_processed_contribution: treasury.total_contributions,
            processed_members: vector::empty(),
            interim_balance: coin::value(&treasury.balance),
        }
    }

    // Optimize treasury reconciliation with batching and checkpoints
    public fun reconcile_treasury_batch(
        circle: &mut NjangiCircle,
        treasury: &mut CircleTreasury,
        admin_cap: &AdminCap,
        checkpoint: &mut ReconciliationCheckpoint,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(object::uid_to_inner(&circle.id) == admin_cap.circle_id, EINVALID_AUTHENTICATION);
        
        let current_balance = coin::value(&treasury.balance);
        let balance_change = current_balance - checkpoint.interim_balance;
        
        // Process members in batches
        let remaining_members = filter_unprocessed_members(circle, checkpoint);
        let batch_size = BATCH_SIZE;
        let i = 0;
        
        while (i < vector::length(&remaining_members) && i < batch_size) {
            let member = vector::borrow(&remaining_members, i);
            process_member_reconciliation(circle, treasury, *member, clock, ctx);
            vector::push_back(&mut checkpoint.processed_members, *member);
            i = i + 1;
        };
        
        // Update checkpoint
        checkpoint.interim_balance = current_balance;
        checkpoint.last_processed_contribution = treasury.total_contributions;
        
        // Check if reconciliation is complete
        if (vector::length(&checkpoint.processed_members) == circle.member_count) {
            finalize_reconciliation(circle, treasury, balance_change, clock, ctx);
        };
    }

    // Helper function to filter unprocessed members
    fun filter_unprocessed_members(
        circle: &NjangiCircle,
        checkpoint: &ReconciliationCheckpoint
    ): vector<address> {
        let remaining = vector::empty();
        let i = 0;
        while (i < vector::length(&circle.members)) {
            let member = vector::borrow(&circle.members, i);
            if (!vector::contains(&checkpoint.processed_members, member)) {
                vector::push_back(&mut remaining, *member);
            };
            i = i + 1;
        };
        remaining
    }

    // Process individual member reconciliation
    fun process_member_reconciliation(
        circle: &mut NjangiCircle,
        treasury: &CircleTreasury,
        member: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        if (table::contains(&circle.member_states, member)) {
            let member_state = table::borrow(&circle.member_states, member);
            // Process member contributions and update records
            // This can be customized based on specific reconciliation requirements
        };
    }

    // Finalize reconciliation process
    fun finalize_reconciliation(
        circle: &mut NjangiCircle,
        treasury: &CircleTreasury,
        balance_change: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let record = ReconciliationRecord {
            timestamp: clock::timestamp_ms(clock),
            discrepancy_amount: balance_change,
            resolution_type: 0,
            resolved: true,
        };
        
        vector::push_back(&mut circle.treasury_reconciliation.reconciliation_history, record);
        
        event::emit(TreasuryReconciled {
            circle_id: object::uid_to_inner(&circle.id),
            discrepancy_amount: balance_change,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // Add event for batch operations
    struct BatchOperationCompleted has copy, drop {
        circle_id: ID,
        operation_type: u8,
        items_processed: u64,
        completion_time: u64,
    }

    // Add function to track batch operation progress
    public fun get_batch_progress(
        circle: &NjangiCircle,
        batch: &BatchOperation
    ): (u64, u64, u8) {
        (
            batch.processed_count,
            batch.batch_size,
            batch.status
        )
    }
} 