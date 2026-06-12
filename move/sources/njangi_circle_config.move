module njangi::njangi_circle_config {
    use sui::clock::{Self, Clock};
    use sui::dynamic_field;
    use std::string::{Self, String};

    use njangi::njangi_core as core;

    // Constants for dynamic field keys
    const FIELD_CIRCLE_CONFIG: vector<u8> = b"circle_config";
    const FIELD_MILESTONE_CONFIG: vector<u8> = b"milestone_config";
    const FIELD_PENALTIES_CONFIG: vector<u8> = b"penalties_config";

    // Recovery state constants
    const RECOVERY_STATE_ACTIVE: u8 = 0;
    const RECOVERY_STATE_PROPOSAL_PENDING: u8 = 1;
    const RECOVERY_STATE_STOPPED: u8 = 2;
    const RECOVERY_STATE_REFUNDED: u8 = 3;

    // Error codes
    const EInvalidCycleLength: u64 = 62;
    const EInvalidAutoReleaseDelay: u64 = 63;
    const ERecoveryProposalAlreadyExists: u64 = 64;
    const ERecoveryProposalMissing: u64 = 65;
    const EInvalidRecoveryDeadline: u64 = 66;
    const EInvalidRecoveryStateTransition: u64 = 67;
    const ERecoveryDelegateRequired: u64 = 68;

    // Circle configuration struct
    public struct CircleConfig has store, drop {
        // Circle basic settings
        contribution_amount: u64,         // SUI amount with 9 decimals - this is the ACTUAL SUI value
        security_deposit: u64,            // SUI amount with 9 decimals - this is the ACTUAL SUI value
        currency_type: String,            // Currency code (e.g., "USD", "XAF", "NGN")
        contribution_amount_local: u64,   // Amount in local currency (with appropriate decimals)
        security_deposit_local: u64,      // Amount in local currency (with appropriate decimals)
        contribution_amount_usd: u64,     // USD equivalent amount (in cents, for validation)
        security_deposit_usd: u64,        // USD equivalent amount (in cents, for validation)
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        rotation_style: u8,
        max_members: u64,
        auto_swap_enabled: bool,
        recovery_state: u8,
        recovery_proposal: Option<RecoveryProposal>,
        recovery_state_updated_at: u64,
        auto_release_enabled: bool,
        auto_release_delay_ms: u64,
        next_in_command: Option<address>,
        auto_release_start_time: u64
    }

    public struct RecoveryVote has copy, drop, store {
        voter: address,
        approved: bool,
        voted_at: u64,
    }

    public struct RecoveryProposal has copy, drop, store {
        proposer: address,
        created_at: u64,
        deadline: u64,
        passed_at: Option<u64>,
        eligible_voters: vector<address>,
        votes: vector<RecoveryVote>,
        yes_votes: u64,
        no_votes: u64,
        majority_threshold: u64,
    }

    // Milestone configuration struct
    public struct MilestoneConfig has store, drop {
        // Goal/Milestone settings
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_local: Option<u64>,  // Amount in local currency
        target_date: Option<u64>,
        verification_required: bool,
        goal_progress: u64,
        last_milestone_completed: u64
    }

    // Penalties configuration struct
    public struct PenaltyRules has store, drop {
        late_payment: bool,
        missed_meeting: bool,
        late_payment_fee: u64,
        missed_meeting_fee: u64,
        warning_penalty_amount: u64,
        allow_penalty_payments: bool
    }

    // ===== Functions to create configurations =====

    // Create a new circle configuration
    public fun create_circle_config(
        contribution_amount: u64,
        security_deposit: u64,
        currency_type: String,
        contribution_amount_local: u64,
        security_deposit_local: u64,
        contribution_amount_usd: u64,
        security_deposit_usd: u64,
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        rotation_style: u8,
        max_members: u64,
        auto_swap_enabled: bool,
        auto_release_enabled: bool,
        auto_release_delay_ms: u64,
        next_in_command: Option<address>,
        clock: &Clock
    ): CircleConfig {
        let normalized_auto_release_delay_ms = normalize_auto_release_delay_ms(
            cycle_length,
            auto_release_enabled,
            auto_release_delay_ms
        );
        let current_time = clock::timestamp_ms(clock);

        CircleConfig {
            contribution_amount,
            security_deposit,
            currency_type,
            contribution_amount_local,
            security_deposit_local,
            contribution_amount_usd,
            security_deposit_usd,
            cycle_length,
            cycle_day,
            circle_type,
            rotation_style,
            max_members,
            auto_swap_enabled,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: current_time,
            auto_release_enabled,
            auto_release_delay_ms: normalized_auto_release_delay_ms,
            next_in_command,
            auto_release_start_time: current_time
        }
    }

    // Create a new milestone configuration
    public fun create_milestone_config(
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_local: Option<u64>,
        target_date: Option<u64>,
        verification_required: bool
    ): MilestoneConfig {
        MilestoneConfig {
            goal_type,
            target_amount,
            target_amount_local,
            target_date,
            verification_required,
            goal_progress: 0,
            last_milestone_completed: 0
        }
    }

    // Create penalty rules configuration
    public fun create_penalty_rules(rules: vector<bool>): PenaltyRules {
        PenaltyRules {
            late_payment: *std::vector::borrow(&rules, 0),
            missed_meeting: *std::vector::borrow(&rules, 1),
            late_payment_fee: 5,
            missed_meeting_fee: 2,
            warning_penalty_amount: 50000000000, // 50 SUI with 9 decimals
            allow_penalty_payments: true,
        }
    }

    // ===== Functions to attach configs to objects =====

    // Attach circle config to an object with UID
    public fun attach_circle_config(obj: &mut UID, config: CircleConfig) {
        dynamic_field::add(obj, FIELD_CIRCLE_CONFIG, config);
    }

    // Attach milestone config to an object with UID
    public fun attach_milestone_config(obj: &mut UID, config: MilestoneConfig) {
        dynamic_field::add(obj, FIELD_MILESTONE_CONFIG, config);
    }

    // Attach penalty rules to an object with UID
    public fun attach_penalty_rules(obj: &mut UID, rules: PenaltyRules) {
        dynamic_field::add(obj, FIELD_PENALTIES_CONFIG, rules);
    }

    // ===== Getter functions =====

    // Get circle config from an object
    public fun get_circle_config(obj: &UID): &CircleConfig {
        dynamic_field::borrow(obj, FIELD_CIRCLE_CONFIG)
    }

    // Get mutable circle config from an object
    public fun get_circle_config_mut(obj: &mut UID): &mut CircleConfig {
        dynamic_field::borrow_mut(obj, FIELD_CIRCLE_CONFIG)
    }

    // Get milestone config from an object
    public fun get_milestone_config(obj: &UID): &MilestoneConfig {
        dynamic_field::borrow(obj, FIELD_MILESTONE_CONFIG)
    }

    // Get mutable milestone config from an object
    public fun get_milestone_config_mut(obj: &mut UID): &mut MilestoneConfig {
        dynamic_field::borrow_mut(obj, FIELD_MILESTONE_CONFIG)
    }

    // Get penalty rules from an object
    public fun get_penalty_rules(obj: &UID): &PenaltyRules {
        dynamic_field::borrow(obj, FIELD_PENALTIES_CONFIG)
    }

    // Get mutable penalty rules from an object
    public fun get_penalty_rules_mut(obj: &mut UID): &mut PenaltyRules {
        dynamic_field::borrow_mut(obj, FIELD_PENALTIES_CONFIG)
    }

    // ===== Helper functions for specific values =====

    // Get contribution amount
    public fun get_contribution_amount(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.contribution_amount
    }

    // Get security deposit
    public fun get_security_deposit(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.security_deposit
    }

    // Get currency type
    public fun get_currency_type(obj: &UID): String {
        let config = get_circle_config(obj);
        config.currency_type
    }

    // Get contribution amount in local currency
    public fun get_contribution_amount_local(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.contribution_amount_local
    }

    // Get security deposit in local currency
    public fun get_security_deposit_local(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.security_deposit_local
    }

    // Get cycle length
    public fun get_cycle_length(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.cycle_length
    }

    // Get cycle day
    public fun get_cycle_day(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.cycle_day
    }

    // Get max members
    public fun get_max_members(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.max_members
    }

    // Check if auto swap is enabled
    public fun is_auto_swap_enabled(obj: &UID): bool {
        let config = get_circle_config(obj);
        config.auto_swap_enabled
    }

    public fun get_recovery_state(obj: &UID): u8 {
        let config = get_circle_config(obj);
        config.recovery_state
    }

    public fun get_recovery_state_updated_at(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.recovery_state_updated_at
    }

    public fun has_recovery_proposal(obj: &UID): bool {
        let config = get_circle_config(obj);
        option::is_some(&config.recovery_proposal)
    }

    public fun get_recovery_proposal(obj: &UID): Option<RecoveryProposal> {
        let config = get_circle_config(obj);
        config.recovery_proposal
    }

    public fun get_recovery_proposal_proposer(obj: &UID): Option<address> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            option::some(proposal.proposer)
        } else {
            option::none()
        }
    }

    public fun get_recovery_proposal_created_at(obj: &UID): Option<u64> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            option::some(proposal.created_at)
        } else {
            option::none()
        }
    }

    public fun get_recovery_proposal_deadline(obj: &UID): Option<u64> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            option::some(proposal.deadline)
        } else {
            option::none()
        }
    }

    public fun get_recovery_proposal_passed_at(obj: &UID): Option<u64> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            proposal.passed_at
        } else {
            option::none()
        }
    }

    public fun get_recovery_majority_threshold(obj: &UID): Option<u64> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            option::some(proposal.majority_threshold)
        } else {
            option::none()
        }
    }

    public fun get_recovery_yes_votes(obj: &UID): u64 {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            proposal.yes_votes
        } else {
            0
        }
    }

    public fun get_recovery_no_votes(obj: &UID): u64 {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            proposal.no_votes
        } else {
            0
        }
    }

    public fun get_recovery_vote_count(obj: &UID): u64 {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            vector::length(&proposal.votes)
        } else {
            0
        }
    }

    public fun get_recovery_eligible_voters(obj: &UID): vector<address> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            proposal.eligible_voters
        } else {
            vector::empty()
        }
    }

    public fun get_recovery_votes(obj: &UID): vector<RecoveryVote> {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            proposal.votes
        } else {
            vector::empty()
        }
    }

    public fun has_recovery_eligible_voter(obj: &UID, voter: address): bool {
        let config = get_circle_config(obj);
        if (option::is_none(&config.recovery_proposal)) {
            return false
        };

        let proposal = option::borrow(&config.recovery_proposal);
        vector::contains(&proposal.eligible_voters, &voter)
    }

    public fun has_recovery_vote_from(obj: &UID, voter: address): bool {
        let config = get_circle_config(obj);
        if (option::is_none(&config.recovery_proposal)) {
            return false
        };

        let proposal = option::borrow(&config.recovery_proposal);
        let mut i = 0;
        let vote_count = vector::length(&proposal.votes);
        while (i < vote_count) {
            let vote = vector::borrow(&proposal.votes, i);
            if (vote.voter == voter) {
                return true
            };
            i = i + 1;
        };
        false
    }

    public fun is_recovery_majority_reached(obj: &UID): bool {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            is_recovery_proposal_passed_internal(proposal)
        } else {
            false
        }
    }

    public fun is_recovery_proposal_passed(obj: &UID): bool {
        let config = get_circle_config(obj);
        if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            is_recovery_proposal_passed_internal(proposal)
        } else {
            false
        }
    }

    public fun is_auto_release_enabled(obj: &UID): bool {
        let config = get_circle_config(obj);
        config.auto_release_enabled
    }

    public fun get_auto_release_delay_ms(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.auto_release_delay_ms
    }

    public fun get_auto_release_start_time(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.auto_release_start_time
    }

    public fun get_auto_release_trigger_time(obj: &UID): Option<u64> {
        let config = get_circle_config(obj);
        auto_release_trigger_time_internal(config)
    }

    public fun has_next_in_command(obj: &UID): bool {
        let config = get_circle_config(obj);
        option::is_some(&config.next_in_command)
    }

    public fun get_next_in_command(obj: &UID): Option<address> {
        let config = get_circle_config(obj);
        config.next_in_command
    }

    public fun get_last_admin_heartbeat_at(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.auto_release_start_time
    }

    public fun get_min_auto_release_delay_ms_for_circle(obj: &UID): u64 {
        let config = get_circle_config(obj);
        min_auto_release_delay_ms(config.cycle_length)
    }

    // Toggle auto swap setting
    public fun toggle_auto_swap(obj: &mut UID, enabled: bool) {
        let config = get_circle_config_mut(obj);
        config.auto_swap_enabled = enabled;
    }

    // Set maximum members limit
    public fun set_max_members(obj: &mut UID, new_max_members: u64) {
        let config = get_circle_config_mut(obj);
        config.max_members = new_max_members;
    }

    // Update contribution and security-deposit requirements.
    public fun set_contribution_requirements(
        obj: &mut UID,
        contribution_amount: u64,
        contribution_amount_local: u64,
        contribution_amount_usd: u64,
        security_deposit: u64,
        security_deposit_local: u64,
        security_deposit_usd: u64
    ) {
        let config = get_circle_config_mut(obj);
        config.contribution_amount = contribution_amount;
        config.contribution_amount_local = contribution_amount_local;
        config.contribution_amount_usd = contribution_amount_usd;
        config.security_deposit = security_deposit;
        config.security_deposit_local = security_deposit_local;
        config.security_deposit_usd = security_deposit_usd;
    }

    // Update payout schedule controls.
    public fun set_cycle_schedule(obj: &mut UID, cycle_length: u64, cycle_day: u64) {
        let config = get_circle_config_mut(obj);
        if (config.auto_release_enabled) {
            let minimum_delay = min_auto_release_delay_ms(cycle_length);
            assert!(config.auto_release_delay_ms > minimum_delay, EInvalidAutoReleaseDelay);
        };
        config.cycle_length = cycle_length;
        config.cycle_day = cycle_day;
    }

    public fun set_auto_release_config(
        obj: &mut UID,
        auto_release_enabled: bool,
        auto_release_delay_ms: u64
    ) {
        let config = get_circle_config_mut(obj);
        config.auto_release_enabled = auto_release_enabled;
        config.auto_release_delay_ms = normalize_auto_release_delay_ms(
            config.cycle_length,
            auto_release_enabled,
            auto_release_delay_ms
        );
    }

    public fun set_next_in_command(obj: &mut UID, next_in_command: Option<address>) {
        let config = get_circle_config_mut(obj);
        config.next_in_command = next_in_command;
    }

    public fun touch_admin_heartbeat(obj: &mut UID, clock: &Clock) {
        let current_time = clock::timestamp_ms(clock);
        let config = get_circle_config_mut(obj);
        touch_admin_heartbeat_internal(config, current_time);
    }

    public fun begin_recovery_proposal(
        obj: &mut UID,
        proposer: address,
        eligible_voters: vector<address>,
        majority_threshold: u64,
        deadline: u64,
        clock: &Clock
    ) {
        let created_at = clock::timestamp_ms(clock);
        let config = get_circle_config_mut(obj);
        begin_recovery_proposal_internal(
            config,
            proposer,
            eligible_voters,
            majority_threshold,
            deadline,
            created_at
        );
    }

    public fun append_recovery_vote(
        obj: &mut UID,
        voter: address,
        approved: bool,
        clock: &Clock
    ) {
        let voted_at = clock::timestamp_ms(clock);
        let config = get_circle_config_mut(obj);
        append_recovery_vote_internal(config, voter, approved, voted_at);
    }

    public fun clear_recovery_proposal(obj: &mut UID, clock: &Clock) {
        let updated_at = clock::timestamp_ms(clock);
        let config = get_circle_config_mut(obj);
        clear_recovery_proposal_internal(config, updated_at);
    }

    public fun mark_recovery_stopped(obj: &mut UID, clock: &Clock) {
        let updated_at = clock::timestamp_ms(clock);
        let config = get_circle_config_mut(obj);
        mark_recovery_state_internal(config, RECOVERY_STATE_STOPPED, updated_at);
    }

    public fun mark_recovery_refunded(obj: &mut UID, clock: &Clock) {
        let updated_at = clock::timestamp_ms(clock);
        let config = get_circle_config_mut(obj);
        mark_recovery_state_internal(config, RECOVERY_STATE_REFUNDED, updated_at);
    }

    public fun is_auto_release_ready(obj: &UID, clock: &Clock): bool {
        let config = get_circle_config(obj);
        is_auto_release_ready_internal(config, clock::timestamp_ms(clock))
    }

    public fun can_execute_recovery(obj: &UID, clock: &Clock): bool {
        let config = get_circle_config(obj);
        can_execute_recovery_internal(config, clock::timestamp_ms(clock))
    }

    // Refresh native display amounts while keeping USD amounts unchanged.
    public fun set_native_display_amounts(
        obj: &mut UID,
        contribution_amount: u64,
        security_deposit: u64
    ) {
        let config = get_circle_config_mut(obj);
        config.contribution_amount = contribution_amount;
        config.security_deposit = security_deposit;
    }

    // Get target amount from milestone config
    public fun get_target_amount(obj: &UID): Option<u64> {
        let config = get_milestone_config(obj);
        config.target_amount
    }

    // Get target amount in local currency from milestone config
    public fun get_target_amount_local(obj: &UID): Option<u64> {
        let config = get_milestone_config(obj);
        config.target_amount_local
    }

    // Get warning penalty amount
    public fun get_warning_penalty_amount(obj: &UID): u64 {
        let rules = get_penalty_rules(obj);
        rules.warning_penalty_amount
    }

    // Get goal type from milestone config
    public fun get_goal_type(obj: &UID): Option<u8> {
        let config = get_milestone_config(obj);
        config.goal_type
    }

    /// Test-only: flips a MilestoneConfig into the smart-goal shape
    /// (goal_type + target_amount set) so njangi_milestones' creation
    /// gate can be exercised against the circle test factory, which
    /// attaches an empty milestone config.
    #[test_only]
    public fun set_goal_for_testing(
        config: &mut MilestoneConfig,
        goal_type: u8,
        target_amount: u64
    ) {
        config.goal_type = option::some(goal_type);
        config.target_amount = option::some(target_amount);
    }

    // Get contribution amount in USD
    public fun get_contribution_amount_usd(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.contribution_amount_usd
    }

    // Get security deposit in USD
    public fun get_security_deposit_usd(obj: &UID): u64 {
        let config = get_circle_config(obj);
        config.security_deposit_usd
    }

    // Return (usd_cents, native_9dp_display) for contribution amount.
    public fun get_contribution_amount_dual(obj: &UID): (u64, u64) {
        let config = get_circle_config(obj);
        (config.contribution_amount_usd, config.contribution_amount)
    }

    // Return (usd_cents, native_9dp_display) for security deposit.
    public fun get_security_deposit_dual(obj: &UID): (u64, u64) {
        let config = get_circle_config(obj);
        (config.security_deposit_usd, config.security_deposit)
    }

    public fun recovery_state_active(): u8 {
        RECOVERY_STATE_ACTIVE
    }

    public fun recovery_state_proposal_pending(): u8 {
        RECOVERY_STATE_PROPOSAL_PENDING
    }

    public fun recovery_state_stopped(): u8 {
        RECOVERY_STATE_STOPPED
    }

    public fun recovery_state_refunded(): u8 {
        RECOVERY_STATE_REFUNDED
    }

    public fun get_recovery_vote_voter(vote: &RecoveryVote): address {
        vote.voter
    }

    public fun is_recovery_vote_approved(vote: &RecoveryVote): bool {
        vote.approved
    }

    public fun get_recovery_vote_timestamp(vote: &RecoveryVote): u64 {
        vote.voted_at
    }

    public fun min_auto_release_delay_ms(cycle_length: u64): u64 {
        cycle_length_to_duration_ms(cycle_length)
    }

    public fun is_valid_auto_release_delay(cycle_length: u64, auto_release_delay_ms: u64): bool {
        auto_release_delay_ms > min_auto_release_delay_ms(cycle_length)
    }

    fun cycle_length_to_duration_ms(cycle_length: u64): u64 {
        if (cycle_length == 0) {
            core::ms_per_week()
        } else if (cycle_length == 1) {
            core::ms_per_month()
        } else if (cycle_length == 2) {
            core::ms_per_month() * 3
        } else if (cycle_length == 3) {
            core::ms_per_bi_week()
        } else {
            abort EInvalidCycleLength
        }
    }

    fun normalize_auto_release_delay_ms(
        cycle_length: u64,
        auto_release_enabled: bool,
        auto_release_delay_ms: u64
    ): u64 {
        if (!auto_release_enabled) {
            return 0
        };

        let minimum_delay = min_auto_release_delay_ms(cycle_length);
        assert!(auto_release_delay_ms > minimum_delay, EInvalidAutoReleaseDelay);
        auto_release_delay_ms
    }

    public fun has_required_auto_release_delegate(
        auto_release_enabled: bool,
        next_in_command: &Option<address>
    ): bool {
        !auto_release_enabled || option::is_some(next_in_command)
    }

    public fun assert_auto_release_delegate_requirement(
        auto_release_enabled: bool,
        next_in_command: &Option<address>
    ) {
        assert!(
            has_required_auto_release_delegate(auto_release_enabled, next_in_command),
            ERecoveryDelegateRequired
        );
    }

    fun auto_release_trigger_time_internal(config: &CircleConfig): Option<u64> {
        if (!config.auto_release_enabled) {
            return option::none()
        };

        option::some(config.auto_release_start_time + config.auto_release_delay_ms)
    }

    fun begin_recovery_proposal_internal(
        config: &mut CircleConfig,
        proposer: address,
        eligible_voters: vector<address>,
        majority_threshold: u64,
        deadline: u64,
        created_at: u64
    ) {
        assert!(config.recovery_state == RECOVERY_STATE_ACTIVE, EInvalidRecoveryStateTransition);
        assert!(option::is_none(&config.recovery_proposal), ERecoveryProposalAlreadyExists);
        assert!(deadline > created_at, EInvalidRecoveryDeadline);

        config.recovery_state = RECOVERY_STATE_PROPOSAL_PENDING;
        config.recovery_proposal = option::some(RecoveryProposal {
            proposer,
            created_at,
            deadline,
            passed_at: option::none(),
            eligible_voters,
            votes: vector::empty(),
            yes_votes: 0,
            no_votes: 0,
            majority_threshold,
        });
        config.recovery_state_updated_at = created_at;
    }

    fun append_recovery_vote_internal(
        config: &mut CircleConfig,
        voter: address,
        approved: bool,
        voted_at: u64
    ) {
        assert!(config.recovery_state == RECOVERY_STATE_PROPOSAL_PENDING, EInvalidRecoveryStateTransition);
        assert!(option::is_some(&config.recovery_proposal), ERecoveryProposalMissing);

        let proposal = option::borrow_mut(&mut config.recovery_proposal);
        vector::push_back(&mut proposal.votes, RecoveryVote {
            voter,
            approved,
            voted_at,
        });

        if (approved) {
            proposal.yes_votes = proposal.yes_votes + 1;
        } else {
            proposal.no_votes = proposal.no_votes + 1;
        };

        if (
            option::is_none(&proposal.passed_at)
                && proposal.yes_votes >= proposal.majority_threshold
        ) {
            proposal.passed_at = option::some(voted_at);
        };

        config.recovery_state_updated_at = voted_at;
    }

    fun clear_recovery_proposal_internal(config: &mut CircleConfig, updated_at: u64) {
        assert!(option::is_some(&config.recovery_proposal), ERecoveryProposalMissing);
        config.recovery_state = RECOVERY_STATE_ACTIVE;
        config.recovery_proposal = option::none();
        config.recovery_state_updated_at = updated_at;
    }

    fun mark_recovery_state_internal(config: &mut CircleConfig, next_state: u8, updated_at: u64) {
        if (next_state == RECOVERY_STATE_STOPPED) {
            assert!(
                config.recovery_state == RECOVERY_STATE_ACTIVE
                    || config.recovery_state == RECOVERY_STATE_PROPOSAL_PENDING,
                EInvalidRecoveryStateTransition
            );
        } else if (next_state == RECOVERY_STATE_REFUNDED) {
            assert!(config.recovery_state == RECOVERY_STATE_STOPPED, EInvalidRecoveryStateTransition);
        } else {
            abort EInvalidRecoveryStateTransition
        };

        config.recovery_state = next_state;
        config.recovery_state_updated_at = updated_at;
    }

    fun is_recovery_proposal_passed_internal(proposal: &RecoveryProposal): bool {
        option::is_some(&proposal.passed_at) || proposal.yes_votes >= proposal.majority_threshold
    }

    fun is_auto_release_ready_internal(config: &CircleConfig, current_time: u64): bool {
        if (!config.auto_release_enabled) {
            return false
        };
        if (config.recovery_state == RECOVERY_STATE_STOPPED || config.recovery_state == RECOVERY_STATE_REFUNDED) {
            return false
        };

        current_time >= config.auto_release_start_time + config.auto_release_delay_ms
    }

    fun can_execute_recovery_internal(config: &CircleConfig, current_time: u64): bool {
        if (config.recovery_state == RECOVERY_STATE_STOPPED || config.recovery_state == RECOVERY_STATE_REFUNDED) {
            return false
        };

        let proposal_ready = if (option::is_some(&config.recovery_proposal)) {
            let proposal = option::borrow(&config.recovery_proposal);
            is_recovery_proposal_passed_internal(proposal)
        } else {
            false
        };

        proposal_ready || is_auto_release_ready_internal(config, current_time)
    }

    fun touch_admin_heartbeat_internal(config: &mut CircleConfig, current_time: u64) {
        config.auto_release_start_time = current_time;
    }

    #[test]
    fun test_cycle_length_to_duration_ms_mappings() {
        assert!(cycle_length_to_duration_ms(0) == core::ms_per_week(), 9001);
        assert!(cycle_length_to_duration_ms(1) == core::ms_per_month(), 9002);
        assert!(cycle_length_to_duration_ms(2) == core::ms_per_month() * 3, 9003);
        assert!(cycle_length_to_duration_ms(3) == core::ms_per_bi_week(), 9004);
    }

    #[test]
    fun test_auto_release_delay_validation_rules() {
        assert!(!is_valid_auto_release_delay(0, core::ms_per_week()), 9005);
        assert!(is_valid_auto_release_delay(0, core::ms_per_week() + 1), 9006);
        assert!(!is_valid_auto_release_delay(3, core::ms_per_bi_week()), 9007);
        assert!(is_valid_auto_release_delay(2, core::ms_per_month() * 3 + 1), 9008);
    }

    #[test]
    fun test_auto_release_delegate_requirement_rules() {
        let delegate = option::some(@0x2);
        let no_delegate = option::none<address>();

        assert!(has_required_auto_release_delegate(false, &no_delegate), 9009);
        assert!(has_required_auto_release_delegate(false, &delegate), 9010);
        assert!(!has_required_auto_release_delegate(true, &no_delegate), 9011);
        assert!(has_required_auto_release_delegate(true, &delegate), 9012);
    }

    #[test]
    fun test_create_circle_config_allows_missing_delegate_before_activation() {
        let mut ctx = tx_context::dummy();
        let clock = clock::create_for_testing(&mut ctx);

        let config = create_circle_config(
            1,
            1,
            string::utf8(b"USD"),
            1,
            1,
            100,
            100,
            0,
            1,
            0,
            0,
            5,
            false,
            true,
            core::ms_per_week() + 1,
            option::none(),
            &clock
        );

        assert!(config.auto_release_enabled, 9013);
        assert!(option::is_none(&config.next_in_command), 9014);

        clock::destroy_for_testing(clock);
    }

    #[test]
    fun test_recovery_state_transitions() {
        let mut config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: true,
            auto_release_delay_ms: core::ms_per_week() + 1,
            next_in_command: option::none(),
            auto_release_start_time: 10,
        };

        begin_recovery_proposal_internal(
            &mut config,
            @0x1,
            vector[@0x1, @0x2, @0x3],
            2,
            50,
            20
        );
        assert!(config.recovery_state == RECOVERY_STATE_PROPOSAL_PENDING, 9009);
        assert!(option::is_some(&config.recovery_proposal), 9010);
        assert!(!can_execute_recovery_internal(&config, 20), 9011);

        append_recovery_vote_internal(&mut config, @0x1, true, 25);
        append_recovery_vote_internal(&mut config, @0x2, false, 30);
        assert!(!can_execute_recovery_internal(&config, 30), 9012);
        append_recovery_vote_internal(&mut config, @0x3, true, 35);
        let proposal = option::borrow(&config.recovery_proposal);
        assert!(proposal.yes_votes == 2, 9013);
        assert!(proposal.no_votes == 1, 9014);
        assert!(vector::length(&proposal.votes) == 3, 9015);
        assert!(option::is_some(&proposal.passed_at), 9016);
        assert!(*option::borrow(&proposal.passed_at) == 35, 9017);
        assert!(is_recovery_proposal_passed_internal(proposal), 9018);
        assert!(can_execute_recovery_internal(&config, 35), 9019);

        mark_recovery_state_internal(&mut config, RECOVERY_STATE_STOPPED, 40);
        assert!(config.recovery_state == RECOVERY_STATE_STOPPED, 9020);
        assert!(!can_execute_recovery_internal(&config, 40), 9021);

        mark_recovery_state_internal(&mut config, RECOVERY_STATE_REFUNDED, 45);
        assert!(config.recovery_state == RECOVERY_STATE_REFUNDED, 9022);
    }

    #[test]
    fun test_auto_release_can_authorize_recovery_execution() {
        let config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: true,
            auto_release_delay_ms: core::ms_per_week() + 1,
            next_in_command: option::none(),
            auto_release_start_time: 10,
        };

        assert!(!is_auto_release_ready_internal(&config, 10 + core::ms_per_week()), 9023);
        assert!(is_auto_release_ready_internal(&config, 10 + core::ms_per_week() + 1), 9024);
        assert!(can_execute_recovery_internal(&config, 10 + core::ms_per_week() + 1), 9025);
    }

    #[test]
    fun test_recovery_liveness_fields_live_in_circle_config() {
        let mut config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: true,
            auto_release_delay_ms: core::ms_per_week() + 1,
            next_in_command: option::some(@0x2),
            auto_release_start_time: 10,
        };

        assert!(option::is_some(&config.next_in_command), 9026);
        assert!(*option::borrow(&config.next_in_command) == @0x2, 9027);

        config.auto_release_start_time = 25;
        let trigger_time = auto_release_trigger_time_internal(&config);
        assert!(option::is_some(&trigger_time), 9028);
        assert!(*option::borrow(&trigger_time) == 25 + core::ms_per_week() + 1, 9029);

        assert!(!is_auto_release_ready_internal(&config, 25 + core::ms_per_week()), 9030);
        assert!(is_auto_release_ready_internal(&config, 25 + core::ms_per_week() + 1), 9031);
    }

    #[test]
    fun test_touch_admin_heartbeat_refreshes_auto_release_anchor() {
        let mut config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: true,
            auto_release_delay_ms: core::ms_per_week() + 1,
            next_in_command: option::some(@0x2),
            auto_release_start_time: 10,
        };

        touch_admin_heartbeat_internal(&mut config, 55);

        assert!(config.auto_release_start_time == 55, 9032);
        assert!(!is_auto_release_ready_internal(&config, 55 + core::ms_per_week()), 9033);
        assert!(is_auto_release_ready_internal(&config, 55 + core::ms_per_week() + 1), 9034);
    }

    #[test]
    fun test_heartbeat_refresh_invalidates_previous_auto_release_window() {
        let mut config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: true,
            auto_release_delay_ms: core::ms_per_week() + 1,
            next_in_command: option::some(@0x2),
            auto_release_start_time: 10,
        };

        let old_trigger_time = 10 + core::ms_per_week() + 1;
        assert!(is_auto_release_ready_internal(&config, old_trigger_time), 9035);

        touch_admin_heartbeat_internal(&mut config, 55);

        assert!(config.auto_release_start_time == 55, 9036);
        assert!(!is_auto_release_ready_internal(&config, old_trigger_time), 9037);
        assert!(!can_execute_recovery_internal(&config, 55 + core::ms_per_week()), 9038);
        assert!(can_execute_recovery_internal(&config, 55 + core::ms_per_week() + 1), 9039);
    }

    #[test]
    fun test_next_in_command_can_be_replaced_without_touching_heartbeat() {
        let mut config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: true,
            auto_release_delay_ms: core::ms_per_week() + 1,
            next_in_command: option::some(@0x2),
            auto_release_start_time: 10,
        };

        config.next_in_command = option::some(@0x3);
        assert!(option::is_some(&config.next_in_command), 9040);
        assert!(*option::borrow(&config.next_in_command) == @0x3, 9041);
        assert!(config.auto_release_start_time == 10, 9042);
        assert!(has_required_auto_release_delegate(config.auto_release_enabled, &config.next_in_command), 9043);
    }

    #[test]
    fun test_delegate_can_be_cleared_after_auto_release_is_disabled_without_touching_heartbeat() {
        let mut config = CircleConfig {
            contribution_amount: 1,
            security_deposit: 1,
            currency_type: string::utf8(b"USD"),
            contribution_amount_local: 1,
            security_deposit_local: 1,
            contribution_amount_usd: 100,
            security_deposit_usd: 100,
            cycle_length: 0,
            cycle_day: 1,
            circle_type: 0,
            rotation_style: 0,
            max_members: 5,
            auto_swap_enabled: false,
            recovery_state: RECOVERY_STATE_ACTIVE,
            recovery_proposal: option::none(),
            recovery_state_updated_at: 10,
            auto_release_enabled: false,
            auto_release_delay_ms: 0,
            next_in_command: option::some(@0x2),
            auto_release_start_time: 10,
        };

        config.next_in_command = option::none();
        assert!(option::is_none(&config.next_in_command), 9044);
        assert!(config.auto_release_start_time == 10, 9045);
        assert!(has_required_auto_release_delegate(config.auto_release_enabled, &config.next_in_command), 9046);
    }
}
