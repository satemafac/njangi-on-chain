module njangi::njangi_circles {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::dynamic_field;
    use sui::event;
    use sui::sui::SUI;
    use std::string::{Self, String};
    use std::ascii;
    use std::type_name;

    use njangi::njangi_core::{Self as core};
    use njangi::njangi_members::{Self as members, Member};
    use njangi::njangi_custody::{Self as custody, CustodyWallet};
    use njangi::njangi_circle_config::{Self as config};

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
    const ECircleNotPausedForConfigChange: u64 = 58;
    // Define constants locally based on values from other modules
    const EInvalidContributionAmount: u64 = 1; // From core
    const ENotMember: u64 = 8;                 // From core
    const EMemberNotActive: u64 = 14;          // From members
    const EMemberSuspended: u64 = 13;          // From members
    const EIncorrectDepositAmount: u64 = 2;    // From core
    const ENoValidOraclePrice: u64 = 61;
    const ENoRecoveryEligibleVoters: u64 = 62;
    const ERecoveryVoteNotEligible: u64 = 63;
    const ERecoveryVoteAlreadyCast: u64 = 64;
    const ERecoveryProposalExpired: u64 = 65;
    const ERecoveryVotingClosed: u64 = 66;
    const ERecoveryProposalMissing: u64 = 67;
    const ERecoveryExecutionNotReady: u64 = 68;
    const ERecoveryInsufficientWalletBalance: u64 = 69;
    const ERecoveryMemberSnapshotMismatch: u64 = 70;
    const EInvalidRecoveryDelegate: u64 = 71;
    const ERecoveryDelegateUpdateLocked: u64 = 72;
    const ERecoveryAutoReleaseUnauthorized: u64 = 73;
    // Legacy custody path: a member may contribute at most once per payout
    // round (mirrors the per-cycle escrow's `contributed` table guarantee).
    const E_ALREADY_CONTRIBUTED_THIS_CYCLE: u64 = 74;
    // Compliance gate: once members beyond the admin have joined a circle
    // that requires attestations, the requirement can never be switched
    // off (bait-and-switch guard — members joined under the KYC promise).
    const ECannotDisableAttestationRequirement: u64 = 75;
    // Mirrors njangi_cycle_escrow::E_COMPLIANCE_ATTESTATION_REQUIRED (216)
    // so the frontend maps a single abort code for "this circle requires a
    // compliance attestation" across both money rails.
    const E_COMPLIANCE_ATTESTATION_REQUIRED: u64 = 216;

    // Time constants (in milliseconds)
    const THIRTY_DAYS_MS: u64 = 2_592_000_000; // 30 days in milliseconds
    const SEVEN_DAYS_MS: u64 = 604_800_000;    // 7 days in milliseconds
    const EMERGENCY_STOP_VOTING_WINDOW_MS: u64 = SEVEN_DAYS_MS;
    const AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS: u64 = 86_400_000; // 24 hours

    const RECOVERY_TRIGGER_ROLE_VOTE_EXECUTION: u8 = 0;
    const RECOVERY_TRIGGER_ROLE_DELEGATE: u8 = 1;
    const RECOVERY_TRIGGER_ROLE_MEMBER_FALLBACK: u8 = 2;

    // Oracle safety constants.
    const ORACLE_MAX_STALE_SECONDS: u64 = 3_600; // 1 hour
    const ORACLE_LOOKBACK_SECONDS: u64 = 31_536_000; // 1 year
    const PRICE_FALLBACK_NONE: u8 = 0;
    const PRICE_FALLBACK_STALE: u8 = 1;
    const PRICE_FALLBACK_VOLATILITY: u8 = 2;
    const PRICE_FALLBACK_INVALID: u8 = 3;

    // Dynamic-field keys for cached oracle fallback price.
    const FIELD_LAST_VALID_SUI_PRICE_USD_CENTS: vector<u8> = b"last_valid_sui_price_usd_cents";
    const FIELD_LAST_VALID_SUI_PRICE_TS_SEC: vector<u8> = b"last_valid_sui_price_ts_sec";

    // Dynamic-field key recording which members contributed in the current
    // payout round (legacy custody path de-duplication). Stored as a
    // dynamic field so the Circle struct layout is unchanged; cleared at
    // every site that resets `contributions_this_cycle` so the record and
    // the counter always move in lockstep.
    const FIELD_CYCLE_CONTRIBUTORS: vector<u8> = b"cycle_contributors";

    // Dynamic-field key for the circle-level compliance requirement.
    // Stored as a dynamic field (absent == false) so the Circle struct
    // layout is unchanged and pre-existing circles default to ungated.
    const FIELD_REQUIRES_ATTESTATION: vector<u8> = b"requires_attestation";
    
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
        contributions_this_cycle: u64, // Track total contributions for the current cycle in USD cents
        paused_after_cycle: bool, // Flag to indicate if circle is paused after completing a cycle
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
        currency_type: String,              // Currency code (e.g., "USD", "XAF", "NGN")
        contribution_amount_local: u64,     // Amount in local currency
        security_deposit_local: u64,        // Amount in local currency
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

    /// Emitted whenever the circle-level compliance requirement changes.
    /// `required == true` can be set at any time by the admin; `false`
    /// is only possible while the admin is the sole member.
    public struct CircleAttestationRequirementChanged has copy, drop {
        circle_id: ID,
        required: bool,
        changed_by: address,
        changed_at_ms: u64,
    }

    public struct EmergencyStopProposed has copy, drop {
        circle_id: ID,
        proposer: address,
        eligible_voter_count: u64,
        majority_threshold: u64,
        deadline: u64,
        timestamp: u64,
    }

    public struct EmergencyStopVoteCast has copy, drop {
        circle_id: ID,
        voter: address,
        approved: bool,
        yes_votes: u64,
        no_votes: u64,
        majority_threshold: u64,
        timestamp: u64,
    }

    public struct EmergencyStopMajorityReached has copy, drop {
        circle_id: ID,
        yes_votes: u64,
        majority_threshold: u64,
        reached_at: u64,
    }

    public struct RecoveryDelegateUpdated has copy, drop {
        circle_id: ID,
        admin: address,
        next_in_command: Option<address>,
        timestamp: u64,
    }

    public struct RecoveryExecutionStarted has copy, drop {
        circle_id: ID,
        executor: address,
        member_count: u64,
        total_sui_refund: u64,
        total_stablecoin_refund: u64,
        used_auto_release: bool,
        trigger_role: u8,
        timestamp: u64,
    }

    public struct RecoveryMemberRefunded has copy, drop {
        circle_id: ID,
        member: address,
        sui_contributions_refunded: u64,
        sui_deposit_refunded: u64,
        stablecoin_contributions_refunded: u64,
        stablecoin_deposit_refunded: u64,
        timestamp: u64,
    }

    public struct RecoveryExecutionCompleted has copy, drop {
        circle_id: ID,
        executor: address,
        refunded_members: u64,
        total_sui_refund: u64,
        total_stablecoin_refund: u64,
        timestamp: u64,
    }
    
    // Enhanced MemberJoined event with comprehensive member information
    public struct MemberJoined has copy, drop {
        circle_id: ID,
        member: address,
        position: Option<u64>,
        member_status: u8,                  // Member status (0=active, 1=pending, 2=suspended, 3=exited)
        currency_type: String,              // Currency code (e.g., "USD", "XAF", "NGN")
        contribution_amount_local: u64,     // Contribution amount in local currency
        security_deposit_local: u64,        // Security deposit in local currency
        deposit_paid: bool,                 // Whether the member has paid their deposit
        joined_at: u64,                     // Timestamp when member joined
    }

    // Add these events near other event definitions around line 140
    public struct MemberActivated has copy, drop {
        circle_id: ID,
        member: address,
        deposit_amount: u64,
    }

    // ----------------------------------------------------------
    // Membership receipt — soulbound discovery index
    // ----------------------------------------------------------
    // A `key`-only (non-transferable by holders) object minted to a member when
    // they join a circle. It exists purely so the frontend can discover "which
    // circles is this address a member of" with a single, server-side-indexed
    // `getOwnedObjects({ owner, filter: { StructType: CircleMembership } })`
    // call — O(the user's memberships) instead of scanning the global
    // `MemberJoined` event stream (which cannot be filtered by member address
    // server-side, since that field lives in the event payload).
    //
    // The receipt is a HINT, not the source of truth: the Circle's `members`
    // table remains authoritative. The frontend treats discovered receipts as
    // candidate circle ids and verifies current membership against the circle
    // object, so a stale receipt left behind after a removal is simply filtered
    // out (we never need to reach into the member's wallet to delete it).
    public struct CircleMembership has key {
        id: UID,
        circle_id: ID,
        member: address,
        joined_at: u64,
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

    public struct CycleLimitsUpdated has copy, drop {
        circle_id: ID,
        admin: address,
        old_cycle_length: u64,
        new_cycle_length: u64,
        old_cycle_day: u64,
        new_cycle_day: u64,
        old_contribution_usd_cents: u64,
        new_contribution_usd_cents: u64,
        old_security_deposit_usd_cents: u64,
        new_security_deposit_usd_cents: u64,
    }

    public struct NativeDisplayAmountsSynced has copy, drop {
        circle_id: ID,
        admin: address,
        contribution_usd_cents: u64,
        contribution_native_amount: u64,
        security_deposit_usd_cents: u64,
        security_deposit_native_amount: u64,
        sui_price_usd_cents: u64,
    }

    public struct OraclePriceResolved has copy, drop {
        circle_id: ID,
        candidate_price_usd_cents: u64,
        resolved_price_usd_cents: u64,
        candidate_age_seconds: u64,
        used_fallback: bool,
        fallback_reason: u8, // 0=none,1=stale,2=volatility,3=invalid
    }

    // Add after CircleMaxMembersUpdated event struct
    public struct CyclePaused has copy, drop {
        circle_id: ID,
        admin: address,
        cycle_completed: u64,
    }

    // Cycle Resumed Event - Emitted when admin resumes a paused cycle
    public struct CycleResumed has copy, drop {
        circle_id: ID,
        admin: address,
        new_cycle: u64,
    }

    // Member Deposits Reset Event - Emitted when all members' deposit status is reset
    public struct MemberDepositsReset has copy, drop {
        circle_id: ID,
        admin: address,
        cycle: u64,
        timestamp: u64,
    }

    // Member Removed Event - Emitted when admin removes a member from inactive circle
    public struct MemberRemoved has copy, drop {
        circle_id: ID,
        member: address,
        removed_by: address,
        deposit_returned: bool,
        deposit_amount: u64,
        timestamp: u64,
    }

    // Security Deposit Returned Event - Emitted whenever a security deposit is
    // released back to its rightful owner (admin removal, recovery payouts, etc.).
    // Schema mirrors the legacy `njangi_payments::SecurityDepositReturned` event
    // that was deleted in the Phase 1 compliance redesign so the WhatsApp bot
    // listener in whatsapp-bot-backend keeps working without refactor.
    public struct SecurityDepositReturned has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        member: address,
        amount: u64,
        coin_type: std::string::String,
        timestamp: u64,
    }

    // Rotation Order Changed Event - Emitted when admin reorders member rotation positions
    public struct RotationOrderChanged has copy, drop {
        circle_id: ID,
        admin: address,
        new_order: vector<address>,
        member_count: u64,
        timestamp: u64,
    }

    // ----------------------------------------------------------
    // Automation Status Struct
    // ----------------------------------------------------------
    public struct AutomationStatus has copy, drop {
        is_overdue: bool,
        time_until_payout: u64,
        is_ready_for_payout: bool,
        all_members_contributed: bool,
        warning_level: u8, // 0=none, 1=24h, 2=6h, 3=1h, 4=overdue
    }

    // ----------------------------------------------------------
    // Time-Based Automation Events  
    // ----------------------------------------------------------
    public struct AutomationTriggered has copy, drop {
        circle_id: ID,
        automation_type: String, // "payout", "notification", "health_check"
        triggered_at: u64,
        success: bool,
        details: String,
    }

    public struct PayoutOverdue has copy, drop {
        circle_id: ID,
        overdue_duration_ms: u64,
        next_payout_time: u64,
        current_time: u64,
        all_contributed: bool,
    }

    public struct AutomationFailed has copy, drop {
        circle_id: ID,
        automation_type: String,
        error_code: u64,
        error_message: String,
        failed_at: u64,
        retry_count: u64,
    }

    public struct PayoutWarning has copy, drop {
        circle_id: ID,
        warning_level: u8, // 1=24h, 2=6h, 3=1h
        time_remaining_ms: u64,
        next_payout_time: u64,
        current_time: u64,
    }

    // ----------------------------------------------------------
    // Create Circle
    // ----------------------------------------------------------
    public fun create_circle(
        name: vector<u8>,
        contribution_amount: u64,
        currency_type: vector<u8>,        // Currency code (e.g., "USD", "XAF", "NGN")
        contribution_amount_local: u64,   // Amount in local currency
        contribution_amount_usd: u64,     // USD equivalent amount (in cents)
        security_deposit: u64,
        security_deposit_local: u64,      // Amount in local currency
        security_deposit_usd: u64,        // USD equivalent amount (in cents)
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        max_members: u64,
        rotation_style: u8,
        penalty_rules: vector<bool>,
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_local: Option<u64>, // Amount in local currency
        target_date: Option<u64>,
        verification_required: bool,
        auto_release_enabled: bool,
        auto_release_delay_ms: u64,
        next_in_command: Option<address>,
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
        assert!(contribution_amount_usd > 0, 1);
        assert!(security_deposit_usd >= core::min_security_deposit(contribution_amount_usd), 2);
        assert!(contribution_amount_scaled > 0, 1);
        assert!(security_deposit_scaled > 0, 2);
        assert!(cycle_length <= 3, 3); // Allow up to 3 (bi-weekly)
        assert!(is_valid_cycle_schedule(cycle_length, cycle_day), 4); // EInvalidCycleDay

        // Get admin address
        let admin = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        if (option::is_some(&next_in_command)) {
            assert!(*option::borrow(&next_in_command) != admin, EInvalidRecoveryDelegate);
        };

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
            contributions_this_cycle: 0, // Initialize to 0 USD cents
            paused_after_cycle: false,
        };
        
        // Create and attach configurations using the new module
        let circle_config = config::create_circle_config(
            contribution_amount_scaled,
            security_deposit_scaled,
            string::utf8(currency_type),
            contribution_amount_local,
            security_deposit_local,
            contribution_amount_usd,
            security_deposit_usd,
            cycle_length,
            cycle_day,
            circle_type,
            rotation_style,
            max_members,
            false, // auto_swap_enabled starts as false
            auto_release_enabled,
            auto_release_delay_ms,
            if (auto_release_enabled) { next_in_command } else { option::none() },
            clock
        );
        
        let milestone_config = config::create_milestone_config(
            goal_type,
            target_amount_scaled,
            target_amount_local,
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
            currency_type: string::utf8(currency_type),
            contribution_amount_local,
            security_deposit_local,
            max_members,
            cycle_length,
        });
        
        // Emit enhanced MemberJoined event for admin with full member details
        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: admin,
            position: option::some(0),
            member_status: core::member_status_active(),
            currency_type: string::utf8(currency_type),
            contribution_amount_local,
            security_deposit_local,
            deposit_paid: false,
            joined_at: current_time,
        });

        // Mint the admin's soulbound membership receipt for scalable discovery.
        issue_membership(object::uid_to_inner(&circle.id), admin, current_time, ctx);

        // Make the newly created `Circle` object shared
        transfer::share_object(circle);
    }
    
    // ----------------------------------------------------------
    // Admin activates the circle, requiring all members to have deposits
    // ----------------------------------------------------------
    public fun activate_circle(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can activate the circle
        assert!(sender == circle.admin, 7);
        
        // Circle must have at least 3 members (minimum required)
        assert!(circle.current_members >= 3, 22);
        
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

        if (config::is_auto_release_enabled(&circle.id)) {
            let next_in_command = config::get_next_in_command(&circle.id);
            config::assert_auto_release_delegate_requirement(true, &next_in_command);

            let delegate = *option::borrow(&next_in_command);
            assert!(delegate != circle.admin, EInvalidRecoveryDelegate);
            assert!(can_active_member_trigger_auto_release(circle, delegate), EInvalidRecoveryDelegate);
        };
        
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
        touch_admin_heartbeat(circle, clock);
        
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
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can toggle auto-swap
        assert!(sender == circle.admin, ENotAdmin);

        // Lock token mode while a cycle is actively running.
        // Mode can only be changed pre-activation or when paused between cycles.
        assert!(
            !circle.is_active || circle.paused_after_cycle,
            ECircleNotPausedForConfigChange
        );
        
        // Update config using the config module
        config::toggle_auto_swap(&mut circle.id, enabled);
        touch_admin_heartbeat(circle, clock);
        
        // Emit an event so frontend can track changes
        event::emit(AutoSwapToggled {
            circle_id: object::uid_to_inner(&circle.id),
            enabled,
            toggled_by: sender,
        });
    }

    // ----------------------------------------------------------
    // Circle-level compliance requirement (June 2026 audit fix).
    //
    // Previously "this circle requires KYC" lived only in the admin's
    // browser localStorage, while open_cycle/contribute are
    // permissionless — so the gate was trivially bypassable by anyone
    // hand-rolling the ungated path. This flag is the on-chain source of
    // truth: njangi_cycle_escrow reads it at open time and forces every
    // escrow of a gated circle onto the attestation-checked paths, and
    // the legacy custody rail (contribute_stablecoin here;
    // njangi_payments::contribute / trigger_payout / claim_payout)
    // refuses gated circles outright with the same abort code (216),
    // forcing them onto the escrow rail. Security deposits and all
    // refund/recovery paths stay ungated — they only return a member's
    // own funds, so no funds can ever be stranded behind the gate.
    // ----------------------------------------------------------

    /// Sets whether this circle requires a valid compliance attestation
    /// to contribute to / collect from its money paths (per-cycle escrows
    /// become attestation-checked; the legacy custody rail is blocked
    /// entirely). Admin only.
    /// Enabling is always allowed (it only tightens the rules; escrows
    /// already open keep the gate state they were opened with). Disabling
    /// is only allowed while the admin is the sole member: once anyone
    /// else has joined under the KYC promise, the requirement is
    /// permanent (bait-and-switch guard).
    public fun set_requires_attestation(
        circle: &mut Circle,
        required: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        if (!required) {
            assert!(circle.current_members <= 1, ECannotDisableAttestationRequirement);
        };

        if (dynamic_field::exists_(&circle.id, FIELD_REQUIRES_ATTESTATION)) {
            *dynamic_field::borrow_mut<vector<u8>, bool>(
                &mut circle.id,
                FIELD_REQUIRES_ATTESTATION
            ) = required;
        } else {
            dynamic_field::add(&mut circle.id, FIELD_REQUIRES_ATTESTATION, required);
        };
        touch_admin_heartbeat(circle, clock);

        event::emit(CircleAttestationRequirementChanged {
            circle_id: object::uid_to_inner(&circle.id),
            required,
            changed_by: sender,
            changed_at_ms: clock::timestamp_ms(clock),
        });
    }

    /// Whether this circle requires a compliance attestation on its
    /// escrow money paths. Absent field == false, so circles created
    /// before this flag existed stay ungated.
    public fun requires_attestation(circle: &Circle): bool {
        if (dynamic_field::exists_(&circle.id, FIELD_REQUIRES_ATTESTATION)) {
            *dynamic_field::borrow<vector<u8>, bool>(&circle.id, FIELD_REQUIRES_ATTESTATION)
        } else {
            false
        }
    }

    // ----------------------------------------------------------
    // Treasury (payout scheduling, tracking balances)
    // ----------------------------------------------------------
    public fun manage_treasury_balances(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Circle must be active to manage treasury
        assert!(circle.is_active, ECircleNotActive);
        
        let contributions = balance::value(&circle.contributions);
        let deposits = balance::value(&circle.deposits);
        let penalties = balance::value(&circle.penalties);
        touch_admin_heartbeat(circle, clock);
        
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
        touch_admin_heartbeat(circle, clock);
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
    public fun delete_circle(
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
            paused_after_cycle: _,
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
    public(package) fun set_rotation_position_internal(
        circle: &mut Circle,
        member_addr: address,
        position: u64
    ) {
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

    public fun set_rotation_position(
        circle: &mut Circle,
        member_addr: address,
        position: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        set_rotation_position_internal(circle, member_addr, position);
        touch_admin_heartbeat(circle, clock);
    }
    
    // ----------------------------------------------------------
    // Replace the entire rotation order at once
    // ----------------------------------------------------------
    fun reorder_rotation_positions_internal(
        circle: &mut Circle,
        new_order: vector<address>,
        admin: address,
        timestamp: u64
    ) {
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

        // Emit RotationOrderChanged event
        event::emit(RotationOrderChanged {
            circle_id: object::id(circle),
            admin,
            new_order: circle.rotation_order,
            member_count: order_length,
            timestamp,
        });
    }

    public fun reorder_rotation_positions(
        circle: &mut Circle,
        new_order: vector<address>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, 7);
        reorder_rotation_positions_internal(
            circle,
            new_order,
            sender,
            tx_context::epoch_timestamp_ms(ctx)
        );
        touch_admin_heartbeat(circle, clock);
    }
    
    // ----------------------------------------------------------
    // Replace the entire rotation order at once (entry function for frontend)
    // ----------------------------------------------------------
    public fun reorder_rotation_positions_entry(
        circle: &mut Circle,
        new_order: vector<address>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        reorder_rotation_positions(circle, new_order, clock, ctx);
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

    // Get currency type from circle config
    public fun get_currency_type(circle: &Circle): String {
        config::get_currency_type(&circle.id)
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
    
    // NOTE: `split_from_deposits` was removed in the June 2026 GTM audit
    // cleanup. Its only caller was the admin-pushed
    // `njangi_payments::process_security_deposit_return`, which violated
    // the no-admin-discretionary-fund-movement invariant and read from
    // `circle.deposits` — a balance the live deposit flow never funds
    // (security deposits are held in the CustodyWallet and returned via
    // the member-initiated recovery flow).

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

    public fun get_recovery_state(circle: &Circle): u8 {
        config::get_recovery_state(&circle.id)
    }

    public fun get_recovery_state_updated_at(circle: &Circle): u64 {
        config::get_recovery_state_updated_at(&circle.id)
    }

    public fun has_recovery_proposal(circle: &Circle): bool {
        config::has_recovery_proposal(&circle.id)
    }

    public fun get_recovery_proposal(circle: &Circle): Option<config::RecoveryProposal> {
        config::get_recovery_proposal(&circle.id)
    }

    public fun get_recovery_proposal_proposer(circle: &Circle): Option<address> {
        config::get_recovery_proposal_proposer(&circle.id)
    }

    public fun get_recovery_proposal_created_at(circle: &Circle): Option<u64> {
        config::get_recovery_proposal_created_at(&circle.id)
    }

    public fun get_recovery_proposal_deadline(circle: &Circle): Option<u64> {
        config::get_recovery_proposal_deadline(&circle.id)
    }

    public fun get_recovery_proposal_passed_at(circle: &Circle): Option<u64> {
        config::get_recovery_proposal_passed_at(&circle.id)
    }

    public fun get_recovery_majority_threshold(circle: &Circle): Option<u64> {
        config::get_recovery_majority_threshold(&circle.id)
    }

    public fun get_recovery_yes_votes(circle: &Circle): u64 {
        config::get_recovery_yes_votes(&circle.id)
    }

    public fun get_recovery_no_votes(circle: &Circle): u64 {
        config::get_recovery_no_votes(&circle.id)
    }

    public fun get_recovery_vote_count(circle: &Circle): u64 {
        config::get_recovery_vote_count(&circle.id)
    }

    public fun get_recovery_eligible_voters(circle: &Circle): vector<address> {
        config::get_recovery_eligible_voters(&circle.id)
    }

    public fun get_recovery_votes(circle: &Circle): vector<config::RecoveryVote> {
        config::get_recovery_votes(&circle.id)
    }

    public fun is_recovery_majority_reached(circle: &Circle): bool {
        config::is_recovery_majority_reached(&circle.id)
    }

    public fun is_recovery_proposal_passed(circle: &Circle): bool {
        config::is_recovery_proposal_passed(&circle.id)
    }

    public fun is_auto_release_enabled(circle: &Circle): bool {
        config::is_auto_release_enabled(&circle.id)
    }

    public fun get_auto_release_delay_ms(circle: &Circle): u64 {
        config::get_auto_release_delay_ms(&circle.id)
    }

    public fun has_next_in_command(circle: &Circle): bool {
        config::has_next_in_command(&circle.id)
    }

    public fun get_next_in_command(circle: &Circle): Option<address> {
        config::get_next_in_command(&circle.id)
    }

    public fun get_last_admin_heartbeat_at(circle: &Circle): u64 {
        config::get_last_admin_heartbeat_at(&circle.id)
    }

    public fun get_auto_release_start_time(circle: &Circle): u64 {
        config::get_auto_release_start_time(&circle.id)
    }

    public fun get_auto_release_trigger_time(circle: &Circle): Option<u64> {
        config::get_auto_release_trigger_time(&circle.id)
    }

    public fun get_min_auto_release_delay_ms(circle: &Circle): u64 {
        config::get_min_auto_release_delay_ms_for_circle(&circle.id)
    }

    public fun is_auto_release_ready(circle: &Circle, clock: &Clock): bool {
        config::is_auto_release_ready(&circle.id, clock)
    }

    public fun can_execute_recovery(circle: &Circle, clock: &Clock): bool {
        config::can_execute_recovery(&circle.id, clock)
    }

    fun touch_admin_heartbeat(circle: &mut Circle, clock: &Clock) {
        config::touch_admin_heartbeat(&mut circle.id, clock);
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
    // Membership receipt helpers
    // ----------------------------------------------------------
    // Mint a soulbound membership receipt to `member_addr`. Called from every
    // path that adds a member (create_circle admin auto-join + admin approvals).
    fun issue_membership(
        circle_id: ID,
        member_addr: address,
        joined_at: u64,
        ctx: &mut TxContext,
    ) {
        transfer::transfer(
            CircleMembership {
                id: object::new(ctx),
                circle_id,
                member: member_addr,
                joined_at,
            },
            member_addr,
        );
    }

    // Backfill path: any current member of a circle can mint their own receipt.
    // Lets memberships that predate this upgrade become discoverable via
    // getOwnedObjects without admin involvement. Duplicate receipts are
    // harmless — the frontend dedups by circle_id and verifies against the
    // circle's members table.
    public fun claim_membership(
        circle: &Circle,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(is_member(circle, sender), ENotMember);
        issue_membership(
            object::uid_to_inner(&circle.id),
            sender,
            clock::timestamp_ms(clock),
            ctx,
        );
    }

    // Holder cleanup: let a member delete a stale/duplicate receipt (e.g. after
    // being removed from a circle). Purely optional — discovery already filters
    // stale receipts against the live members table.
    public fun burn_membership(receipt: CircleMembership) {
        let CircleMembership { id, circle_id: _, member: _, joined_at: _ } = receipt;
        object::delete(id);
    }

    // ----------------------------------------------------------
    // Admin approve member to join circle - entry function for frontend use
    // ----------------------------------------------------------
    public fun admin_approve_member(
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
        touch_admin_heartbeat(circle, clock);

        // Mint the soulbound membership receipt for scalable discovery.
        issue_membership(object::uid_to_inner(&circle.id), member_addr, current_time, ctx);

        // Emit enhanced MemberJoined event so the dashboard can detect this user's membership with full details
        event::emit(MemberJoined {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            position: option::none(),
            member_status: core::member_status_active(),
            currency_type: config::get_currency_type(&circle.id),
            contribution_amount_local: config::get_contribution_amount_local(&circle.id),
            security_deposit_local: config::get_security_deposit_local(&circle.id),
            deposit_paid: false,
            joined_at: current_time,
        });
    }
    
    // ----------------------------------------------------------
    // Admin approve multiple members to join circle at once - entry function for frontend
    // ----------------------------------------------------------
    public fun admin_approve_members(
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

                // Mint the soulbound membership receipt for scalable discovery.
                issue_membership(object::uid_to_inner(&circle.id), member_addr, current_time, ctx);

                // Emit enhanced MemberJoined event with full member details
                event::emit(MemberJoined {
                    circle_id: object::uid_to_inner(&circle.id),
                    member: member_addr,
                    position: option::none(),
                    member_status: core::member_status_active(),
                    currency_type: config::get_currency_type(&circle.id),
                    contribution_amount_local: config::get_contribution_amount_local(&circle.id),
                    security_deposit_local: config::get_security_deposit_local(&circle.id),
                    deposit_paid: false,
                    joined_at: current_time,
                });
            };
            
            i = i + 1;
        };

        touch_admin_heartbeat(circle, clock);
    }

    // ----------------------------------------------------------
    // Admin remove member from inactive circle and return security deposit
    // ----------------------------------------------------------
    public fun admin_remove_member(
        circle: &mut Circle,
        member_addr: address,
        wallet: &mut custody::CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Ensure that only the admin can remove members
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        
        // Ensure the circle is not active - only allow removal from inactive circles
        assert!(!circle.is_active, ECircleIsActive);
        
        // Ensure the member exists in the circle
        assert!(is_member(circle, member_addr), ENotMember);
        
        // Verify wallet belongs to this circle
        assert!(custody::get_circle_id(wallet) == get_id(circle), EWalletCircleMismatch);
        
        // Get member data before removal
        let member = table::borrow(&circle.members, member_addr);
        let deposit_amount = members::get_deposit_balance(member);
        let has_deposit = members::has_paid_deposit(member);
        
        // Remove member from the circle's members table
        table::remove(&mut circle.members, member_addr);
        
        // Update current members count
        circle.current_members = circle.current_members - 1;
        
        // Remove from rotation order if present
        let rotation_len = vector::length(&circle.rotation_order);
        let mut i = 0;
        let mut found_position = option::none<u64>();
        
        while (i < rotation_len) {
            if (*vector::borrow(&circle.rotation_order, i) == member_addr) {
                found_position = option::some(i);
                break
            };
            i = i + 1;
        };
        
        // If member was in rotation order, replace with placeholder
        if (option::is_some(&found_position)) {
            let pos = *option::borrow(&found_position);
            *vector::borrow_mut(&mut circle.rotation_order, pos) = @0x0;
        };
        
        // If member had paid a security deposit, return it from custody wallet.
        // The release helper pulls from both the main balance and dynamic-field
        // storage transparently, so we no longer have to branch on storage shape.
        if (has_deposit && deposit_amount > 0) {
            let deposit_coin = custody::release_sui_to_member(
                wallet,
                deposit_amount,
                member_addr,
                clock,
                ctx
            );
            transfer::public_transfer(deposit_coin, member_addr);

            // Re-emit the legacy event shape so the WhatsApp bot listener in
            // whatsapp-bot-backend keeps notifying members without a refactor.
            event::emit(SecurityDepositReturned {
                circle_id: object::uid_to_inner(&circle.id),
                wallet_id: custody::get_circle_id(wallet),
                member: member_addr,
                amount: deposit_amount,
                coin_type: std::string::utf8(b"sui"),
                timestamp: clock::timestamp_ms(clock),
            });
        };
        
        // Clean up the removed member object (automatic in Move)
        
        // Emit MemberRemoved event
        event::emit(MemberRemoved {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            removed_by: sender,
            deposit_returned: has_deposit && deposit_amount > 0,
            deposit_amount: if (has_deposit && deposit_amount > 0) { deposit_amount } else { 0 },
            timestamp: clock::timestamp_ms(clock),
        });

        touch_admin_heartbeat(circle, clock);
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
    public fun member_deposit_security_deposit<CoinType>(
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
        // For USDC (6 decimals): Convert USD cents (2dp) to microUSDC (6dp) via custody helper.
        // For SUI (9 decimals): Use the raw security_deposit amount.
        let is_sui_deposit = std::type_name::get<CoinType>() == std::type_name::get<SUI>();
        
        // Check if it's SUI or stablecoin by comparing with SUI type
        if (is_sui_deposit) {
            // For SUI, validate against the SUI amount
            assert!(amount == required_sui_amount, 2); // EIncorrectDepositAmount
        } else {
            // For stablecoins like USDC, validate against USD amount
            // Convert USD cents (2dp) into USDC micro-units (6dp).
            let expected_stablecoin_amount = custody::usd_cents_to_usdc_amount(required_usd_cents);
            assert!(amount == expected_stablecoin_amount, 2); // EIncorrectDepositAmount
        };

        // --- Update Member State --- 
        members::set_deposit_balance(member, amount);
        members::set_deposit_paid(member, true);
        if (is_sui_deposit) {
            members::set_recovery_sui_deposit(member, amount);
            members::clear_recovery_stablecoin_deposit(member);
        } else {
            members::set_recovery_stablecoin_deposit(member, amount);
            members::clear_recovery_sui_deposit(member);
        };

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
    public fun deposit_stablecoin_with_price_validation<CoinType>(
        circle: &mut Circle,
        wallet: &mut custody::CustodyWallet,
        stablecoin: coin::Coin<CoinType>,
        mut required_amount: u64,
        price_info_object: &PriceInfoObject,
        clock: &clock::Clock,
        ctx: &mut tx_context::TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let deposit_amount = coin::value(&stablecoin);
        
        // Circle must be active
        assert!(circle.is_active, ECircleNotActive);
        
        // Verify the sender is a member of the circle
        assert!(table::contains(&circle.members, sender), ENotMember);
        
        // If we're using custom validation requirements
        if (required_amount == 0) {
            required_amount = config::get_security_deposit_usd(&circle.id);
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
        
        // Update member status (deposit amount already oracle-validated in custody module).
        update_member_status_after_deposit<CoinType>(circle, sender, deposit_amount, ctx);
    }
    
    // ----------------------------------------------------------
    // Update member status after deposit
    // ----------------------------------------------------------
    fun update_member_status_after_deposit<CoinType>(
        circle: &mut Circle,
        member_addr: address,
        deposit_amount: u64,
        ctx: &tx_context::TxContext
    ) {
        let current_time = tx_context::epoch_timestamp_ms(ctx);
        
        // Get the member record
        let member = table::borrow_mut(&mut circle.members, member_addr);
        let is_sui_deposit = std::type_name::get<CoinType>() == std::type_name::get<SUI>();

        members::set_deposit_balance(member, deposit_amount);
        members::set_deposit_paid(member, true);
        if (is_sui_deposit) {
            members::set_recovery_sui_deposit(member, deposit_amount);
            members::clear_recovery_stablecoin_deposit(member);
        } else {
            members::set_recovery_stablecoin_deposit(member, deposit_amount);
            members::clear_recovery_sui_deposit(member);
        };

        // If the member is pending, activate them.
        let member_status = members::get_status(member);
        if (member_status == core::member_status_pending()) {
            // Change status to active - use core values consistently
            members::set_status(member, core::member_status_active());
            members::set_activated_at(member, current_time);
            
            // Emit member activated event
            event::emit(MemberActivated {
                circle_id: object::uid_to_inner(&circle.id),
                member: member_addr,
                deposit_amount
            });
        };
    }

    // ----------------------------------------------------------
    // Deposit stablecoin to circle with price validation
    // ----------------------------------------------------------
    public fun process_member_deposit(
        circle: &mut Circle, 
        deposit_amount: u64,
        member_addr: address,
        _ctx: &mut TxContext
    ): bool {
        // Make sure member exists in the circle
        assert!(is_member(circle, member_addr), 8);
        
        // Get security deposit requirement and USD value before getting mutable references
        let security_deposit = config::get_security_deposit(&circle.id);
        // Now get the member object (after the immutable borrow is done)
        let member = get_member_mut(circle, member_addr);
        
        // --- Validate deposit amount directly ---
        // Check if deposit is sufficient
        assert!(deposit_amount >= security_deposit, 2); // EIncorrectDepositAmount

        // --- Update Member State --- 
        members::set_deposit_balance(member, deposit_amount);
        members::set_recovery_sui_deposit(member, deposit_amount);
        members::clear_recovery_stablecoin_deposit(member);

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
    public fun update_wallet_id(
        circle: &mut Circle,
        wallet_id: ID,
        clock: &Clock,
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

        touch_admin_heartbeat(circle, clock);
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
    public fun contribute_stablecoin<CoinType>(
        circle: &mut Circle,
        wallet: &mut custody::CustodyWallet,
        payment: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&payment);

        // --- Basic Assertions ---
        // Compliance-gated circles must use the per-cycle escrow rail
        // (njangi_cycle_escrow::contribute_with_attestation). This legacy
        // custody rail performs no attestation checks, so allowing it here
        // would let members bypass the KYC gate with a hand-rolled PTB
        // (June 2026 audit). Security deposits
        // (member_deposit_security_deposit) and all refund/recovery paths
        // stay ungated — they only return a member's own funds.
        assert!(!requires_attestation(circle), E_COMPLIANCE_ATTESTATION_REQUIRED);
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

        // One contribution per member per payout round (shared across the
        // SUI and stablecoin rails). Aborts E_ALREADY_CONTRIBUTED_THIS_CYCLE.
        record_cycle_contributor(circle, sender);

        // --- Amount Validation ---
        // Get required contribution amount in USD from config
        let required_contribution_usd_cents = config::get_contribution_amount_usd(&circle.id);
        // Convert required USD cents (2dp) to USDC micro-units (6dp).
        let required_stablecoin_amount = custody::usd_cents_to_usdc_amount(required_contribution_usd_cents);

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
        members::add_recovery_stablecoin_contributions(member_mut, amount);

        // Update cycle tracking in USD cents (definitive accounting unit).
        add_to_contributions_this_cycle(circle, required_contribution_usd_cents);

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
    public fun admin_set_max_members(
        circle: &mut Circle,
        new_max_members: u64,
        clock: &Clock,
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
        touch_admin_heartbeat(circle, clock);
        
        // Emit event
        event::emit(CircleMaxMembersUpdated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: sender,
            old_max_members,
            new_max_members,
        });
    }

    // ----------------------------------------------------------
    // Admin function to update cycle limits and contribution requirements.
    // USD cents are the source of truth; native amounts are derived for display paths.
    // ----------------------------------------------------------
    public fun update_cycle_limits(
        circle: &mut Circle,
        cycle_length: u64,
        cycle_day: u64,
        contribution_amount_usd: u64,
        security_deposit_usd: u64,
        contribution_amount_local: u64,
        security_deposit_local: u64,
        sui_price_usd_cents: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        assert!(!circle.is_active, ECircleIsActive);

        assert!(contribution_amount_usd > 0, EInvalidContributionAmount);
        assert!(
            security_deposit_usd >= core::min_security_deposit(contribution_amount_usd),
            EIncorrectDepositAmount
        );
        assert!(cycle_length <= 3, 3);
        assert!(is_valid_cycle_schedule(cycle_length, cycle_day), 4);

        // Derive native display values from USD cents using supplied price context.
        let (contribution_amount_native, security_deposit_native) = derive_native_display_amounts(
            contribution_amount_usd,
            security_deposit_usd,
            sui_price_usd_cents
        );

        let old_cycle_length = config::get_cycle_length(&circle.id);
        let old_cycle_day = config::get_cycle_day(&circle.id);
        let old_contribution_usd_cents = config::get_contribution_amount_usd(&circle.id);
        let old_security_deposit_usd_cents = config::get_security_deposit_usd(&circle.id);

        config::set_contribution_requirements(
            &mut circle.id,
            contribution_amount_native,
            contribution_amount_local,
            contribution_amount_usd,
            security_deposit_native,
            security_deposit_local,
            security_deposit_usd
        );
        config::set_cycle_schedule(&mut circle.id, cycle_length, cycle_day);

        // Reset in-flight cycle accounting to avoid mismatched thresholds.
        circle.contributions_this_cycle = 0;
        clear_cycle_contributors(circle);
        circle.next_payout_time = core::calculate_next_payout_time(
            cycle_length,
            cycle_day,
            tx_context::epoch_timestamp_ms(ctx)
        );
        touch_admin_heartbeat(circle, clock);

        event::emit(CycleLimitsUpdated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: sender,
            old_cycle_length,
            new_cycle_length: cycle_length,
            old_cycle_day,
            new_cycle_day: cycle_day,
            old_contribution_usd_cents,
            new_contribution_usd_cents: contribution_amount_usd,
            old_security_deposit_usd_cents,
            new_security_deposit_usd_cents: security_deposit_usd,
        });
    }

    public fun update_next_in_command(
        circle: &mut Circle,
        next_in_command: Option<address>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        assert!(
            config::get_recovery_state(&circle.id) == config::recovery_state_active(),
            ERecoveryDelegateUpdateLocked
        );
        if (option::is_some(&next_in_command)) {
            assert!(*option::borrow(&next_in_command) != circle.admin, EInvalidRecoveryDelegate);
        };

        if (circle.is_active && config::is_auto_release_enabled(&circle.id)) {
            config::assert_auto_release_delegate_requirement(true, &next_in_command);
            let delegate = *option::borrow(&next_in_command);
            assert!(can_active_member_trigger_auto_release(circle, delegate), EInvalidRecoveryDelegate);
        };

        config::set_next_in_command(&mut circle.id, next_in_command);
        touch_admin_heartbeat(circle, clock);

        event::emit(RecoveryDelegateUpdated {
            circle_id: object::uid_to_inner(&circle.id),
            admin: sender,
            next_in_command,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    public fun heartbeat_admin_liveness(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, ENotAdmin);
        touch_admin_heartbeat(circle, clock);
    }

    // Same as update_cycle_limits, but resolves SUI/USD price from oracle
    // with stale-price fallback and volatility circuit-breaker.
    public fun update_cycle_limits_with_oracle(
        circle: &mut Circle,
        cycle_length: u64,
        cycle_day: u64,
        contribution_amount_usd: u64,
        security_deposit_usd: u64,
        contribution_amount_local: u64,
        security_deposit_local: u64,
        price_info_object: &PriceInfoObject,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sui_price_usd_cents = resolve_sui_price_usd_cents_from_oracle(
            circle,
            price_info_object,
            clock
        );

        update_cycle_limits(
            circle,
            cycle_length,
            cycle_day,
            contribution_amount_usd,
            security_deposit_usd,
            contribution_amount_local,
            security_deposit_local,
            sui_price_usd_cents,
            clock,
            ctx
        );
    }

    // ----------------------------------------------------------
    // Admin function to refresh native display amounts from USD
    // without changing USD-centric logic thresholds.
    // ----------------------------------------------------------
    public fun sync_native_display_amounts(
        circle: &mut Circle,
        sui_price_usd_cents: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);

        let contribution_usd_cents = config::get_contribution_amount_usd(&circle.id);
        let security_deposit_usd_cents = config::get_security_deposit_usd(&circle.id);
        let (contribution_native_amount, security_deposit_native_amount) = derive_native_display_amounts(
            contribution_usd_cents,
            security_deposit_usd_cents,
            sui_price_usd_cents
        );

        config::set_native_display_amounts(
            &mut circle.id,
            contribution_native_amount,
            security_deposit_native_amount
        );
        touch_admin_heartbeat(circle, clock);

        event::emit(NativeDisplayAmountsSynced {
            circle_id: object::uid_to_inner(&circle.id),
            admin: sender,
            contribution_usd_cents,
            contribution_native_amount,
            security_deposit_usd_cents,
            security_deposit_native_amount,
            sui_price_usd_cents,
        });
    }

    // Resolve price from oracle and sync native display amounts.
    public fun sync_native_display_amounts_with_oracle(
        circle: &mut Circle,
        price_info_object: &PriceInfoObject,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sui_price_usd_cents = resolve_sui_price_usd_cents_from_oracle(
            circle,
            price_info_object,
            clock
        );
        sync_native_display_amounts(circle, sui_price_usd_cents, clock, ctx);
    }

    // ----------------------------------------------------------
    // Automatic Payout Helper Functions
    // ----------------------------------------------------------
    
    // Get the current cycle contribution total in USD cents.
    public fun get_contributions_this_cycle(circle: &Circle): u64 {
        circle.contributions_this_cycle
    }
    
    // Add a USD-cent amount to the cycle contribution counter.
    public(package) fun add_to_contributions_this_cycle(circle: &mut Circle, amount: u64) {
        circle.contributions_this_cycle = circle.contributions_this_cycle + amount;
    }

    // Reset the contributions counter for this cycle (after a payout)
    public(package) fun reset_contributions_this_cycle(circle: &mut Circle) {
        circle.contributions_this_cycle = 0;
        clear_cycle_contributors(circle);
    }

    // ----------------------------------------------------------
    // Per-round contributor de-duplication (legacy custody path).
    // The per-cycle escrow already enforces one-contribution-per-member
    // via its `contributed` table; these helpers give the legacy
    // `contribute` / `contribute_stablecoin` rails the same guarantee so
    // a single member can no longer satisfy `has_all_members_contributed`
    // by paying multiple times. The record is shared across both payment
    // rails (SUI and stablecoin): one contribution per member per round,
    // regardless of currency.
    // ----------------------------------------------------------

    // True when `member` already has a recorded contribution for the
    // current payout round.
    public fun has_contributed_this_cycle(circle: &Circle, member: address): bool {
        let key = string::utf8(FIELD_CYCLE_CONTRIBUTORS);
        if (!dynamic_field::exists_(&circle.id, key)) {
            return false
        };
        let contributors = dynamic_field::borrow<String, vector<address>>(&circle.id, key);
        vector::contains(contributors, &member)
    }

    // Record `member` as having contributed for the current payout round.
    // Aborts with E_ALREADY_CONTRIBUTED_THIS_CYCLE on a duplicate.
    public(package) fun record_cycle_contributor(circle: &mut Circle, member: address) {
        let key = string::utf8(FIELD_CYCLE_CONTRIBUTORS);
        if (!dynamic_field::exists_(&circle.id, key)) {
            dynamic_field::add<String, vector<address>>(&mut circle.id, key, vector[]);
        };
        let contributors = dynamic_field::borrow_mut<String, vector<address>>(&mut circle.id, key);
        assert!(!vector::contains(contributors, &member), E_ALREADY_CONTRIBUTED_THIS_CYCLE);
        vector::push_back(contributors, member);
    }

    // Clear the contributor record. Must be called everywhere
    // `contributions_this_cycle` is reset so the two stay in lockstep.
    fun clear_cycle_contributors(circle: &mut Circle) {
        let key = string::utf8(FIELD_CYCLE_CONTRIBUTORS);
        if (dynamic_field::exists_(&circle.id, key)) {
            let contributors = dynamic_field::borrow_mut<String, vector<address>>(&mut circle.id, key);
            *contributors = vector[];
        };
    }
    
    // ----------------------------------------------------------
    // Reset the payout status for all members in the rotation (for a new cycle)
    // ----------------------------------------------------------
    public(package) fun reset_all_members_payout_status(circle: &mut Circle) {
        // Get all the non-zero addresses from rotation_order
        let rotation = &circle.rotation_order;
        let len = vector::length(rotation);
        let mut i = 0;

        while (i < len) {
            let member_addr = *vector::borrow(rotation, i);

            // Skip placeholder addresses
            if (member_addr != @0x0 && table::contains(&circle.members, member_addr)) {
                let member = table::borrow_mut(&mut circle.members, member_addr);
                // Make sure to set received_payout to false regardless of current value
                members::set_received_payout(member, false);
            };
            i = i + 1;
        };
    }
    
    // ----------------------------------------------------------
    // Reset deposit status for all members in the rotation (for a new cycle)
    // ----------------------------------------------------------
    public(package) fun reset_all_members_deposit_status(circle: &mut Circle, ctx: &TxContext) {
        // Get all the non-zero addresses from rotation_order
        let rotation = &circle.rotation_order;
        let len = vector::length(rotation);
        let mut i = 0;

        while (i < len) {
            let member_addr = *vector::borrow(rotation, i);

            // Skip placeholder addresses
            if (member_addr != @0x0 && table::contains(&circle.members, member_addr)) {
                let member = table::borrow_mut(&mut circle.members, member_addr);
                // Reset deposit status to false for all members
                members::set_deposit_paid(member, false);
            };
            i = i + 1;
        };
        
        // Emit the member deposits reset event
        event::emit(MemberDepositsReset {
            circle_id: object::uid_to_inner(&circle.id),
            admin: circle.admin,
            cycle: circle.current_cycle,
            timestamp: tx_context::epoch_timestamp_ms(ctx)
        });
    }
    
    // ----------------------------------------------------------
    // Reset contribution status for all members except the current recipient
    // ----------------------------------------------------------
    public(package) fun reset_all_members_contribution_status(circle: &mut Circle) {
        // Reset the contributions counter for this cycle
        circle.contributions_this_cycle = 0;
        clear_cycle_contributors(circle);

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
                };
            };
            i = i + 1;
        };
    }
    
    // ----------------------------------------------------------
    // Advance rotation position and cycle management
    // ----------------------------------------------------------
    public(package) fun advance_rotation_position_and_cycle(
        circle: &mut Circle, 
        paid_member_address: address,
        clock: &Clock
    ) {
        // Add the paid member to rotation history
        vector::push_back(&mut circle.rotation_history, paid_member_address);
        
        // Calculate next position
        let rotation_len = vector::length(&circle.rotation_order);

        // We reset all members' contribution status for the new position/cycle
        reset_all_members_contribution_status(circle);
        
        // Get cycle configuration for time calculations
        let cycle_length = config::get_cycle_length(&circle.id);
        let cycle_day = config::get_cycle_day(&circle.id);
        let now = clock::timestamp_ms(clock);
        
        // If we're at the last position in the rotation, pause after cycle completion
        if (circle.current_position + 1 >= rotation_len) {
            // Set paused_after_cycle flag to true
            circle.paused_after_cycle = true;
            
            // We don't advance the cycle yet since we're paused
            // The admin will need to call resume_cycle to continue
            
            // Update next_payout_time to current time to prevent automatic payouts
            circle.next_payout_time = now;

            // Emit event
            event::emit(CyclePaused {
                circle_id: object::uid_to_inner(&circle.id),
                admin: circle.admin,
                cycle_completed: circle.current_cycle,
            });
        } else {
            // Just move to the next position in the same cycle
            circle.current_position = circle.current_position + 1;
            
            // For position advancement within the same cycle, we need to maintain the cycle pattern
            // For weekly cycles, we need to stay on the same weekday
            // For monthly cycles, we need to stay on the same day of month, etc.
            
            if (circle.current_position == 0) {
                // This means we're at the first position after cycling (edge case)
                // Calculate like a new cycle
                circle.next_payout_time = core::calculate_next_payout_time(
                    cycle_length, 
                    cycle_day, 
                    now
                );
            } else {
                // We're advancing positions within the same cycle
                
                // Calculate the proper interval based on cycle type
                let interval_ms = if (cycle_length == 0) { // Weekly cycle
                    // For weekly cycles, we maintain the same weekday
                    // Calculate days until the next instance of the same weekday
                    core::ms_per_day() * 7 / rotation_len
                } else if (cycle_length == 3) { // Bi-weekly cycle
                    // For bi-weekly, same as weekly but with 14 days
                    core::ms_per_day() * 14 / rotation_len
                } else if (cycle_length == 1) { // Monthly cycle 
                    // For monthly, we try to keep the same day of month
                    // An average month is 30 days
                    core::ms_per_day() * 30 / rotation_len
                } else { // Quarterly cycle
                    // For quarterly cycles (90 days)
                    core::ms_per_day() * 90 / rotation_len
                };
                
                // Update next_payout_time by adding the interval
                circle.next_payout_time = circle.next_payout_time + interval_ms;
                
                // If this is a weekly or bi-weekly cycle, we need to verify the weekday matches
                if (cycle_length == 0 || cycle_length == 3) {
                    // Get the weekday of the calculated next payout
                    let next_weekday = core::get_weekday(circle.next_payout_time);

                    // If the weekday has drifted from the configured cycle_day, recalculate
                    if (next_weekday != cycle_day) {
                        // Recalculate to get back to the correct weekday
                        // We still want the next position's payout, but on the right day
                        let days_to_add = if (cycle_day >= next_weekday) {
                            cycle_day - next_weekday
                        } else {
                            7 - (next_weekday - cycle_day) // Days until next occurrence
                        };
                        
                        // Adjust the next_payout_time to be on the correct weekday
                        // Keep the time of day the same
                        let time_of_day_ms = core::get_day_ms(circle.next_payout_time);
                        let base_day = circle.next_payout_time - time_of_day_ms; // Midnight of the day
                        
                        // Add days to get to the correct weekday, plus the time of day
                        circle.next_payout_time = base_day + (days_to_add * core::ms_per_day()) + time_of_day_ms;
                    };
                };
            };
        };
    }
    
    // ----------------------------------------------------------
    // Admin function to resume cycle after pause
    // ----------------------------------------------------------
    public fun resume_cycle(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Only admin can resume the cycle
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        
        // Circle must be active and paused
        assert!(circle.is_active, 54);
        assert!(circle.paused_after_cycle, 57); // New error code for "Circle is not paused"
        
        // Reset position to 0 for the next cycle
        circle.current_position = 0;
        
        // Increment cycle
        circle.current_cycle = circle.current_cycle + 1;
        
        // Reset all member payout status
        reset_all_members_payout_status(circle);
        
        // Reset all member deposit status for new security deposits
        reset_all_members_deposit_status(circle, ctx);
        
        // Calculate next payout time based on the cycle configuration
        circle.next_payout_time = core::calculate_next_payout_time(
            config::get_cycle_length(&circle.id),
            config::get_cycle_day(&circle.id),
            clock::timestamp_ms(clock)
        );
        
        // Clear pause flag
        circle.paused_after_cycle = false;
        touch_admin_heartbeat(circle, clock);
        
        // Emit event for cycle resumed
        event::emit(CycleResumed {
            circle_id: object::uid_to_inner(&circle.id),
            admin: circle.admin,
            new_cycle: circle.current_cycle,
        });
    }

    // ----------------------------------------------------------
    // Emergency stop proposal and voting
    // ----------------------------------------------------------
    public fun propose_emergency_stop(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);

        clear_expired_recovery_proposal_if_needed(circle, clock);

        let eligible_voters = snapshot_recovery_voters(circle);
        let eligible_voter_count = vector::length(&eligible_voters);
        assert!(eligible_voter_count > 0, ENoRecoveryEligibleVoters);

        let majority_threshold = recovery_majority_threshold(eligible_voter_count);
        let created_at = clock::timestamp_ms(clock);
        let deadline = created_at + EMERGENCY_STOP_VOTING_WINDOW_MS;

        config::begin_recovery_proposal(
            &mut circle.id,
            sender,
            eligible_voters,
            majority_threshold,
            deadline,
            clock
        );
        touch_admin_heartbeat(circle, clock);

        event::emit(EmergencyStopProposed {
            circle_id: object::uid_to_inner(&circle.id),
            proposer: sender,
            eligible_voter_count,
            majority_threshold,
            deadline,
            timestamp: created_at,
        });
    }

    public fun vote_emergency_stop(
        circle: &mut Circle,
        yes_vote: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(config::has_recovery_proposal(&circle.id), ERecoveryProposalMissing);

        let current_time = clock::timestamp_ms(clock);
        let deadline_opt = config::get_recovery_proposal_deadline(&circle.id);
        assert!(option::is_some(&deadline_opt), ERecoveryProposalMissing);
        let deadline = *option::borrow(&deadline_opt);
        if (current_time > deadline && !config::is_recovery_proposal_passed(&circle.id)) {
            config::clear_recovery_proposal(&mut circle.id, clock);
            abort ERecoveryProposalExpired
        };

        assert!(!config::is_recovery_proposal_passed(&circle.id), ERecoveryVotingClosed);
        assert!(config::has_recovery_eligible_voter(&circle.id, sender), ERecoveryVoteNotEligible);
        assert!(!config::has_recovery_vote_from(&circle.id, sender), ERecoveryVoteAlreadyCast);

        config::append_recovery_vote(&mut circle.id, sender, yes_vote, clock);

        let yes_votes = config::get_recovery_yes_votes(&circle.id);
        let no_votes = config::get_recovery_no_votes(&circle.id);
        let threshold_opt = config::get_recovery_majority_threshold(&circle.id);
        assert!(option::is_some(&threshold_opt), ERecoveryProposalMissing);
        let majority_threshold = *option::borrow(&threshold_opt);

        event::emit(EmergencyStopVoteCast {
            circle_id: object::uid_to_inner(&circle.id),
            voter: sender,
            approved: yes_vote,
            yes_votes,
            no_votes,
            majority_threshold,
            timestamp: current_time,
        });

        if (config::is_recovery_proposal_passed(&circle.id)) {
            event::emit(EmergencyStopMajorityReached {
                circle_id: object::uid_to_inner(&circle.id),
                yes_votes,
                majority_threshold,
                reached_at: current_time,
            });
        };
    }

    public fun execute_recovery<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(
            config::can_execute_recovery(&circle.id, clock)
                && config::is_recovery_proposal_passed(&circle.id),
            ERecoveryExecutionNotReady
        );
        execute_recovery_internal<CoinType>(
            circle,
            wallet,
            false,
            RECOVERY_TRIGGER_ROLE_VOTE_EXECUTION,
            clock,
            ctx
        );
    }

    public fun trigger_auto_release<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(config::is_auto_release_ready(&circle.id, clock), ERecoveryExecutionNotReady);
        let current_time = clock::timestamp_ms(clock);
        let trigger_role = resolve_auto_release_trigger_role(circle, tx_context::sender(ctx), current_time);
        execute_recovery_internal<CoinType>(circle, wallet, true, trigger_role, clock, ctx);
    }

    fun execute_recovery_internal<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        used_auto_release: bool,
        trigger_role: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let executor = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        assert!(custody::get_circle_id(wallet) == get_id(circle), EWalletCircleMismatch);

        let member_addresses = recovery_member_addresses(circle);
        assert!(vector::length(&member_addresses) == circle.current_members, ERecoveryMemberSnapshotMismatch);

        let (total_sui_refund, total_stablecoin_refund) = get_recovery_refund_totals(circle, &member_addresses);
        assert!(custody::get_total_wallet_balance(wallet) >= total_sui_refund, ERecoveryInsufficientWalletBalance);
        assert!(custody::get_stablecoin_balance<CoinType>(wallet) >= total_stablecoin_refund, ERecoveryInsufficientWalletBalance);

        event::emit(RecoveryExecutionStarted {
            circle_id: object::uid_to_inner(&circle.id),
            executor,
            member_count: vector::length(&member_addresses),
            total_sui_refund,
            total_stablecoin_refund,
            used_auto_release,
            trigger_role,
            timestamp: current_time,
        });

        config::mark_recovery_stopped(&mut circle.id, clock);
        circle.is_active = false;
        circle.paused_after_cycle = false;
        circle.contributions_this_cycle = 0;
        clear_cycle_contributors(circle);
        circle.next_payout_time = current_time;
        circle.active_auction = option::none();

        let mut refunded_members = 0;
        let member_count = vector::length(&member_addresses);
        let mut i = 0;
        while (i < member_count) {
            let member_addr = *vector::borrow(&member_addresses, i);
            let member = get_member(circle, member_addr);
            let sui_contributions_refunded = members::get_recovery_sui_contributions(member);
            let sui_deposit_refunded = members::get_recovery_sui_deposit(member);
            let stablecoin_contributions_refunded = members::get_recovery_stablecoin_contributions(member);
            let stablecoin_deposit_refunded = members::get_recovery_stablecoin_deposit(member);
            let member_sui_refund = sui_contributions_refunded + sui_deposit_refunded;
            let member_stablecoin_refund = stablecoin_contributions_refunded + stablecoin_deposit_refunded;

            if (member_sui_refund > 0) {
                let refund_coin = custody::withdraw_sui_for_recovery(
                    wallet,
                    member_sui_refund,
                    member_addr,
                    clock,
                    ctx
                );
                transfer::public_transfer(refund_coin, member_addr);
            };

            if (member_stablecoin_refund > 0) {
                let refund_coin = custody::withdraw_stablecoin_for_recovery<CoinType>(
                    wallet,
                    member_stablecoin_refund,
                    member_addr,
                    clock,
                    ctx
                );
                transfer::public_transfer(refund_coin, member_addr);
            };

            if (member_sui_refund > 0 || member_stablecoin_refund > 0) {
                refunded_members = refunded_members + 1;
            };

            if (
                member_sui_refund > 0
                    || member_stablecoin_refund > 0
                    || sui_deposit_refunded > 0
                    || stablecoin_deposit_refunded > 0
            ) {
                let member_mut = get_member_mut(circle, member_addr);
                if (sui_deposit_refunded > 0 || stablecoin_deposit_refunded > 0) {
                    members::set_deposit_balance(member_mut, 0);
                    members::set_deposit_paid(member_mut, false);
                };
                members::clear_all_recovery_balances(member_mut);
            };

            if (
                sui_contributions_refunded > 0
                    || sui_deposit_refunded > 0
                    || stablecoin_contributions_refunded > 0
                    || stablecoin_deposit_refunded > 0
            ) {
                event::emit(RecoveryMemberRefunded {
                    circle_id: object::uid_to_inner(&circle.id),
                    member: member_addr,
                    sui_contributions_refunded,
                    sui_deposit_refunded,
                    stablecoin_contributions_refunded,
                    stablecoin_deposit_refunded,
                    timestamp: current_time,
                });
            };

            i = i + 1;
        };

        config::mark_recovery_refunded(&mut circle.id, clock);

        event::emit(RecoveryExecutionCompleted {
            circle_id: object::uid_to_inner(&circle.id),
            executor,
            refunded_members,
            total_sui_refund,
            total_stablecoin_refund,
            timestamp: current_time,
        });
    }

    // ----------------------------------------------------------
    // Check if circle is paused after cycle
    // ----------------------------------------------------------
    public fun is_paused_after_cycle(circle: &Circle): bool {
        circle.paused_after_cycle
    }

    fun resolve_auto_release_trigger_role(circle: &Circle, caller: address, current_time: u64): u8 {
        let valid_delegate = get_valid_auto_release_delegate(circle);
        let has_valid_delegate = option::is_some(&valid_delegate);
        let caller_is_delegate = if (has_valid_delegate) {
            *option::borrow(&valid_delegate) == caller
        } else {
            false
        };
        let caller_can_fallback = can_active_member_trigger_auto_release(circle, caller);
        let trigger_time = config::get_auto_release_trigger_time(&circle.id);
        assert!(option::is_some(&trigger_time), ERecoveryExecutionNotReady);
        let member_fallback_open = is_auto_release_member_fallback_open_internal(
            has_valid_delegate,
            *option::borrow(&trigger_time),
            current_time
        );

        resolve_auto_release_trigger_role_internal(
            has_valid_delegate,
            caller_is_delegate,
            caller_can_fallback,
            member_fallback_open
        )
    }

    fun resolve_auto_release_trigger_role_internal(
        has_valid_delegate: bool,
        caller_is_delegate: bool,
        caller_can_fallback: bool,
        member_fallback_open: bool
    ): u8 {
        assert!(
            can_trigger_auto_release_internal(
                has_valid_delegate,
                caller_is_delegate,
                caller_can_fallback,
                member_fallback_open
            ),
            ERecoveryAutoReleaseUnauthorized
        );

        if (has_valid_delegate && !member_fallback_open && caller_is_delegate) {
            RECOVERY_TRIGGER_ROLE_DELEGATE
        } else {
            RECOVERY_TRIGGER_ROLE_MEMBER_FALLBACK
        }
    }

    fun get_valid_auto_release_delegate(circle: &Circle): Option<address> {
        let next_in_command = config::get_next_in_command(&circle.id);
        if (option::is_none(&next_in_command)) {
            return option::none()
        };

        let delegate = *option::borrow(&next_in_command);
        if (delegate == circle.admin || !can_active_member_trigger_auto_release(circle, delegate)) {
            option::none()
        } else {
            option::some(delegate)
        }
    }

    fun can_active_member_trigger_auto_release(circle: &Circle, caller: address): bool {
        can_active_member_trigger_auto_release_internal(
            caller == circle.admin,
            is_recovery_snapshot_eligible(circle, caller)
        )
    }

    fun can_trigger_auto_release_internal(
        has_valid_delegate: bool,
        caller_is_delegate: bool,
        caller_can_fallback: bool,
        member_fallback_open: bool
    ): bool {
        if (has_valid_delegate && !member_fallback_open) {
            caller_is_delegate
        } else {
            caller_can_fallback
        }
    }

    fun is_auto_release_member_fallback_open_internal(
        has_valid_delegate: bool,
        trigger_time: u64,
        current_time: u64
    ): bool {
        !has_valid_delegate || current_time >= trigger_time + AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS
    }

    fun can_active_member_trigger_auto_release_internal(
        caller_is_admin: bool,
        caller_is_snapshot_eligible: bool
    ): bool {
        !caller_is_admin && caller_is_snapshot_eligible
    }

    fun snapshot_recovery_voters(circle: &Circle): vector<address> {
        let mut eligible_voters = vector::empty<address>();
        let members_list = get_circle_members(circle);
        let mut i = 0;
        let member_count = vector::length(&members_list);

        while (i < member_count) {
            let member_addr = *vector::borrow(&members_list, i);
            if (
                member_addr != @0x0
                    && table::contains(&circle.members, member_addr)
                    && is_recovery_snapshot_eligible(circle, member_addr)
                    && !vector::contains(&eligible_voters, &member_addr)
            ) {
                vector::push_back(&mut eligible_voters, member_addr);
            };
            i = i + 1;
        };

        eligible_voters
    }

    fun is_recovery_snapshot_eligible(circle: &Circle, member_addr: address): bool {
        if (!table::contains(&circle.members, member_addr)) {
            return false
        };

        let member = table::borrow(&circle.members, member_addr);
        members::get_status(member) == core::member_status_active()
            && option::is_none(&members::get_suspension_end_time(member))
    }

    fun recovery_majority_threshold(member_count: u64): u64 {
        if (member_count == 0) {
            0
        } else {
            (member_count / 2) + 1
        }
    }

    fun clear_expired_recovery_proposal_if_needed(circle: &mut Circle, clock: &Clock) {
        if (!config::has_recovery_proposal(&circle.id)) {
            return
        };
        if (config::is_recovery_majority_reached(&circle.id)) {
            return
        };

        let deadline_opt = config::get_recovery_proposal_deadline(&circle.id);
        if (option::is_none(&deadline_opt)) {
            return
        };

        let deadline = *option::borrow(&deadline_opt);
        if (clock::timestamp_ms(clock) > deadline) {
            config::clear_recovery_proposal(&mut circle.id, clock);
        };
    }

    fun recovery_member_addresses(circle: &Circle): vector<address> {
        let mut member_addresses = vector::empty<address>();
        let rotation = &circle.rotation_order;
        let len = vector::length(rotation);
        let mut i = 0;

        while (i < len) {
            let member_addr = *vector::borrow(rotation, i);
            if (
                member_addr != @0x0
                    && table::contains(&circle.members, member_addr)
                    && !vector::contains(&member_addresses, &member_addr)
            ) {
                vector::push_back(&mut member_addresses, member_addr);
            };
            i = i + 1;
        };

        member_addresses
    }

    fun get_recovery_refund_totals(
        circle: &Circle,
        member_addresses: &vector<address>
    ): (u64, u64) {
        let mut total_sui_refund = 0;
        let mut total_stablecoin_refund = 0;
        let member_count = vector::length(member_addresses);
        let mut i = 0;

        while (i < member_count) {
            let member_addr = *vector::borrow(member_addresses, i);
            let member = get_member(circle, member_addr);
            total_sui_refund =
                total_sui_refund
                    + members::get_recovery_sui_contributions(member)
                    + members::get_recovery_sui_deposit(member);
            total_stablecoin_refund =
                total_stablecoin_refund
                    + members::get_recovery_stablecoin_contributions(member)
                    + members::get_recovery_stablecoin_deposit(member);
            i = i + 1;
        };

        (total_sui_refund, total_stablecoin_refund)
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
    
    // Count the active members in the rotation and whether the scheduled
    // recipient (member at current_position) is one of them. Shared by the
    // funding gate and the payout-amount calculation so the two can never
    // disagree about how many contributions a cycle collects.
    fun count_active_members_and_recipient(circle: &Circle): (u64, bool) {
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

        (active_members, recipient_is_active)
    }

    // Number of members expected to contribute for the current payout round:
    // active members in the rotation, excluding the scheduled recipient when
    // that recipient is active (the recipient never pays into their own
    // payout — same economics as the per-cycle escrow's required_contributors
    // = member_count - 1). This is the only multiplier the legacy payout may
    // use: paying contribution x member_count would silently draw the
    // shortfall from commingled security deposits.
    public fun current_cycle_contributing_members(circle: &Circle): u64 {
        let (active_members, recipient_is_active) = count_active_members_and_recipient(circle);
        if (active_members == 0) {
            return 0
        };
        if (recipient_is_active) {
            active_members - 1
        } else {
            active_members
        }
    }

    // Check if all active members have contributed for the current cycle
    public fun has_all_members_contributed(circle: &Circle): bool {
        let (active_members, recipient_is_active) = count_active_members_and_recipient(circle);

        // If there are no active members, the check passes (sanity check)
        if (active_members == 0) {
            return true
        };

        // Calculate expected total contributions in USD cents.
        let contribution_amount_usd = config::get_contribution_amount_usd(&circle.id);

        let expected_contributions = expected_cycle_contributions_usd(
            contribution_amount_usd,
            active_members,
            recipient_is_active
        );

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

    public fun get_contribution_amount_local(circle: &Circle): u64 {
        config::get_contribution_amount_local(&circle.id)
    }

    public fun get_security_deposit_local(circle: &Circle): u64 {
        config::get_security_deposit_local(&circle.id)
    }

    public fun get_target_amount_local(circle: &Circle): Option<u64> {
        config::get_target_amount_local(&circle.id)
    }

    public fun get_contribution_amount_usd(circle: &Circle): u64 {
        config::get_contribution_amount_usd(&circle.id)
    }

    // Return (usd_cents_logic, native_9dp_display).
    public fun get_contribution_amount_dual(circle: &Circle): (u64, u64) {
        config::get_contribution_amount_dual(&circle.id)
    }

    // Valid schedule:
    // - weekly or bi-weekly: weekday index [0..6]
    // - monthly or quarterly: day-of-month [1..28]
    fun is_valid_cycle_schedule(cycle_length: u64, cycle_day: u64): bool {
        (cycle_length == 0 && cycle_day < 7)
            || (cycle_length == 3 && cycle_day < 7)
            || ((cycle_length == 1 || cycle_length == 2) && cycle_day > 0 && cycle_day <= 28)
    }

    // Convert SUI mist (9dp) to USD cents using the current SUI price.
    public fun sui_amount_to_usd_cents(sui_amount: u64, sui_price_usd_cents: u64): u64 {
        custody::sui_to_usd_cents(sui_amount, sui_price_usd_cents)
    }

    // Convert USD cents to SUI mist (9dp) using the current SUI price.
    public fun usd_cents_to_sui_amount(usd_cents: u64, sui_price_usd_cents: u64): u64 {
        custody::usd_cents_to_sui(usd_cents, sui_price_usd_cents)
    }

    public fun get_security_deposit_usd(circle: &Circle): u64 {
        config::get_security_deposit_usd(&circle.id)
    }

    // Return (usd_cents_logic, native_9dp_display).
    public fun get_security_deposit_dual(circle: &Circle): (u64, u64) {
        config::get_security_deposit_dual(&circle.id)
    }

    // Resolve SUI/USD oracle price with:
    // - stale check (> 1h uses last valid price)
    // - volatility circuit breaker (> 50% change uses last valid price)
    fun resolve_sui_price_usd_cents_from_oracle(
        circle: &mut Circle,
        price_info_object: &PriceInfoObject,
        clock: &Clock
    ): u64 {
        let (candidate_price_usd_cents, candidate_timestamp_seconds) = price_validator::get_sui_price_snapshot(
            price_info_object,
            clock,
            ORACLE_LOOKBACK_SECONDS
        );
        let now_seconds = clock::timestamp_ms(clock) / 1000;
        let candidate_age_seconds = if (now_seconds > candidate_timestamp_seconds) {
            now_seconds - candidate_timestamp_seconds
        } else {
            0
        };
        let last_valid_price = get_last_valid_sui_price_usd_cents(circle);

        let (resolved_price_usd_cents, used_fallback, fallback_reason) = choose_effective_sui_price(
            candidate_price_usd_cents,
            candidate_age_seconds,
            last_valid_price
        );

        // Only advance cache when we accepted the fresh candidate.
        if (!used_fallback) {
            cache_last_valid_sui_price(circle, resolved_price_usd_cents, candidate_timestamp_seconds);
        };

        event::emit(OraclePriceResolved {
            circle_id: object::uid_to_inner(&circle.id),
            candidate_price_usd_cents,
            resolved_price_usd_cents,
            candidate_age_seconds,
            used_fallback,
            fallback_reason,
        });

        resolved_price_usd_cents
    }

    // Returns:
    // (effective_price_usd_cents, used_fallback, fallback_reason)
    fun choose_effective_sui_price(
        candidate_price_usd_cents: u64,
        candidate_age_seconds: u64,
        last_valid_price_usd_cents: Option<u64>
    ): (u64, bool, u8) {
        if (candidate_price_usd_cents == 0) {
            if (option::is_some(&last_valid_price_usd_cents)) {
                return (*option::borrow(&last_valid_price_usd_cents), true, PRICE_FALLBACK_INVALID)
            };
            assert!(false, ENoValidOraclePrice);
        };

        if (candidate_age_seconds > ORACLE_MAX_STALE_SECONDS) {
            if (option::is_some(&last_valid_price_usd_cents)) {
                return (*option::borrow(&last_valid_price_usd_cents), true, PRICE_FALLBACK_STALE)
            };
            assert!(false, ENoValidOraclePrice);
        };

        if (option::is_some(&last_valid_price_usd_cents)) {
            let previous_price = *option::borrow(&last_valid_price_usd_cents);
            if (is_extreme_price_change(previous_price, candidate_price_usd_cents)) {
                return (previous_price, true, PRICE_FALLBACK_VOLATILITY)
            };
        };

        (candidate_price_usd_cents, false, PRICE_FALLBACK_NONE)
    }

    // Extreme volatility means > 50% absolute change from last valid price.
    fun is_extreme_price_change(previous_price: u64, candidate_price: u64): bool {
        if (previous_price == 0) {
            return false
        };

        let diff = if (candidate_price > previous_price) {
            candidate_price - previous_price
        } else {
            previous_price - candidate_price
        };

        diff > (previous_price / 2)
    }

    fun get_last_valid_sui_price_usd_cents(circle: &Circle): Option<u64> {
        if (dynamic_field::exists_(&circle.id, FIELD_LAST_VALID_SUI_PRICE_USD_CENTS)) {
            option::some(*dynamic_field::borrow(&circle.id, FIELD_LAST_VALID_SUI_PRICE_USD_CENTS))
        } else {
            option::none()
        }
    }

    fun cache_last_valid_sui_price(circle: &mut Circle, price_usd_cents: u64, timestamp_seconds: u64) {
        if (dynamic_field::exists_(&circle.id, FIELD_LAST_VALID_SUI_PRICE_USD_CENTS)) {
            *dynamic_field::borrow_mut(&mut circle.id, FIELD_LAST_VALID_SUI_PRICE_USD_CENTS) = price_usd_cents;
        } else {
            dynamic_field::add(&mut circle.id, FIELD_LAST_VALID_SUI_PRICE_USD_CENTS, price_usd_cents);
        };

        if (dynamic_field::exists_(&circle.id, FIELD_LAST_VALID_SUI_PRICE_TS_SEC)) {
            *dynamic_field::borrow_mut(&mut circle.id, FIELD_LAST_VALID_SUI_PRICE_TS_SEC) = timestamp_seconds;
        } else {
            dynamic_field::add(&mut circle.id, FIELD_LAST_VALID_SUI_PRICE_TS_SEC, timestamp_seconds);
        };
    }

    // Derive native display values from USD thresholds at a given SUI price.
    fun derive_native_display_amounts(
        contribution_usd_cents: u64,
        security_deposit_usd_cents: u64,
        sui_price_usd_cents: u64
    ): (u64, u64) {
        let contribution_native = usd_cents_to_sui_amount(contribution_usd_cents, sui_price_usd_cents);
        let security_deposit_native = usd_cents_to_sui_amount(security_deposit_usd_cents, sui_price_usd_cents);
        assert!(contribution_native > 0, EInvalidContributionAmount);
        assert!(security_deposit_native > 0, EIncorrectDepositAmount);
        (contribution_native, security_deposit_native)
    }

    // Contribution completeness is always based on USD amounts.
    fun expected_cycle_contributions_usd(
        contribution_usd_cents: u64,
        active_members: u64,
        recipient_is_active: bool
    ): u64 {
        if (active_members == 0) {
            return 0
        };

        let contributing_members = if (recipient_is_active) {
            active_members - 1
        } else {
            active_members
        };

        contribution_usd_cents * contributing_members
    }

    // ----------------------------------------------------------
    // Time-Based Automation Helper Functions
    // ----------------------------------------------------------

    // Check if a circle's payout is overdue
    public fun is_payout_overdue(circle: &Circle, clock: &Clock): bool {
        // Only check active circles
        if (!circle.is_active) {
            return false
        };

        // Don't consider paused circles as overdue
        if (circle.paused_after_cycle) {
            return false
        };

        let current_time = clock::timestamp_ms(clock);
        current_time > circle.next_payout_time
    }

    // Note: Batch processing will be handled in the automation service
    // Individual circle checking is done via is_circle_ready_for_automated_payout

    // Check if a circle is ready for automated payout
    public fun is_circle_ready_for_automated_payout(circle: &Circle, clock: &Clock): bool {
        // Must be active
        if (!circle.is_active) {
            return false
        };

        // Must not be paused
        if (circle.paused_after_cycle) {
            return false
        };

        // Must be overdue
        if (!is_payout_overdue(circle, clock)) {
            return false
        };

        // All members must have contributed
        if (!has_all_members_contributed(circle)) {
            return false
        };

        true
    }

    // Get comprehensive automation status for a circle
    public fun get_automation_status(circle: &Circle, clock: &Clock): AutomationStatus {
        let current_time = clock::timestamp_ms(clock);
        let next_payout = circle.next_payout_time;
        
        let is_overdue = current_time > next_payout;
        let time_until_payout = if (is_overdue) {
            0
        } else {
            next_payout - current_time
        };

        let all_contributed = has_all_members_contributed(circle);
        let is_ready = is_circle_ready_for_automated_payout(circle, clock);

        // Calculate warning level based on time remaining
        let warning_level = if (is_overdue) {
            4 // Overdue
        } else if (time_until_payout <= 3_600_000) { // 1 hour
            3
        } else if (time_until_payout <= 21_600_000) { // 6 hours
            2
        } else if (time_until_payout <= 86_400_000) { // 24 hours
            1
        } else {
            0 // No warning
        };

        AutomationStatus {
            is_overdue,
            time_until_payout,
            is_ready_for_payout: is_ready,
            all_members_contributed: all_contributed,
            warning_level,
        }
    }

    // Calculate time remaining until next payout (0 if overdue)
    public fun get_time_until_payout(circle: &Circle, clock: &Clock): u64 {
        let current_time = clock::timestamp_ms(clock);
        let next_payout = circle.next_payout_time;
        
        if (current_time >= next_payout) {
            0
        } else {
            next_payout - current_time
        }
    }

    // Calculate how long a payout has been overdue (0 if not overdue)
    public fun get_overdue_duration(circle: &Circle, clock: &Clock): u64 {
        let current_time = clock::timestamp_ms(clock);
        let next_payout = circle.next_payout_time;
        
        if (current_time <= next_payout) {
            0
        } else {
            current_time - next_payout
        }
    }

    // Check if circle should send warning notifications
    public fun should_send_warning(circle: &Circle, clock: &Clock, warning_hours: u64): bool {
        // Only for active, non-paused circles
        if (!circle.is_active || circle.paused_after_cycle) {
            return false
        };

        let time_until = get_time_until_payout(circle, clock);
        let warning_threshold_ms = warning_hours * 3_600_000; // Convert hours to milliseconds
        
        // Send warning if time remaining is less than threshold but still positive
        time_until > 0 && time_until <= warning_threshold_ms
    }

    // Get warning level for time-based notifications
    public fun get_warning_level(circle: &Circle, clock: &Clock): u8 {
        let time_until = get_time_until_payout(circle, clock);
        
        if (time_until == 0) {
            4 // Overdue
        } else if (time_until <= 3_600_000) { // 1 hour
            3
        } else if (time_until <= 21_600_000) { // 6 hours  
            2
        } else if (time_until <= 86_400_000) { // 24 hours
            1
        } else {
            0 // No warning needed
        }
    }

    // Emit automation events for logging and monitoring
    public fun emit_automation_triggered(
        circle: &Circle,
        automation_type: vector<u8>,
        success: bool,
        details: vector<u8>,
        clock: &Clock
    ) {
        event::emit(AutomationTriggered {
            circle_id: object::uid_to_inner(&circle.id),
            automation_type: string::utf8(automation_type),
            triggered_at: clock::timestamp_ms(clock),
            success,
            details: string::utf8(details),
        });
    }

    public fun emit_payout_overdue(circle: &Circle, clock: &Clock) {
        let current_time = clock::timestamp_ms(clock);
        let overdue_duration = get_overdue_duration(circle, clock);
        
        event::emit(PayoutOverdue {
            circle_id: object::uid_to_inner(&circle.id),
            overdue_duration_ms: overdue_duration,
            next_payout_time: circle.next_payout_time,
            current_time,
            all_contributed: has_all_members_contributed(circle),
        });
    }

    public fun emit_automation_failed(
        circle: &Circle,
        automation_type: vector<u8>,
        error_code: u64,
        error_message: vector<u8>,
        retry_count: u64,
        clock: &Clock
    ) {
        event::emit(AutomationFailed {
            circle_id: object::uid_to_inner(&circle.id),
            automation_type: string::utf8(automation_type),
            error_code,
            error_message: string::utf8(error_message),
            failed_at: clock::timestamp_ms(clock),
            retry_count,
        });
    }

    public fun emit_payout_warning(circle: &Circle, warning_level: u8, clock: &Clock) {
        let current_time = clock::timestamp_ms(clock);
        let time_remaining = get_time_until_payout(circle, clock);
        
        event::emit(PayoutWarning {
            circle_id: object::uid_to_inner(&circle.id),
            warning_level,
            time_remaining_ms: time_remaining,
            next_payout_time: circle.next_payout_time,
            current_time,
        });
    }

    // Note: Batch automation status queries will be handled in the automation service
    // Individual circle status is available via get_automation_status

    // Check if circle has valid rotation setup
    public fun has_valid_rotation(circle: &Circle): bool {
        let rotation_len = vector::length(&circle.rotation_order);
        rotation_len > 0 && circle.current_position < rotation_len
    }

    // ----------------------------------------------------------
    // Test-only helpers for sibling-module lifecycle tests
    // (njangi_cycle_escrow needs a real, active, shared Circle).
    // ----------------------------------------------------------

    /// Builds and shares a minimal ACTIVE circle: every address in
    /// `member_addrs` is an active member, in rotation order, with the
    /// first address as admin/position 0. Weekly cycle on weekday 0.
    /// Returns the shared circle's ID.
    #[test_only]
    public fun share_circle_for_testing(
        member_addrs: vector<address>,
        contribution_amount: u64,
        contribution_amount_usd: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): ID {
        let current_time = clock::timestamp_ms(clock);
        let member_count = vector::length(&member_addrs);
        assert!(member_count >= 1, 9300);
        let admin = *vector::borrow(&member_addrs, 0);

        let mut circle = Circle {
            id: object::new(ctx),
            name: string::utf8(b"test-circle"),
            admin,
            current_members: 0,
            members: table::new(ctx),
            contributions: balance::zero<SUI>(),
            deposits: balance::zero<SUI>(),
            penalties: balance::zero<SUI>(),
            current_cycle: 1,
            next_payout_time: current_time + SEVEN_DAYS_MS,
            created_at: current_time,
            rotation_order: vector::empty(),
            rotation_history: vector::empty(),
            current_position: 0,
            active_auction: option::none(),
            is_active: true,
            contributions_this_cycle: 0,
            paused_after_cycle: false,
        };

        let circle_config = config::create_circle_config(
            contribution_amount,
            contribution_amount / 2,        // security_deposit
            string::utf8(b"USD"),
            contribution_amount,            // contribution_amount_local
            contribution_amount / 2,        // security_deposit_local
            contribution_amount_usd,
            contribution_amount_usd / 2,
            0,                              // cycle_length: weekly
            0,                              // cycle_day: weekday 0
            0,                              // circle_type
            0,                              // rotation_style
            member_count,                   // max_members
            false,                          // auto_swap_enabled
            false,                          // auto_release_enabled
            0,                              // auto_release_delay_ms
            option::none(),                 // next_in_command
            clock
        );
        config::attach_circle_config(&mut circle.id, circle_config);
        config::attach_milestone_config(&mut circle.id, config::create_milestone_config(
            option::none(), option::none(), option::none(), option::none(), false
        ));
        config::attach_penalty_rules(&mut circle.id, config::create_penalty_rules(
            vector[false, false]
        ));

        let mut i = 0;
        while (i < member_count) {
            let addr = *vector::borrow(&member_addrs, i);
            let member = members::create_member(
                current_time,
                option::some(i),
                0,
                core::member_status_active()
            );
            add_member(&mut circle, addr, member);
            vector::push_back(&mut circle.rotation_order, addr);
            i = i + 1;
        };

        let circle_id = object::uid_to_inner(&circle.id);
        transfer::share_object(circle);
        circle_id
    }

    /// Flips a test circle into the executed-recovery state (STOPPED),
    /// mirroring what execute_recovery_internal does to circle state.
    #[test_only]
    public fun mark_recovery_stopped_for_testing(circle: &mut Circle, clock: &Clock) {
        config::mark_recovery_stopped(&mut circle.id, clock);
        circle.is_active = false;
    }

    // ----------------------------------------------------------
    // Circle-level compliance requirement tests
    // ----------------------------------------------------------

    #[test]
    fun test_requires_attestation_defaults_false_and_admin_can_enable() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        assert!(!requires_attestation(&circle), 9400);
        set_requires_attestation(&mut circle, true, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(requires_attestation(&circle), 9401);
        sui::test_scenario::return_shared(circle);

        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECannotDisableAttestationRequirement)]
    fun test_requires_attestation_cannot_be_disabled_after_members_join() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        set_requires_attestation(&mut circle, true, &clock, sui::test_scenario::ctx(&mut scenario));
        // Members already joined: switching the promise off must abort.
        set_requires_attestation(&mut circle, false, &clock, sui::test_scenario::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_requires_attestation_can_be_disabled_while_admin_is_sole_member() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        set_requires_attestation(&mut circle, true, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(requires_attestation(&circle), 9410);
        // Nobody else has joined yet, so the admin may still back out.
        set_requires_attestation(&mut circle, false, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(!requires_attestation(&circle), 9411);
        sui::test_scenario::return_shared(circle);

        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotAdmin)]
    fun test_requires_attestation_non_admin_cannot_set() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, @0xB);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        set_requires_attestation(&mut circle, true, &clock, sui::test_scenario::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_sui_usd_conversion_round_trip() {
        let one_sui_mist = 1_000_000_000;
        let price_usd_cents = 250; // $2.50

        let usd_cents = sui_amount_to_usd_cents(one_sui_mist, price_usd_cents);
        assert!(usd_cents == 250, 9001);

        let sui_back = usd_cents_to_sui_amount(usd_cents, price_usd_cents);
        assert!(sui_back == one_sui_mist, 9002);
    }

    #[test]
    fun test_conversion_is_conservative_across_prices() {
        let one_sui_mist = 1_000_000_000;
        let prices = vector[50, 100, 250, 500, 1000]; // $0.50 .. $10.00

        let mut i = 0;
        let len = vector::length(&prices);
        while (i < len) {
            let price = *vector::borrow(&prices, i);
            let usd_cents = sui_amount_to_usd_cents(one_sui_mist, price);
            let sui_back = usd_cents_to_sui_amount(usd_cents, price);

            // Integer division can round down; never allow round-up inflation.
            assert!(sui_back <= one_sui_mist, 9003);
            i = i + 1;
        };
    }

    #[test]
    fun test_cycle_schedule_validation_rules() {
        // Weekly / bi-weekly use weekday [0..6]
        assert!(is_valid_cycle_schedule(0, 0), 9004);
        assert!(is_valid_cycle_schedule(0, 6), 9005);
        assert!(!is_valid_cycle_schedule(0, 7), 9006);
        assert!(is_valid_cycle_schedule(3, 2), 9007);
        assert!(!is_valid_cycle_schedule(3, 8), 9008);

        // Monthly / quarterly use day-of-month [1..28]
        assert!(is_valid_cycle_schedule(1, 1), 9009);
        assert!(is_valid_cycle_schedule(1, 28), 9010);
        assert!(!is_valid_cycle_schedule(1, 0), 9011);
        assert!(!is_valid_cycle_schedule(1, 29), 9012);

        assert!(is_valid_cycle_schedule(2, 15), 9013);
        assert!(!is_valid_cycle_schedule(2, 0), 9014);
        assert!(!is_valid_cycle_schedule(2, 30), 9015);
    }

    #[test]
    fun test_expected_cycle_contributions_usd() {
        // Recipient contributes nothing to their own payout cycle.
        assert!(expected_cycle_contributions_usd(2_000, 5, true) == 8_000, 9016);
        assert!(expected_cycle_contributions_usd(2_000, 5, false) == 10_000, 9017);
        assert!(expected_cycle_contributions_usd(2_000, 0, false) == 0, 9018);
    }

    #[test]
    fun test_derive_native_display_amounts_from_usd() {
        // At $2.50/SUI: $2.50 => 1 SUI, $5.00 => 2 SUI.
        let (contribution_native, security_deposit_native) = derive_native_display_amounts(250, 500, 250);
        assert!(contribution_native == 1_000_000_000, 9019);
        assert!(security_deposit_native == 2_000_000_000, 9020);
    }

    #[test]
    fun test_extreme_price_change_threshold() {
        // Exactly 50% is allowed; >50% is blocked.
        assert!(!is_extreme_price_change(200, 300), 9021); // +50%
        assert!(is_extreme_price_change(200, 301), 9022); // +50.5%
        assert!(is_extreme_price_change(200, 99), 9023); // -50.5%
    }

    #[test]
    fun test_choose_effective_price_fallback_paths() {
        let last_valid = option::some(250);

        // Stale price should fallback to cached value.
        let (stale_price, stale_used_fallback, stale_reason) = choose_effective_sui_price(
            260,
            ORACLE_MAX_STALE_SECONDS + 1,
            last_valid
        );
        assert!(stale_price == 250, 9024);
        assert!(stale_used_fallback, 9025);
        assert!(stale_reason == PRICE_FALLBACK_STALE, 9026);

        // Extreme volatility should fallback to cached value.
        let (vol_price, vol_used_fallback, vol_reason) = choose_effective_sui_price(
            400,
            5,
            option::some(250)
        );
        assert!(vol_price == 250, 9027);
        assert!(vol_used_fallback, 9028);
        assert!(vol_reason == PRICE_FALLBACK_VOLATILITY, 9029);

        // Fresh, non-extreme candidate should be accepted.
        let (fresh_price, fresh_used_fallback, fresh_reason) = choose_effective_sui_price(
            320,
            5,
            option::some(250)
        );
        assert!(fresh_price == 320, 9030);
        assert!(!fresh_used_fallback, 9031);
        assert!(fresh_reason == PRICE_FALLBACK_NONE, 9032);
    }

    #[test]
    fun test_recovery_majority_threshold_rules() {
        assert!(recovery_majority_threshold(0) == 0, 9033);
        assert!(recovery_majority_threshold(1) == 1, 9034);
        assert!(recovery_majority_threshold(2) == 2, 9035);
        assert!(recovery_majority_threshold(3) == 2, 9036);
        assert!(recovery_majority_threshold(4) == 3, 9037);
        assert!(recovery_majority_threshold(5) == 3, 9038);
    }

    #[test]
    fun test_auto_release_member_fallback_excludes_admin() {
        assert!(!can_active_member_trigger_auto_release_internal(true, true), 9039);
        assert!(!can_active_member_trigger_auto_release_internal(false, false), 9040);
        assert!(can_active_member_trigger_auto_release_internal(false, true), 9041);
    }

    #[test]
    fun test_auto_release_delegate_priority_and_member_fallback_matrix() {
        assert!(can_trigger_auto_release_internal(true, true, true, false), 9042);
        assert!(!can_trigger_auto_release_internal(true, false, true, false), 9043);
        assert!(!can_trigger_auto_release_internal(true, false, false, false), 9044);
        assert!(can_trigger_auto_release_internal(true, false, true, true), 9045);
        assert!(can_trigger_auto_release_internal(false, false, true, true), 9046);
        assert!(!can_trigger_auto_release_internal(false, false, false, true), 9047);
    }

    #[test]
    fun test_auto_release_trigger_role_annotation_constants() {
        assert!(
            resolve_auto_release_trigger_role_internal(true, true, false, false)
                == RECOVERY_TRIGGER_ROLE_DELEGATE,
            9048
        );
        assert!(
            resolve_auto_release_trigger_role_internal(false, false, true, true)
                == RECOVERY_TRIGGER_ROLE_MEMBER_FALLBACK,
            9049
        );
        assert!(
            resolve_auto_release_trigger_role_internal(true, true, true, true)
                == RECOVERY_TRIGGER_ROLE_MEMBER_FALLBACK,
            9050
        );
        assert!(RECOVERY_TRIGGER_ROLE_VOTE_EXECUTION == 0, 9051);
    }

    #[test]
    fun test_delegate_invalidation_reopens_member_fallback_authority() {
        // When a valid delegate exists, fallback members are blocked.
        assert!(!can_trigger_auto_release_internal(true, false, true, false), 9052);

        // Once the delegate is invalidated and removed from the effective auth set,
        // the same eligible member can trigger via fallback authority.
        assert!(can_trigger_auto_release_internal(false, false, true, false), 9053);

        // No delegate and no eligible member still means no caller is authorized.
        assert!(!can_trigger_auto_release_internal(false, false, false, false), 9054);
    }

    #[test]
    fun test_delegate_grace_window_reopens_member_fallback_after_timeout() {
        let trigger_time = 1_000;

        assert!(!is_auto_release_member_fallback_open_internal(true, trigger_time, trigger_time), 9055);
        assert!(
            !is_auto_release_member_fallback_open_internal(
                true,
                trigger_time,
                trigger_time + AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS - 1
            ),
            9056
        );
        assert!(
            is_auto_release_member_fallback_open_internal(
                true,
                trigger_time,
                trigger_time + AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS
            ),
            9057
        );
        assert!(is_auto_release_member_fallback_open_internal(false, trigger_time, trigger_time), 9058);
    }

    #[test]
    fun test_membership_receipt_issue_and_burn() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);

        // Mint a soulbound membership receipt to the admin.
        let ctx = sui::test_scenario::ctx(&mut scenario);
        let uid = object::new(ctx);
        let circle_id = object::uid_to_inner(&uid);
        issue_membership(circle_id, admin, 1000, ctx);
        object::delete(uid);

        // It must now be owned by the member, carry the right fields, and be
        // burnable by the holder.
        sui::test_scenario::next_tx(&mut scenario, admin);
        let receipt = sui::test_scenario::take_from_sender<CircleMembership>(&scenario);
        assert!(receipt.member == admin, 9100);
        assert!(receipt.joined_at == 1000, 9101);
        assert!(receipt.circle_id == circle_id, 9102);
        burn_membership(receipt);

        sui::test_scenario::end(scenario);
    }
}
