module njangi::njangi_circle_config {
    use sui::object::{Self, UID};
    use sui::dynamic_field;
    use sui::tx_context::TxContext;
    use std::string::String;
    use std::option::{Self, Option};

    // Constants for dynamic field keys
    const FIELD_CIRCLE_CONFIG: vector<u8> = b"circle_config";
    const FIELD_MILESTONE_CONFIG: vector<u8> = b"milestone_config";
    const FIELD_PENALTIES_CONFIG: vector<u8> = b"penalties_config";

    // Circle configuration struct
    public struct CircleConfig has store, drop {
        // Circle basic settings
        contribution_amount: u64,         // SUI amount with 9 decimals - this is the ACTUAL SUI value
        security_deposit: u64,            // SUI amount with 9 decimals - this is the ACTUAL SUI value
        contribution_amount_usd: u64,     // USD amount in cents (e.g., 20 = $0.20) 
        security_deposit_usd: u64,        // USD amount in cents (e.g., 20 = $0.20)
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        rotation_style: u8,
        max_members: u64,
        auto_swap_enabled: bool
    }

    // Milestone configuration struct
    public struct MilestoneConfig has store, drop {
        // Goal/Milestone settings
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_usd: Option<u64>,
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
        contribution_amount_usd: u64,
        security_deposit_usd: u64,
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        rotation_style: u8,
        max_members: u64,
        auto_swap_enabled: bool
    ): CircleConfig {
        CircleConfig {
            contribution_amount,
            security_deposit,
            contribution_amount_usd,
            security_deposit_usd,
            cycle_length,
            cycle_day,
            circle_type,
            rotation_style,
            max_members,
            auto_swap_enabled
        }
    }

    // Create a new milestone configuration
    public fun create_milestone_config(
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_usd: Option<u64>,
        target_date: Option<u64>,
        verification_required: bool
    ): MilestoneConfig {
        MilestoneConfig {
            goal_type,
            target_amount,
            target_amount_usd,
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

    // Get target amount from milestone config
    public fun get_target_amount(obj: &UID): Option<u64> {
        let config = get_milestone_config(obj);
        config.target_amount
    }

    // Get target amount USD from milestone config
    public fun get_target_amount_usd(obj: &UID): Option<u64> {
        let config = get_milestone_config(obj);
        config.target_amount_usd
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
} 