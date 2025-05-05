module njangi::njangi_members {
    use sui::object::ID;
    use sui::tx_context::{Self, TxContext};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::event;
    use sui::sui::SUI;
    use std::option::{Self, Option};
    use std::string::{Self, String};
    use std::vector;
    
    use njangi::njangi_core as core;
    
    // ----------------------------------------------------------
    // Error codes specific to members
    // ----------------------------------------------------------
    const EMemberAlreadyExists: u64 = 39;
    const EMemberNotPending: u64 = 40;
    const EMemberNotActive: u64 = 14;
    const EMemberSuspended: u64 = 13;
    const EMemberHasOutstandingObligations: u64 = 18;
    const ENoWarningToClear: u64 = 20;
    const EPenaltyAlreadyPaid: u64 = 21;
    const EInsufficientPenaltyPayment: u64 = 19;
    
    // ----------------------------------------------------------
    // Local constants (from core)
    // ----------------------------------------------------------
    // Replace with direct calls to core functions
    //const MEMBER_STATUS_ACTIVE: u8 = 0;
    //const MEMBER_STATUS_PENDING: u8 = 1; 
    //const MEMBER_STATUS_SUSPENDED: u8 = 2;
    //const MEMBER_STATUS_EXITED: u8 = 3;
    //const MS_PER_MONTH: u64 = 2_419_200_000;
    
    // ----------------------------------------------------------
    // Member struct
    // ----------------------------------------------------------
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
        activated_at: Option<u64>, // Timestamp when the member was activated
        deposit_paid: bool,
    }
    
    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    public struct MemberJoined has copy, drop {
        circle_id: ID,
        member: address,
        position: Option<u64>,
    }
    
    public struct MemberApproved has copy, drop {
        circle_id: ID,
        member: address,
        approved_by: address,
    }
    
    public struct MemberActivated has copy, drop {
        circle_id: ID,
        member: address,
        deposit_amount: u64,
    }
    
    public struct WarningIssued has copy, drop {
        circle_id: ID,
        member: address,
        warning_count: u8,
        penalty_amount: u64,
        reason: String,
    }
    
    public struct PenaltyPaid has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        warnings_cleared: u8,
    }
    
    // ----------------------------------------------------------
    // Create a new member
    // ----------------------------------------------------------
    public fun create_member(
        joined_at: u64,
        payout_position: Option<u64>,
        deposit_balance: u64,
        status: u8
    ): Member {
        Member {
            joined_at,
            last_contribution: 0,
            total_contributed: 0,
            received_payout: false,
            payout_position,
            deposit_balance,
            missed_payments: 0,
            missed_meetings: 0,
            status,
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
            activated_at: option::none(),
            deposit_paid: false,
        }
    }
    
    // ----------------------------------------------------------
    // Get members by status
    // ----------------------------------------------------------
    public fun get_members_by_status_from_list(
        members_list: vector<address>,
        status: u8,
        members_table: &sui::table::Table<address, Member>
    ): vector<address> {
        let mut filtered_members = vector::empty<address>();
        
        let mut i = 0;
        let len = vector::length(&members_list);
        
        while (i < len) {
            let addr = *vector::borrow(&members_list, i);
            if (sui::table::contains(members_table, addr)) {
                let member = sui::table::borrow(members_table, addr);
                if (member.status == status) {
                    vector::push_back(&mut filtered_members, addr);
                };
            };
            i = i + 1;
        };
        
        filtered_members
    }
    
    // ----------------------------------------------------------
    // Reputation / Payment tracking
    // ----------------------------------------------------------
    public fun update_member_reputation(
        member: &mut Member,
        attended_meeting: bool,
        on_time_payment: bool,
    ) {        
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
    // Member warnings and penalties
    // ----------------------------------------------------------
    public fun issue_warning(
        member: &mut Member,
        clock: &Clock
    ) {
        member.warning_count = member.warning_count + 1;
        member.last_warning_time = clock::timestamp_ms(clock);
    }
    
    public fun issue_warning_with_penalty(
        member: &mut Member,
        warning_penalty_amount: u64,
        allow_penalty_payments: bool,
        clock: &Clock
    ) {
        member.warning_count = member.warning_count + 1;
        member.last_warning_time = clock::timestamp_ms(clock);
        
        if (allow_penalty_payments) {
            member.unpaid_penalties = member.unpaid_penalties + warning_penalty_amount;
            vector::push_back(&mut member.warnings_with_penalties, clock::timestamp_ms(clock));
        };
    }
    
    // ----------------------------------------------------------
    // Suspend/reactivate member
    // ----------------------------------------------------------
    public fun suspend_member(
        member: &mut Member,
        clock: &Clock
    ) {
        member.status = core::member_status_suspended();
        member.suspension_end_time = option::some(clock::timestamp_ms(clock) + core::ms_per_month());
    }
    
    public fun reactivate_member(
        member: &mut Member,
        clock: &Clock
    ): bool {
        if (option::is_none(&member.suspension_end_time)) {
            return false
        };
        
        if (clock::timestamp_ms(clock) < *option::borrow(&member.suspension_end_time)) {
            return false
        };
        
        member.status = core::member_status_active();
        member.warning_count = 0;
        member.suspension_end_time = option::none();
        true
    }
    
    // ----------------------------------------------------------
    // Member exit
    // ----------------------------------------------------------
    public fun request_exit(
        member: &mut Member,
        clock: &Clock
    ): bool {
        if (member.status != core::member_status_active()) {
            return false
        };
        
        if (member.exit_requested) {
            return false
        };
        
        member.exit_requested = true;
        member.exit_request_time = option::some(clock::timestamp_ms(clock));
        true
    }
    
    public fun process_member_exit(
        member: &mut Member,
        circle_contribution_amount: u64
    ): bool {
        if (!member.exit_requested) {
            return false
        };
        
        // Check if member has met all obligations
        if (member.total_contributed < circle_contribution_amount * member.total_meetings_required) {
            return false
        };
        
        member.status = core::member_status_exited();
        true
    }
    
    // ----------------------------------------------------------
    // Contribution management
    // ----------------------------------------------------------
    public fun record_contribution(
        member: &mut Member,
        amount: u64,
        timestamp: u64
    ) {
        member.last_contribution = timestamp;
        member.total_contributed = member.total_contributed + amount;
    }
    
    // ----------------------------------------------------------
    // Member payment verification
    // ----------------------------------------------------------
    public fun has_missed_payment(
        member: &Member, 
        cycle_start: u64, 
        cycle_end: u64
    ): bool {
        // If last contribution is 0, check if the member has just joined
        if (member.last_contribution == 0) {
            // If member joined before cycle start, they've missed a payment
            member.joined_at < cycle_start
        } else {
            // Member has missed a payment if their last contribution was before the current cycle
            member.last_contribution < cycle_start
        }
    }
    
    // ----------------------------------------------------------
    // Getters for member properties
    // ----------------------------------------------------------
    
    // Get deposit balance
    public fun get_deposit_balance(member: &Member): u64 {
        member.deposit_balance
    }
    
    // Set deposit balance
    public fun set_deposit_balance(member: &mut Member, amount: u64) {
        member.deposit_balance = amount;
    }
    
    // Add to deposit balance
    public fun add_to_deposit_balance(member: &mut Member, amount: u64) {
        member.deposit_balance = member.deposit_balance + amount;
    }
    
    // Subtract from deposit balance
    public fun subtract_from_deposit_balance(member: &mut Member, amount: u64) {
        assert!(member.deposit_balance >= amount, 12); // EInsufficientBalance
        member.deposit_balance = member.deposit_balance - amount;
    }
    
    // Get member status
    public fun get_status(member: &Member): u8 {
        member.status
    }
    
    // Set member status
    public fun set_status(member: &mut Member, status: u8) {
        member.status = status;
    }
    
    // Get received payout
    public fun has_received_payout(member: &Member): bool {
        member.received_payout
    }
    
    // Set received payout
    public fun set_received_payout(member: &mut Member, received: bool) {
        member.received_payout = received;
    }
    
    // Get warning count
    public fun get_warning_count(member: &Member): u8 {
        member.warning_count
    }
    
    // Get reputation score
    public fun get_reputation_score(member: &Member): u8 {
        member.reputation_score
    }
    
    // Get total contributed
    public fun get_total_contributed(member: &Member): u64 {
        member.total_contributed
    }
    
    // Get payout position
    public fun get_payout_position(member: &Member): Option<u64> {
        member.payout_position
    }
    
    // Set payout position
    public fun set_payout_position(member: &mut Member, position: Option<u64>) {
        member.payout_position = position;
    }
    
    // Get member contribution history
    public fun get_contribution_history(member: &Member): (u64, u64, u64, u64) {
        (
            core::from_decimals(member.total_contributed),
            member.consecutive_on_time_payments,
            member.missed_payments,
            member.total_meetings_required
        )
    }
    
    // Check if member is eligible for payout
    public fun is_eligible_for_payout(
        member: &Member,
        min_contribution: u64,
        payout_time: u64,
        current_time: u64
    ): bool {
        member.status == core::member_status_active()
        && !member.received_payout
        && member.total_contributed >= min_contribution
        && option::is_none(&member.suspension_end_time)
        && current_time >= payout_time
    }
    
    // Get unpaid penalties amount
    public fun get_unpaid_penalties(member: &Member): u64 {
        core::from_decimals(member.unpaid_penalties)
    }
    
    // Add getter for suspension_end_time
    public fun get_suspension_end_time(member: &Member): Option<u64> {
        member.suspension_end_time
    }
    
    // Add getter for total_meetings_required
    public fun get_total_meetings_required(member: &Member): u64 {
        member.total_meetings_required
    }
    
    // ----------------------------------------------------------
    // Member status constants for public use
    // ----------------------------------------------------------
    public fun member_status_pending(): u8 { core::member_status_pending() }
    public fun member_status_active(): u8 { core::member_status_active() }
    public fun member_status_suspended(): u8 { core::member_status_suspended() }
    public fun member_status_inactive(): u8 { core::member_status_exited() }
    
    // ----------------------------------------------------------
    // Accessor functions for Member fields
    // ----------------------------------------------------------
    public fun get_activated_at(member: &Member): Option<u64> {
        member.activated_at
    }
    
    public fun set_activated_at(member: &mut Member, timestamp: u64) {
        member.activated_at = option::some(timestamp);
    }
    
    public fun set_deposit_paid(member: &mut Member, paid: bool) {
        member.deposit_paid = paid;
    }
    
    public fun has_paid_deposit(member: &Member): bool {
        member.deposit_paid
    }
} 