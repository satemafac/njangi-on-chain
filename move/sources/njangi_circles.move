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
    use njangi::njangi_compliance::ComplianceConfig;
    #[test_only] use njangi::njangi_compliance::{Self as compliance};

    use pyth::price_info::PriceInfoObject;
    use njangi::njangi_price_validator as price_validator;
    
    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    const ECircleFull: u64 = 5;
    const EInsufficientDeposit: u64 = 6;
    const ENotAdmin: u64 = 7;
    const EWalletCircleMismatch: u64 = 46;
    const ECircleIsActive: u64 = 55;
    const EInvalidMaxMembersLimit: u64 = 56;
    const ECircleNotPausedForConfigChange: u64 = 58;
    // Define constants locally based on values from other modules
    const EInvalidContributionAmount: u64 = 1; // From core
    const ENotMember: u64 = 8;                 // From core
    const EMemberNotActive: u64 = 14;          // From members
    const EIncorrectDepositAmount: u64 = 2;    // From core
    const ENoRecoveryEligibleVoters: u64 = 62;
    const ERecoveryVoteNotEligible: u64 = 63;
    const ERecoveryVoteAlreadyCast: u64 = 64;
    const ERecoveryProposalExpired: u64 = 65;
    const ERecoveryVotingClosed: u64 = 66;
    const ERecoveryProposalMissing: u64 = 67;
    const ERecoveryExecutionNotReady: u64 = 68;
    const EInvalidRecoveryDelegate: u64 = 71;
    const ERecoveryDelegateUpdateLocked: u64 = 72;
    const ERecoveryAutoReleaseUnauthorized: u64 = 73;
    // 74 belonged to the legacy custody contribution rail (retired in v11).
    // Compliance gate: once members beyond the admin have joined a circle
    // that requires attestations, the requirement can never be switched
    // off (bait-and-switch guard — members joined under the KYC promise).
    const ECannotDisableAttestationRequirement: u64 = 75;

    // Mid-cycle migration (see `njangi_circle_config::MigrationLedger`).
    const EMigrationLedgerMissing: u64 = 76;
    const EMigrationLedgerChanged: u64 = 77;
    const EMigrationAlreadyAcknowledged: u64 = 78;
    const EMigrationNotRatified: u64 = 79;
    const EIncompleteRotationOrder: u64 = 80;
    const ENothingToMigrate: u64 = 81;
    const EMigrationRotationChanged: u64 = 82;

    // v11: pinned asset terms, per-member deposit records, per-asset refunds.
    const E_POLICY_MISSING: u64 = 83;
    const E_ASSET_NOT_ALLOWED: u64 = 84;
    const E_POLICY_LOCKED: u64 = 85;
    const E_DEPOSIT_ALREADY_POSTED: u64 = 86;
    const E_CIRCLE_NOT_STOPPED: u64 = 87;
    const E_LEGACY_NOT_MIGRATABLE: u64 = 88;
    // Every entrypoint v11 retires aborts with this one code; the
    // replacement is named in each function's comment.
    const E_DEPRECATED_ENTRYPOINT: u64 = 89;
    const E_TERMS_INVALID: u64 = 90;
    const E_POLICY_EXISTS: u64 = 91;
    const E_CIRCLE_NOT_CONVERTED: u64 = 92;
    const E_CIRCLE_STOPPED: u64 = 93;

    // MemberDepositKey.kind values. Only security deposits are recorded
    // today; a new kind is a new key value, never a new struct field.
    const DEPOSIT_KIND_SECURITY: u8 = 0;

    // Time constants (in milliseconds)
    const THIRTY_DAYS_MS: u64 = 2_592_000_000; // 30 days in milliseconds
    const SEVEN_DAYS_MS: u64 = 604_800_000;    // 7 days in milliseconds
    const EMERGENCY_STOP_VOTING_WINDOW_MS: u64 = SEVEN_DAYS_MS;
    const AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS: u64 = 86_400_000; // 24 hours

    const RECOVERY_TRIGGER_ROLE_VOTE_EXECUTION: u8 = 0;
    const RECOVERY_TRIGGER_ROLE_DELEGATE: u8 = 1;
    const RECOVERY_TRIGGER_ROLE_MEMBER_FALLBACK: u8 = 2;

    // Oracle safety constants.

    // Dynamic-field keys for cached oracle fallback price.

    // Dynamic-field key recording which members contributed in the current
    // payout round (legacy custody path de-duplication). Stored as a
    // dynamic field so the Circle struct layout is unchanged; cleared at
    // every site that resets `contributions_this_cycle` so the record and
    // the counter always move in lockstep.
    const FIELD_CYCLE_CONTRIBUTORS: vector<u8> = b"cycle_contributors";
    // Append-only index of every CycleEscrow this circle has opened via the
    // *_indexed open paths (Circle Record v1.1). Exists so past escrows are
    // enumerable by OBJECT READ — before this, the only route was a
    // queryEvents scan, which the read policy forbids and current RPC
    // endpoints serve unreliably. Lives as a dynamic field because Sui
    // upgrades cannot add struct fields to Circle.
    const FIELD_ESCROW_HISTORY: vector<u8> = b"escrow_history";
    // The round the circle currently has an escrow open for, as written by
    // the *_indexed escrow opens and read back by the escrow module's
    // duplicate-open guard (Circle Record v1.2). Absent == no marker, which
    // for circles that predate it or only used the un-indexed opens means
    // "no data", never "no round open". Dynamic field for the same reason
    // as escrow_history: an upgrade cannot add a struct field to Circle.
    const FIELD_OPEN_ROUND: vector<u8> = b"open_round";

    // Dynamic-field key for the circle-level compliance requirement.
    // Stored as a dynamic field (absent == false) so the Circle struct
    // layout is unchanged and pre-existing circles default to ungated.
    const FIELD_REQUIRES_ATTESTATION: vector<u8> = b"requires_attestation";

    // Dynamic-field key for the object id of the ComplianceConfig the
    // admin pinned when enabling the requirement (June 2026
    // adversarial-review repair). The escrow gate only accepts THIS
    // exact config object, so a member cannot substitute a stale or
    // fabricated config in their own PTB. Present iff
    // FIELD_REQUIRES_ATTESTATION is true.
    const FIELD_COMPLIANCE_CONFIG_ID: vector<u8> = b"compliance_config_id";
    
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
    /// `pinned_config_id` is the ComplianceConfig object the circle's
    /// escrow gates will accept (some iff `required`).
    public struct CircleAttestationRequirementChanged has copy, drop {
        circle_id: ID,
        required: bool,
        pinned_config_id: Option<ID>,
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

    // Member Deposits Reset Event - RETIRED 2026-09. resume_cycle no longer
    // clears deposit status: security deposits persist across laps (see
    // reconcile_deposit_paid for the history). The struct stays because a
    // compatible upgrade cannot remove a published type; nothing emits it.
    #[allow(unused_field)]
    public struct MemberDepositsReset has copy, drop {
        circle_id: ID,
        admin: address,
        cycle: u64,
        timestamp: u64,
    }

    // Deposit Paid Reconciled Event - Emitted by reconcile_deposit_paid when a
    // member's still-held deposit has its `deposit_paid` flag restored. No
    // funds move.
    public struct DepositPaidReconciled has copy, drop {
        circle_id: ID,
        member: address,
        deposit_balance: u64,
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
    // Mid-cycle migration events
    // ----------------------------------------------------------
    public struct MigrationStateDeclared has copy, drop {
        circle_id: ID,
        declared_by: address,
        version: u64,
        prior_rounds_completed: u64,
        start_position: u64,
        next_recipient: address,
        rotation_length: u64,
        timestamp: u64,
    }

    public struct MigrationStateAcknowledged has copy, drop {
        circle_id: ID,
        member: address,
        version: u64,
        acks: u64,
        rotation_length: u64,
        timestamp: u64,
    }

    public struct MigrationStateCleared has copy, drop {
        circle_id: ID,
        cleared_by: address,
        timestamp: u64,
    }

    public struct CircleMigrationActivated has copy, drop {
        circle_id: ID,
        start_position: u64,
        prior_rounds_completed: u64,
        starting_cycle: u64,
        ratified_by: u64,
        already_collected: vector<address>,
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
    // v11 — pinned asset terms, per-member deposit records, per-asset
    // refunds
    //
    // Every v11 fact is a dynamic field on the circle's UID under a key type
    // introduced in v11 (struct layouts cannot change in an upgrade, and no
    // earlier package version can construct these keys):
    //
    //   AssetPolicyKey            -> CircleAssetPolicy  (the pinned terms,
    //                                      the bound custody wallet, and the
    //                                      ledger entries the conversion
    //                                      covered — 0 for circles created
    //                                      on v11)
    //   MemberDepositKey{member,asset,kind} -> u64 (the member's deposit
    //                                      recorded in the custody wallet)
    //   DepositorsKey{asset}      -> vector<address> (append-only)
    //   DepositMarkerKey{member}  -> vector<u8> (asset the deposit is in)
    //   RefundRecordKey{asset}    -> u64  (last completed refund run, ms)
    //
    // The coins themselves sit in the circle's custody wallet as typed
    // deposit records (njangi_custody::DepositBalanceKey), moved only by the
    // contract rules below.
    //
    // A circle is CONVERTED once its policy exists — at creation for
    // circles created with `create_circle_with_asset`, or by
    // `adopt_asset_policy` for circles created earlier.
    //
    // Custody posture (invariant, enforced by construction and by tests):
    // a member's deposit leaves the custody wallet only as a refund of that
    // member's own recorded amount, to that member — when the circle is
    // stopped by its members' vote or auto-release rule, when the member is
    // removed from an inactive circle, or when the member, no longer in the
    // circle, collects it. No admin, operator, registry admin, AttestorCap
    // or UpgradeCap holder can choose an amount or a destination. The
    // AssetRegistry decides which coins a circle may take on; it never
    // touches balances. Round money stays in the per-round CycleEscrow,
    // whose exits are unchanged: the round recipient's payout and refunds
    // to the recorded contributors.
    // ----------------------------------------------------------
    public struct AssetPolicyKey has copy, drop, store {}
    public struct MemberDepositKey has copy, drop, store { member: address, asset: vector<u8>, kind: u8 }
    public struct DepositorsKey has copy, drop, store { asset: vector<u8> }
    public struct DepositMarkerKey has copy, drop, store { member: address }
    public struct RefundRecordKey has copy, drop, store { asset: vector<u8> }

    /// Native terms of one asset, in that asset's base units.
    public struct AssetTerms has store, copy, drop {
        asset: vector<u8>,
        decimals: u8,
        contribution_amount: u64,
        security_deposit: u64,
    }

    /// A circle's asset terms, fixed for the life of the circle.
    /// `settlement_asset` is the coin rounds are paid in; `assets` lists
    /// every asset the circle accepts (today: exactly the settlement asset,
    /// which is also the asset its security deposits are paid in).
    public struct CircleAssetPolicy has store, copy, drop {
        settlement_asset: vector<u8>,
        assets: vector<AssetTerms>,
        set_at_ms: u64,
        // The custody wallet every v11 money path of this circle must be
        // given (bound once, here).
        wallet_id: ID,
        // Wallet ledger entries the conversion covered (0 for circles created
        // on v11); entries appended later describe legacy storage only.
        legacy_ledger_entries: u64,
    }

    /// Terms pinned — at creation, or by converting a pre-v11 circle, in
    /// which case `migrated_members` deposits totalling `migrated_total`
    /// moved from legacy storage into the v11 records of the same wallet.
    public struct CircleAssetPolicySet has copy, drop {
        circle_id: ID,
        wallet_id: ID,
        settlement_asset: String,
        decimals: u8,
        contribution_amount: u64,
        security_deposit: u64,
        converted_from_legacy: bool,
        migrated_members: u64,
        migrated_total: u64,
        legacy_ledger_entries: u64,
        set_at_ms: u64,
    }

    public struct SecurityDepositPosted has copy, drop {
        circle_id: ID,
        member: address,
        coin_type: String,
        decimals: u8,
        amount: u64,
    }

    public struct AssetRefundCompleted has copy, drop {
        circle_id: ID,
        coin_type: String,
        total_amount: u64,
        members: u64,
        timestamp: u64,
    }

    // ----------------------------------------------------------
    // Create Circle
    //
    // RETIRED in v11: every new circle pins its asset terms at creation
    // (`create_circle_with_asset<T>`), so no circle is ever created without
    // a settlement asset. The signature stays because an upgrade cannot
    // change or remove a public function.
    // ----------------------------------------------------------
    public fun create_circle(
        _name: vector<u8>,
        _contribution_amount: u64,
        _currency_type: vector<u8>,
        _contribution_amount_local: u64,
        _contribution_amount_usd: u64,
        _security_deposit: u64,
        _security_deposit_local: u64,
        _security_deposit_usd: u64,
        _cycle_length: u64,
        _cycle_day: u64,
        _circle_type: u8,
        _max_members: u64,
        _rotation_style: u8,
        _penalty_rules: vector<bool>,
        _goal_type: Option<u8>,
        _target_amount: Option<u64>,
        _target_amount_local: Option<u64>,
        _target_date: Option<u64>,
        _verification_required: bool,
        _auto_release_enabled: bool,
        _auto_release_delay_ms: u64,
        _next_in_command: Option<address>,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // ----------------------------------------------------------
    // Create a circle that settles in coin `T` (v11)
    //
    // `T` must be a canonical-registry asset with the settlement role; its
    // decimals are read from the registry, never from the caller. The
    // native amounts are `T` base units and are pinned for the life of the
    // circle (`CircleAssetPolicy`). For a USD-pegged `T` they must equal
    // the USD cents at the peg (`cents * 10^(decimals - 2)`), so the USD
    // fields stay truthful. The circle's custody wallet is created and
    // bound in the same call.
    // ----------------------------------------------------------
    public fun create_circle_with_asset<T>(
        name: vector<u8>,
        currency_type: vector<u8>,        // Fiat display code (e.g., "USD", "XAF", "NGN")
        contribution_amount_local: u64,
        contribution_amount_usd: u64,     // cents
        security_deposit_local: u64,
        security_deposit_usd: u64,        // cents
        contribution_native: u64,         // T base units per contribution
        deposit_native: u64,              // T base units per security deposit
        cycle_length: u64,
        cycle_day: u64,
        circle_type: u8,
        max_members: u64,
        rotation_style: u8,
        penalty_rules: vector<bool>,
        goal_type: Option<u8>,
        target_amount: Option<u64>,
        target_amount_local: Option<u64>,
        target_date: Option<u64>,
        verification_required: bool,
        auto_release_enabled: bool,
        auto_release_delay_ms: u64,
        next_in_command: Option<address>,
        registry: &price_validator::AssetRegistry,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let decimals = price_validator::assert_usable<T>(registry, price_validator::flag_settlement());
        let asset = core::coin_type_bytes<T>();
        let settles_in_sui = core::is_sui<T>();

        // Same schedule / size / USD validations as the legacy create path.
        assert!(max_members >= core::get_min_members() && max_members <= core::get_max_members(), 0);
        assert!(contribution_amount_usd > 0, 1);
        assert!(security_deposit_usd >= core::min_security_deposit(contribution_amount_usd), 2);
        assert!(cycle_length <= 3, 3); // Allow up to 3 (bi-weekly)
        assert!(is_valid_cycle_schedule(cycle_length, cycle_day), 4); // EInvalidCycleDay

        // Native terms.
        assert!(contribution_native > 0, E_TERMS_INVALID);
        assert!(
            deposit_native > 0 && deposit_native >= core::min_security_deposit(contribution_native),
            E_TERMS_INVALID
        );
        if (price_validator::is_usd_pegged<T>(registry)) {
            assert!(
                contribution_native == core::usd_cents_to_pegged_units(contribution_amount_usd, decimals),
                E_TERMS_INVALID
            );
            assert!(
                deposit_native == core::usd_cents_to_pegged_units(security_deposit_usd, decimals),
                E_TERMS_INVALID
            );
        };

        let admin = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        if (option::is_some(&next_in_command)) {
            assert!(*option::borrow(&next_in_command) != admin, EInvalidRecoveryDelegate);
        };

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
            next_payout_time: core::calculate_next_payout_time(cycle_length, cycle_day, current_time),
            created_at: current_time,
            rotation_order: vector::empty(),
            rotation_history: vector::empty(),
            current_position: 0,
            active_auction: option::none(),
            is_active: false,
            contributions_this_cycle: 0,
            paused_after_cycle: false,
        };

        // The config's native fields are SUI-mist fields. A SUI circle stores
        // its pinned terms there, so every config reader agrees with the
        // policy; any other asset keeps its terms in the policy only and the
        // SUI fields stay zero. `auto_swap_enabled` mirrors the settlement
        // asset for readers that predate the policy.
        let (config_contribution, config_deposit) = if (settles_in_sui) {
            (contribution_native, deposit_native)
        } else {
            (0, 0)
        };
        let circle_config = config::create_circle_config(
            config_contribution,
            config_deposit,
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
            settles_in_sui,
            auto_release_enabled,
            auto_release_delay_ms,
            if (auto_release_enabled) { next_in_command } else { option::none() },
            clock
        );
        config::attach_circle_config(&mut circle.id, circle_config);
        config::attach_milestone_config(&mut circle.id, config::create_milestone_config(
            goal_type,
            target_amount,
            target_amount_local,
            target_date,
            verification_required
        ));
        config::attach_penalty_rules(&mut circle.id, config::create_penalty_rules(penalty_rules));

        // Custody wallet: created with T's legacy slot already migrated, its
        // id recorded both where existing readers look (`wallet_id`) and in
        // the v11 binding that every v11 money path checks.
        let circle_id = object::uid_to_inner(&circle.id);
        let wallet_id = custody::create_custody_wallet_for_asset<T>(circle_id, current_time, ctx);
        dynamic_field::add(&mut circle.id, string::utf8(b"wallet_id"), wallet_id);

        let terms = AssetTerms {
            asset,
            decimals,
            contribution_amount: contribution_native,
            security_deposit: deposit_native,
        };
        pin_asset_policy(&mut circle, terms, wallet_id, 0, current_time);

        // Admin joins at rotation position 0, as on the legacy path.
        let admin_member = members::create_member(
            current_time,
            option::some(0),
            0,
            core::member_status_active()
        );
        add_member(&mut circle, admin, admin_member);
        vector::push_back(&mut circle.rotation_order, admin);

        event::emit(CircleCreated {
            circle_id,
            admin,
            name: string::utf8(name),
            contribution_amount: contribution_native,
            currency_type: string::utf8(currency_type),
            contribution_amount_local,
            security_deposit_local,
            max_members,
            cycle_length,
        });
        event::emit(MemberJoined {
            circle_id,
            member: admin,
            position: option::some(0),
            member_status: core::member_status_active(),
            currency_type: string::utf8(currency_type),
            contribution_amount_local,
            security_deposit_local,
            deposit_paid: false,
            joined_at: current_time,
        });
        event::emit(CircleAssetPolicySet {
            circle_id,
            wallet_id,
            settlement_asset: string::utf8(asset),
            decimals,
            contribution_amount: contribution_native,
            security_deposit: deposit_native,
            converted_from_legacy: false,
            migrated_members: 0,
            migrated_total: 0,
            legacy_ledger_entries: 0,
            set_at_ms: current_time,
        });

        issue_membership(circle_id, admin, current_time, ctx);
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

        // Activation is once-only. Without this the call re-stamps
        // next_payout_time and current_cycle on a running circle, and it would
        // let a migration ledger be re-applied mid-round, moving
        // current_position after members had already contributed.
        assert!(!circle.is_active, ECircleIsActive);
        
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

        // v11: on a circle with pinned asset terms, every seat (and the
        // admin) must also have a security deposit recorded in the circle's
        // v11 deposit records. The flag alone is not enough there: only a
        // recorded deposit counts.
        if (has_asset_policy(circle)) {
            if (table::contains(&circle.members, circle.admin)) {
                assert!(deposit_held(circle, circle.admin) > 0, 21);
            };
            let mut j = 0;
            while (j < len) {
                let seat = *vector::borrow(&circle.rotation_order, j);
                if (seat != @0x0) {
                    assert!(deposit_held(circle, seat) > 0, 21);
                };
                j = j + 1;
            };
        };

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
        
        // Start cycle. A group that migrated mid-rotation resumes at the
        // position its members ratified and continues its own round
        // numbering, instead of restarting the rotation from the top.
        if (config::has_migration_ledger(&circle.id)) {
            apply_migration_ledger(circle, clock);
        } else {
            circle.current_cycle = 1;
        };
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

        // v11: the settlement asset is pinned; the flag may only restate it.
        if (has_asset_policy(circle)) {
            let settles_in_sui = policy_ref(circle).settlement_asset == core::coin_type_bytes<SUI>();
            assert!(enabled == settles_in_sui, E_POLICY_LOCKED);
        };

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
    // truth: njangi_cycle_escrow reads it at open time (together with
    // the pinned ComplianceConfig id, see FIELD_COMPLIANCE_CONFIG_ID)
    // and forces every
    // escrow of a gated circle onto the attestation-checked paths. The
    // legacy custody rail (contribute_stablecoin here;
    // njangi_payments::contribute / trigger_payout / claim_payout) is
    // retired in v11 for every circle. Security deposits and all
    // refund/recovery paths stay ungated — they only return a member's
    // own funds, so no funds can ever be stranded behind the gate.
    // ----------------------------------------------------------

    /// Sets whether this circle requires a valid compliance attestation
    /// to contribute to / collect from its money paths (per-cycle escrows
    /// become attestation-checked; the legacy custody rail is blocked
    /// entirely). Admin only.
    ///
    /// When enabling, the admin must present the `ComplianceConfig` the
    /// gate should trust; its object id is pinned on the circle and the
    /// escrow gate accepts ONLY that exact config object (June 2026
    /// adversarial-review repair — without the pin, a member could
    /// supply any config in their own PTB, e.g. a stale one whose
    /// `expected_issuer` they control). Creation of ComplianceConfig
    /// objects is itself bound to the package publisher's UpgradeCap
    /// (`njangi_compliance::assert_canonical_upgrade_cap`), so the pin
    /// always names a publisher-rooted config. Re-enabling overwrites
    /// the pin (admin-controlled re-pin, e.g. after an operator config
    /// rotation); newly opened escrows pick up the new pin, already-open
    /// escrows keep the pin they were opened with.
    ///
    /// Enabling is always allowed (it only tightens the rules; escrows
    /// already open keep the gate state they were opened with). Disabling
    /// is only allowed while the admin is the sole member: once anyone
    /// else has joined under the KYC promise, the requirement is
    /// permanent (bait-and-switch guard).
    public fun set_requires_attestation(
        circle: &mut Circle,
        compliance_config: &ComplianceConfig,
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

        // Keep the pin in lockstep with the flag: present iff required.
        let pinned_config_id = if (required) {
            let config_id = object::id(compliance_config);
            if (dynamic_field::exists_(&circle.id, FIELD_COMPLIANCE_CONFIG_ID)) {
                *dynamic_field::borrow_mut<vector<u8>, ID>(
                    &mut circle.id,
                    FIELD_COMPLIANCE_CONFIG_ID
                ) = config_id;
            } else {
                dynamic_field::add(&mut circle.id, FIELD_COMPLIANCE_CONFIG_ID, config_id);
            };
            option::some(config_id)
        } else {
            if (dynamic_field::exists_(&circle.id, FIELD_COMPLIANCE_CONFIG_ID)) {
                dynamic_field::remove<vector<u8>, ID>(
                    &mut circle.id,
                    FIELD_COMPLIANCE_CONFIG_ID
                );
            };
            option::none()
        };
        touch_admin_heartbeat(circle, clock);

        event::emit(CircleAttestationRequirementChanged {
            circle_id: object::uid_to_inner(&circle.id),
            required,
            pinned_config_id,
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

    /// Object id of the ComplianceConfig pinned by the admin when the
    /// attestation requirement was enabled — the ONLY config object the
    /// circle's escrow gates accept. `some` iff `requires_attestation`.
    public fun pinned_compliance_config_id(circle: &Circle): Option<ID> {
        if (dynamic_field::exists_(&circle.id, FIELD_COMPLIANCE_CONFIG_ID)) {
            option::some(
                *dynamic_field::borrow<vector<u8>, ID>(&circle.id, FIELD_COMPLIANCE_CONFIG_ID)
            )
        } else {
            option::none()
        }
    }

    // ----------------------------------------------------------
    // Circle SUI-balance report — RETIRED in v11 (the circle's own SUI
    // balances are vestigial; member deposits are v11 deposit records in the
    // custody wallet, readable without a transaction).
    // ----------------------------------------------------------
    public fun manage_treasury_balances(
        _circle: &mut Circle,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }
    
    // ----------------------------------------------------------
    // Manual cycle bump — RETIRED in v11. The lap number moves only through
    // resume_cycle (end of lap); a manual bump could leave the round pointer
    // and the lap number disagreeing.
    // ----------------------------------------------------------
    public fun update_cycle(
        _circle: &mut Circle,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
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

        // v11: the bound wallet, holding no member deposit.
        if (has_asset_policy(circle)) {
            if (!is_bound_wallet(circle, wallet) || any_member_deposit_held(circle)) {
                return false
            };
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

        // v11: a circle with pinned terms is deleted only against its bound
        // wallet and only once no member deposit is recorded.
        if (has_asset_policy(&circle)) {
            assert!(is_bound_wallet(&circle, wallet), EWalletCircleMismatch);
            assert!(!any_member_deposit_held(&circle), EInsufficientDeposit);
        };

        // Get the wallet_id link in the circle dynamic fields - we'll clean this up
        let wallet_id_key = string::utf8(b"wallet_id");
        if (dynamic_field::exists_(&circle.id, wallet_id_key)) {
            // If the wallet ID field exists, remove it to clean up
            let _: ID = dynamic_field::remove(&mut circle.id, wallet_id_key);
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

    // Rotation order determines WHO RECEIVES THE NEXT PAYOUT
    // (get_next_payout_recipient reads rotation_order[current_position]), so
    // it is locked while a cycle is running for the same reason token mode is:
    // an admin must not be able to redirect a payout mid-cycle. Changes are
    // allowed pre-activation or while paused between cycles, when no cycle is
    // in flight and members can see the new order before contributing.
    //
    // Without this an admin could move themselves into the current position
    // after members had already contributed — discretion over fund direction,
    // which compliance invariant #1 says no operator role may have.
    public fun set_rotation_position(
        circle: &mut Circle,
        member_addr: address,
        position: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circle.admin, 7);
        assert!(
            !circle.is_active || circle.paused_after_cycle,
            ECircleNotPausedForConfigChange
        );
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
        // Same lock as set_rotation_position — this replaces the whole order,
        // so it is the wider version of the same power.
        assert!(
            !circle.is_active || circle.paused_after_cycle,
            ECircleNotPausedForConfigChange
        );
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
    // Mid-cycle migration
    //
    // A njangi that ran offline for months is not at the top of its rotation:
    // some members have already collected, and the next turn belongs to
    // somebody in the middle of the order. These three calls let such a group
    // record where it actually stands, have every member confirm it, and then
    // activate there instead of restarting the rotation from position 0.
    //
    // Declaring "positions 0..k already collected" removes those members from
    // this round's payout queue, so it is fund direction, not bookkeeping.
    // Two things keep it inside compliance invariant #1: it is refused once
    // the circle is live (so no funded cycle can be redirected), and it does
    // nothing until every member in the rotation has ratified it.
    // ----------------------------------------------------------

    // Positions only mean something if every seat is filled. A @0x0 gap would
    // also make `get_next_payout_recipient` return none for that turn.
    fun assert_rotation_order_complete(circle: &Circle) {
        let rotation_len = vector::length(&circle.rotation_order);
        assert!(rotation_len == circle.current_members, EIncompleteRotationOrder);
        let mut i = 0;
        while (i < rotation_len) {
            assert!(
                *vector::borrow(&circle.rotation_order, i) != @0x0,
                EIncompleteRotationOrder
            );
            i = i + 1;
        };
    }

    public fun declare_migration_state(
        circle: &mut Circle,
        prior_rounds_completed: u64,
        start_position: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        // Stricter than the 58 lock the rotation setters use, which relaxes
        // while paused between cycles. This is a genesis declaration, never a
        // mid-flight edit, so forbidding it outright on a live circle costs
        // the feature nothing and removes the whole redirect question.
        assert!(!circle.is_active, ECircleIsActive);

        assert_rotation_order_complete(circle);

        let rotation_len = vector::length(&circle.rotation_order);
        assert!(start_position < rotation_len, 29); // EInvalidRotationPosition
        // A ledger that declares nothing is just an ordinary new circle.
        // Refuse to create one so the ratification gate never fires for a
        // group that has no history to record.
        assert!(start_position > 0 || prior_rounds_completed > 0, ENothingToMigrate);

        let next_recipient = *vector::borrow(&circle.rotation_order, start_position);

        config::begin_migration_ledger(
            &mut circle.id,
            sender,
            prior_rounds_completed,
            start_position,
            circle.rotation_order,
            clock
        );
        touch_admin_heartbeat(circle, clock);

        event::emit(MigrationStateDeclared {
            circle_id: object::uid_to_inner(&circle.id),
            declared_by: sender,
            version: config::get_migration_version(&circle.id),
            prior_rounds_completed,
            start_position,
            next_recipient,
            rotation_length: rotation_len,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    public fun acknowledge_migration_state(
        circle: &mut Circle,
        version: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(config::has_migration_ledger(&circle.id), EMigrationLedgerMissing);
        assert!(!circle.is_active, ECircleIsActive);
        // The caller states which version of the ledger they read. If the
        // admin rewrote it in the meantime this aborts, rather than recording
        // agreement to terms the member never saw.
        assert!(
            config::get_migration_version(&circle.id) == version,
            EMigrationLedgerChanged
        );
        assert!(vector::contains(&circle.rotation_order, &sender), ENotMember);
        assert!(
            !config::has_migration_ack_from(&circle.id, sender),
            EMigrationAlreadyAcknowledged
        );

        config::append_migration_ack(&mut circle.id, sender, clock);

        event::emit(MigrationStateAcknowledged {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            version,
            acks: config::get_migration_ack_count(&circle.id),
            rotation_length: vector::length(&circle.rotation_order),
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // Drops the declared history so a group can abandon the migration and
    // start a clean rotation instead.
    public fun clear_migration_state(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        assert!(!circle.is_active, ECircleIsActive);
        assert!(config::has_migration_ledger(&circle.id), EMigrationLedgerMissing);

        config::clear_migration_ledger(&mut circle.id);
        touch_admin_heartbeat(circle, clock);

        event::emit(MigrationStateCleared {
            circle_id: object::uid_to_inner(&circle.id),
            cleared_by: sender,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // Applies a ratified ledger. Only `activate_circle` calls this, and it
    // asserts `!is_active` first, so this runs at most once per circle and
    // can never move `current_position` while a cycle is funded.
    fun apply_migration_ledger(circle: &mut Circle, clock: &Clock) {
        // Unanimous. Without this an admin could write off another member's
        // turn on their own say-so, which is exactly the operator discretion
        // over fund direction that invariant #1 forbids.
        assert!(is_migration_ratified(circle), EMigrationNotRatified);

        // Members confirmed a position in a SPECIFIC order. Reordering the
        // rotation afterwards would hand that position to somebody else while
        // their confirmations still stood — the same redirect the rotation
        // lock prevents, just staged before activation instead of during a
        // cycle. Changing the order means declaring again and re-confirming.
        assert!(
            config::get_migration_rotation_snapshot(&circle.id) == circle.rotation_order,
            EMigrationRotationChanged
        );

        let start_position = config::get_migration_start_position(&circle.id);
        let prior_rounds = config::get_migration_prior_rounds_completed(&circle.id);
        let rotation_len = vector::length(&circle.rotation_order);
        assert!(start_position < rotation_len, 29);

        // Members who collected off-platform. The per-cycle escrow rail reads
        // only `current_position`, but the legacy rail checks this flag before
        // paying, and it is what the UI renders as "already collected".
        let mut already_collected = vector::empty<address>();
        let mut i = 0;
        while (i < start_position) {
            let member_addr = *vector::borrow(&circle.rotation_order, i);
            let member = table::borrow_mut(&mut circle.members, member_addr);
            members::set_received_payout(member, true);
            vector::push_back(&mut already_collected, member_addr);
            i = i + 1;
        };

        set_current_position(circle, start_position);
        // Continue the group's own round numbering rather than restarting at 1.
        circle.current_cycle = prior_rounds + 1;

        event::emit(CircleMigrationActivated {
            circle_id: object::uid_to_inner(&circle.id),
            start_position,
            prior_rounds_completed: prior_rounds,
            starting_cycle: circle.current_cycle,
            ratified_by: config::get_migration_ack_count(&circle.id),
            already_collected,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // ----------------------------------------------------------
    // Migration ledger getters
    // ----------------------------------------------------------
    public fun has_migration_ledger(circle: &Circle): bool {
        config::has_migration_ledger(&circle.id)
    }

    public fun get_migration_version(circle: &Circle): u64 {
        config::get_migration_version(&circle.id)
    }

    public fun get_migration_start_position(circle: &Circle): u64 {
        config::get_migration_start_position(&circle.id)
    }

    public fun get_migration_prior_rounds_completed(circle: &Circle): u64 {
        config::get_migration_prior_rounds_completed(&circle.id)
    }

    public fun get_migration_ack_count(circle: &Circle): u64 {
        config::get_migration_ack_count(&circle.id)
    }

    // False once the admin reorders the rotation, so the UI can ask for a
    // fresh declaration instead of letting activation abort.
    public fun migration_matches_rotation(circle: &Circle): bool {
        config::has_migration_ledger(&circle.id)
            && config::get_migration_rotation_snapshot(&circle.id) == circle.rotation_order
    }

    public fun has_migration_ack_from(circle: &Circle, member: address): bool {
        config::has_migration_ack_from(&circle.id, member)
    }

    // True only when every seat in the rotation has confirmed the ledger at
    // its CURRENT version — re-declaring resets this to false.
    public fun is_migration_ratified(circle: &Circle): bool {
        if (!config::has_migration_ledger(&circle.id)) {
            return false
        };

        let rotation_len = vector::length(&circle.rotation_order);
        if (rotation_len == 0) {
            return false
        };

        let mut i = 0;
        while (i < rotation_len) {
            let member_addr = *vector::borrow(&circle.rotation_order, i);
            if (!config::has_migration_ack_from(&circle.id, member_addr)) {
                return false
            };
            i = i + 1;
        };
        true
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
    
    // NOTE: `split_from_deposits` was removed in the June 2026 GTM audit
    // cleanup. Its only caller was the admin-pushed
    // `njangi_payments::process_security_deposit_return`, which violated
    // the no-admin-discretionary-fund-movement invariant and read from
    // `circle.deposits` — a balance the live deposit flow never funds
    // (security deposits are held in the CustodyWallet and returned via
    // the member-initiated recovery flow).

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

    // Position auctions — RETIRED in v11 (no bids enter a circle; see
    // njangi_payments::place_bid). The unauthenticated state writers below
    // keep their signatures and abort.
    public fun start_auction(
        _circle: &mut Circle,
        _position: u64,
        _minimum_bid: u64,
        _duration_days: u64,
        _discount_rate: u64,
        _start_time: u64
    ) {
        abort E_DEPRECATED_ENTRYPOINT
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

    public fun update_auction_bid(_circle: &mut Circle, _bid_amount: u64, _bidder: address) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun end_auction(_circle: &mut Circle) {
        abort E_DEPRECATED_ENTRYPOINT
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
    // Member exit — RETIRED in v11 (it could never complete: nothing can set
    // a member's exit request). Removal is admin_remove_member*.
    // ----------------------------------------------------------
    public fun process_member_exit(
        _circle: &mut Circle,
        _member_addr: address,
        _ctx: &mut TxContext
    ): bool {
        abort E_DEPRECATED_ENTRYPOINT
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

        // Same lock as the rotation setters. A member admitted mid-cycle gets
        // no payout_position and is not in rotation_order, so the funding gate
        // and any open escrow snapshot cannot see them — yet they can still
        // contribute on the legacy rail, and they cannot be given a position
        // until the circle pauses. Admitting them here creates that ghost.
        assert!(
            !circle.is_active || circle.paused_after_cycle,
            ECircleNotPausedForConfigChange
        );
        
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

        // See admin_approve_member for why this is locked while a cycle runs.
        assert!(
            !circle.is_active || circle.paused_after_cycle,
            ECircleNotPausedForConfigChange
        );
        
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
    //
    // v11: on a circle with pinned asset terms the deposit is a recorded
    // member deposit in coin `T`, which this non-generic entrypoint cannot
    // name. It removes the member and leaves the deposit recorded for them:
    // `admin_remove_member_asset<T>` removes AND returns it in one call, and
    // a removed member can always collect it with `claim_own_refund<T>`.
    // On a circle without pinned terms the legacy refund runs as before,
    // except that a deposit recorded as a stablecoin is never paid back in
    // SUI (convert the circle, then remove).
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

        if (has_asset_policy(circle)) {
            assert_bound_wallet(circle, wallet);
            remove_member_record(circle, member_addr);
            event::emit(MemberRemoved {
                circle_id: object::uid_to_inner(&circle.id),
                member: member_addr,
                removed_by: sender,
                deposit_returned: false,
                deposit_amount: 0,
                timestamp: clock::timestamp_ms(clock),
            });
            touch_admin_heartbeat(circle, clock);
            return
        };

        // A circle without pinned terms: a member holding a legacy deposit
        // is removed only after conversion, which moves that deposit into
        // the v11 records (refunded to them on removal); v11 never pays
        // from legacy storage.
        let member = table::borrow(&circle.members, member_addr);
        assert!(
            !(members::has_paid_deposit(member) && members::get_deposit_balance(member) > 0),
            E_CIRCLE_NOT_CONVERTED
        );
        remove_member_record(circle, member_addr);
        event::emit(MemberRemoved {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            removed_by: sender,
            deposit_returned: false,
            deposit_amount: 0,
            timestamp: clock::timestamp_ms(clock),
        });
        touch_admin_heartbeat(circle, clock);
    }

    /// v11: removes a member from an inactive circle with pinned asset terms
    /// and returns their recorded deposit in the coin it was paid in (`T`),
    /// to them, in the same call. The amount and the destination are the
    /// member's own record; the admin chooses neither. Aborts with
    /// E_ASSET_NOT_ALLOWED if the member's deposit is in another coin.
    public fun admin_remove_member_asset<T>(
        circle: &mut Circle,
        member_addr: address,
        wallet: &mut custody::CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == circle.admin, ENotAdmin);
        assert!(!circle.is_active, ECircleIsActive);
        assert!(is_member(circle, member_addr), ENotMember);
        assert_bound_wallet(circle, wallet);

        let asset = core::coin_type_bytes<T>();
        let marker = deposit_marker_of(circle, member_addr);
        if (option::is_some(&marker)) {
            assert!(*option::borrow(&marker) == asset, E_ASSET_NOT_ALLOWED);
        };

        remove_member_record(circle, member_addr);
        let returned = refund_member_deposit<T>(circle, wallet, member_addr, clock, ctx);

        event::emit(MemberRemoved {
            circle_id: object::uid_to_inner(&circle.id),
            member: member_addr,
            removed_by: sender,
            deposit_returned: returned > 0,
            deposit_amount: returned,
            timestamp: clock::timestamp_ms(clock),
        });
        touch_admin_heartbeat(circle, clock);
    }

    // Drops the member's table entry and frees their rotation seat (the
    // shared part of both removal paths).
    fun remove_member_record(circle: &mut Circle, member_addr: address) {
        table::remove(&mut circle.members, member_addr);
        circle.current_members = circle.current_members - 1;

        let (found, pos) = vector::index_of(&circle.rotation_order, &member_addr);
        if (found) {
            *vector::borrow_mut(&mut circle.rotation_order, pos) = @0x0;
        };
    }

    // ----------------------------------------------------------
    // Get security deposit amount
    // ----------------------------------------------------------
    public fun get_security_deposit_amount(circle: &Circle): u64 {
        config::get_security_deposit(&circle.id)
    }

    // ----------------------------------------------------------
    // Member security deposit — RETIRED in v11.
    //
    // Replaced by `post_security_deposit<T>`, which accepts only the coin
    // the circle's pinned terms name, at exactly the pinned amount, and
    // records it as the member's deposit in the circle's custody wallet.
    // The signature stays because an upgrade cannot change or remove a
    // public function.
    // ----------------------------------------------------------
    public fun member_deposit_security_deposit<CoinType>(
        _circle: &mut Circle,
        _wallet: &mut custody::CustodyWallet,
        _deposit_coin: Coin<CoinType>,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // ----------------------------------------------------------
    // Oracle-priced stablecoin deposit — RETIRED in v11 (use
    // `post_security_deposit<T>`).
    // ----------------------------------------------------------
    public fun deposit_stablecoin_with_price_validation<CoinType>(
        _circle: &mut Circle,
        _wallet: &mut custody::CustodyWallet,
        _stablecoin: coin::Coin<CoinType>,
        _required_amount: u64,
        _price_info_object: &PriceInfoObject,
        _clock: &clock::Clock,
        _ctx: &mut tx_context::TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // ----------------------------------------------------------
    // Legacy deposit bookkeeping entrypoint — RETIRED in v11: deposit
    // accounting lives in v11 deposit records, which change only together
    // with coins. `process_member_deposit_internal` keeps the legacy
    // bookkeeping available to package code.
    // ----------------------------------------------------------
    public fun process_member_deposit(
        _circle: &mut Circle,
        _deposit_amount: u64,
        _member_addr: address,
        _ctx: &mut TxContext
    ): bool {
        abort E_DEPRECATED_ENTRYPOINT
    }

    /// Package-internal legacy deposit bookkeeping (the pre-v11 body of
    /// `process_member_deposit`). It writes only the legacy per-member
    /// fields, which v11 money paths never read.
    public(package) fun process_member_deposit_internal(
        circle: &mut Circle,
        deposit_amount: u64,
        member_addr: address
    ): bool {
        assert!(is_member(circle, member_addr), 8);
        let security_deposit = config::get_security_deposit(&circle.id);
        let member = get_member_mut(circle, member_addr);
        assert!(deposit_amount >= security_deposit, 2); // EIncorrectDepositAmount

        members::set_deposit_balance(member, deposit_amount);
        members::set_recovery_sui_deposit(member, deposit_amount);
        members::clear_recovery_stablecoin_deposit(member);

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
        // v11: a circle with pinned terms is bound to its custody wallet for
        // good (CustodyBindingKey); the recorded id may not drift from it.
        assert!(!has_asset_policy(circle), E_POLICY_LOCKED);

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
    // Legacy custody-rail stablecoin contribution — RETIRED in v11.
    //
    // Rounds are paid through the per-round escrow
    // (njangi_cycle_escrow::contribute_round / contribute*). The signature
    // stays because an upgrade cannot change or remove a public function.
    // ----------------------------------------------------------
    public fun contribute_stablecoin<CoinType>(
        _circle: &mut Circle,
        _wallet: &mut custody::CustodyWallet,
        _payment: Coin<CoinType>,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
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
        // v11: a circle's amounts are pinned in its asset terms for life.
        assert!(!has_asset_policy(circle), E_POLICY_LOCKED);

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

    // Oracle-priced variant — RETIRED in v11 (no oracle on any circle path;
    // circles created on v11 pin their native terms).
    public fun update_cycle_limits_with_oracle(
        _circle: &mut Circle,
        _cycle_length: u64,
        _cycle_day: u64,
        _contribution_amount_usd: u64,
        _security_deposit_usd: u64,
        _contribution_amount_local: u64,
        _security_deposit_local: u64,
        _price_info_object: &PriceInfoObject,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // ----------------------------------------------------------
    // Native-amount re-pricing — RETIRED in v11. A circle's native amounts
    // are pinned in its asset terms for life; nothing re-prices a round.
    // ----------------------------------------------------------
    public fun sync_native_display_amounts(
        _circle: &mut Circle,
        _sui_price_usd_cents: u64,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun sync_native_display_amounts_with_oracle(
        _circle: &mut Circle,
        _price_info_object: &PriceInfoObject,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // ----------------------------------------------------------
    // Automatic Payout Helper Functions
    // ----------------------------------------------------------
    
    // Get the current cycle contribution total in USD cents.
    public fun get_contributions_this_cycle(circle: &Circle): u64 {
        circle.contributions_this_cycle
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
    // Security deposits persist across rotation laps
    //
    // A member posts their deposit once (member_deposit_security_deposit).
    // It sits in the circle's custody wallet and only leaves when the member
    // is removed from an INACTIVE circle (admin_remove_member) or a recovery
    // refunds everyone. `deposit_paid` is therefore true for exactly as long
    // as the deposit is held, and the pause/resume path must not touch it.
    //
    // History: until 2026-09 resume_cycle called a reset that flipped
    // deposit_paid to false on every rotation member while leaving
    // deposit_balance in place. That mirrored a legacy njangi_payments rail
    // which returned deposits at the end of each lap; the rail was deleted in
    // the Phase 1 compliance redesign, the reset was not. A resumed circle
    // then demanded a deposit that member_deposit_security_deposit refuses
    // (abort 21: balance already > 0) and that nothing could release
    // (admin_remove_member aborts 55 on an active circle), so no circle could
    // run a second lap. Testnet circle 0xa3fada18...675ed is stuck in that
    // state on the pre-fix package.
    // ----------------------------------------------------------

    /// Repair path for circles that resumed under the pre-fix package: if
    /// `member_addr`'s deposit is still held (`deposit_balance > 0`) but
    /// `deposit_paid` was cleared, restore the flag. Permissionless because
    /// it moves no funds and only re-derives the flag from state already on
    /// chain. It never CLEARS the flag (a zero-deposit circle legitimately
    /// holds deposit_paid with an empty balance) and it is idempotent.
    public fun reconcile_deposit_paid(
        circle: &mut Circle,
        member_addr: address,
        clock: &Clock
    ) {
        assert!(is_member(circle, member_addr), ENotMember);
        let circle_id = object::uid_to_inner(&circle.id);
        // v11: on a circle with pinned terms, "held" means a deposit recorded
        // in the circle's v11 deposit records; the legacy per-member fields
        // describe legacy storage only.
        let held = if (has_asset_policy(circle)) {
            deposit_held(circle, member_addr)
        } else {
            members::get_deposit_balance(table::borrow(&circle.members, member_addr))
        };
        let member = table::borrow_mut(&mut circle.members, member_addr);
        if (held > 0 && !members::has_paid_deposit(member)) {
            members::set_deposit_paid(member, true);
            event::emit(DepositPaidReconciled {
                circle_id,
                member: member_addr,
                deposit_balance: held,
                timestamp: clock::timestamp_ms(clock),
            });
        };
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
    // Escrow history (Circle Record v1.1)
    // ----------------------------------------------------------

    /// Records a newly opened cycle escrow in the circle's on-chain
    /// history. package-internal: only sibling modules (the escrow module)
    /// may write it, so the history can never contain an id the package
    /// itself did not mint.
    public(package) fun record_escrow_opened(circle: &mut Circle, escrow_id: ID) {
        if (dynamic_field::exists_(&circle.id, FIELD_ESCROW_HISTORY)) {
            let history = dynamic_field::borrow_mut<vector<u8>, vector<ID>>(
                &mut circle.id,
                FIELD_ESCROW_HISTORY
            );
            vector::push_back(history, escrow_id);
        } else {
            dynamic_field::add(&mut circle.id, FIELD_ESCROW_HISTORY, vector[escrow_id]);
        }
    }

    /// Every escrow opened through the indexed paths, oldest first. Empty
    /// for circles that predate the feature or only used the un-indexed
    /// opens — callers must treat absence as "no data", never as "no
    /// cycles ran".
    public fun get_escrow_history(circle: &Circle): vector<ID> {
        if (dynamic_field::exists_(&circle.id, FIELD_ESCROW_HISTORY)) {
            *dynamic_field::borrow<vector<u8>, vector<ID>>(&circle.id, FIELD_ESCROW_HISTORY)
        } else {
            vector::empty<ID>()
        }
    }

    // ----------------------------------------------------------
    // Open-round marker (Circle Record v1.2 — duplicate-open guard)
    //
    // Production 2026-08-30 (circle 0xa3fada…675ed): the admin's client
    // opened two escrows for ONE round 34 seconds apart and members split
    // their contributions across them. `escrow_history` is append-only and
    // says nothing about which entry is live, and the open path holds only
    // a `&Circle`, so it cannot read the previous escrow object to find
    // out. This marker is the fact it needs: the (cycle, recipient, escrow)
    // of the round most recently opened through the indexed entries.
    //
    // Lifecycle: written by every indexed open (overwriting whatever was
    // there — by then the previous round has either settled and rotated
    // on, or been released), cleared by `advance_circle_after_claim` once
    // the round's payout has rotated the circle, and cleared by
    // `release_open_round` for an escrow that can no longer pay out
    // (refunded, or empty past its cancel window). The escrow module owns
    // every write; this module only stores and reads it.
    // ----------------------------------------------------------

    /// The escrow round a circle currently has open. `copy` + `drop` so
    /// readers take it by value; only the escrow module can mint one.
    public struct OpenRound has store, copy, drop {
        cycle_no: u64,
        recipient: address,
        escrow_id: ID,
    }

    /// Marks `escrow_id` as the live escrow for the circle's CURRENT round
    /// — its current cycle number and scheduled recipient, which is exactly
    /// what the escrow just snapshotted. package-internal, like
    /// `record_escrow_opened`, so the marker can never name an id the
    /// package did not mint.
    public(package) fun record_round_opened(circle: &mut Circle, escrow_id: ID) {
        // The open path asserted a recipient exists before minting the
        // escrow; destroy_some re-asserts it rather than storing a
        // placeholder.
        let recipient = option::destroy_some(get_next_payout_recipient(circle));
        let marker = OpenRound { cycle_no: circle.current_cycle, recipient, escrow_id };
        if (dynamic_field::exists_(&circle.id, FIELD_OPEN_ROUND)) {
            *dynamic_field::borrow_mut<vector<u8>, OpenRound>(&mut circle.id, FIELD_OPEN_ROUND) = marker;
        } else {
            dynamic_field::add(&mut circle.id, FIELD_OPEN_ROUND, marker);
        }
    }

    /// Removes the marker if — and only if — it names `escrow_id`, and
    /// says whether it did. A marker naming some other escrow is left
    /// alone: settling or abandoning an OLD escrow must never unlock the
    /// round a newer one is holding.
    public(package) fun clear_open_round(circle: &mut Circle, escrow_id: ID): bool {
        if (!dynamic_field::exists_(&circle.id, FIELD_OPEN_ROUND)) {
            return false
        };
        let current = dynamic_field::borrow<vector<u8>, OpenRound>(&circle.id, FIELD_OPEN_ROUND);
        if (current.escrow_id != escrow_id) {
            return false
        };
        let _removed: OpenRound = dynamic_field::remove(&mut circle.id, FIELD_OPEN_ROUND);
        true
    }

    /// The marker, if any. `none` is "no marker" — for a circle that
    /// predates the feature or only ever used the un-indexed opens it
    /// carries no information about whether a round is open.
    public fun open_round(circle: &Circle): Option<OpenRound> {
        if (dynamic_field::exists_(&circle.id, FIELD_OPEN_ROUND)) {
            option::some(*dynamic_field::borrow<vector<u8>, OpenRound>(&circle.id, FIELD_OPEN_ROUND))
        } else {
            option::none()
        }
    }

    public fun open_round_cycle_no(marker: &OpenRound): u64 { marker.cycle_no }
    public fun open_round_recipient(marker: &OpenRound): address { marker.recipient }
    public fun open_round_escrow_id(marker: &OpenRound): ID { marker.escrow_id }

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

        // Security deposits are deliberately NOT reset: they stay in custody
        // for the life of the membership (see reconcile_deposit_paid). A
        // member admitted while paused still owes theirs and can post it now,
        // because their deposit_balance is 0.

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
        // v11: a converted circle stops once and refunds per asset; this
        // call refunds `CoinType` (other assets: `refund_asset<U>`).
        // v11 refunds only from v11 deposit records: a circle created before
        // v11 converts first (`adopt_asset_policy`, permissionless).
        assert!(is_converted(circle), E_CIRCLE_NOT_CONVERTED);
        assert_bound_wallet(circle, wallet);
        stop_internal(circle, false, RECOVERY_TRIGGER_ROLE_VOTE_EXECUTION, clock, ctx);
        refund_asset_internal<CoinType>(circle, wallet, clock, ctx);
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
        assert!(is_converted(circle), E_CIRCLE_NOT_CONVERTED);
        assert_bound_wallet(circle, wallet);
        stop_internal(circle, true, trigger_role, clock, ctx);
        refund_asset_internal<CoinType>(circle, wallet, clock, ctx);
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
    
    // ----------------------------------------------------------
    // Legacy-rail funding views — RETIRED in v11 with the legacy custody
    // payout rail they gated. A round's funding is its escrow's own record
    // (njangi_cycle_escrow::contributor_count / required_contributors).
    // ----------------------------------------------------------
    public fun current_cycle_contributing_members(_circle: &Circle): u64 {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun has_all_members_contributed(_circle: &Circle): bool {
        abort E_DEPRECATED_ENTRYPOINT
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

    // Legacy automated-payout readiness — RETIRED in v11 (see above).
    public fun is_circle_ready_for_automated_payout(_circle: &Circle, _clock: &Clock): bool {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // Legacy automated-payout status — RETIRED in v11 (see above).
    public fun get_automation_status(_circle: &Circle, _clock: &Clock): AutomationStatus {
        abort E_DEPRECATED_ENTRYPOINT
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

    // Caller-supplied automation events — RETIRED in v11: anyone could emit
    // them about any circle. The views above stay.
    public fun emit_automation_triggered(
        _circle: &Circle,
        _automation_type: vector<u8>,
        _success: bool,
        _details: vector<u8>,
        _clock: &Clock
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun emit_payout_overdue(_circle: &Circle, _clock: &Clock) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun emit_automation_failed(
        _circle: &Circle,
        _automation_type: vector<u8>,
        _error_code: u64,
        _error_message: vector<u8>,
        _retry_count: u64,
        _clock: &Clock
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun emit_payout_warning(_circle: &Circle, _warning_level: u8, _clock: &Clock) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // Note: Batch automation status queries will be handled in the automation service
    // Individual circle status is available via get_automation_status

    // Check if circle has valid rotation setup
    public fun has_valid_rotation(circle: &Circle): bool {
        let rotation_len = vector::length(&circle.rotation_order);
        rotation_len > 0 && circle.current_position < rotation_len
    }

    // ==========================================================
    // v11 — asset terms, deposit records, conversion, per-asset refunds
    // ==========================================================

    // ---------------- reads ----------------

    public fun has_asset_policy(circle: &Circle): bool {
        dynamic_field::exists_with_type<AssetPolicyKey, CircleAssetPolicy>(&circle.id, AssetPolicyKey {})
    }

    public fun asset_policy(circle: &Circle): Option<CircleAssetPolicy> {
        if (has_asset_policy(circle)) {
            option::some(*policy_ref(circle))
        } else {
            option::none()
        }
    }

    /// True once the circle runs on v11 storage (its terms are pinned, at
    /// creation or by `adopt_asset_policy`).
    public fun is_converted(circle: &Circle): bool {
        has_asset_policy(circle)
    }

    /// Custody-wallet ledger entries the conversion covered; 0 for circles
    /// created on v11. Entries appended later describe legacy storage only.
    public fun legacy_migrated_entries(circle: &Circle): Option<u64> {
        if (has_asset_policy(circle)) {
            option::some(policy_ref(circle).legacy_ledger_entries)
        } else {
            option::none()
        }
    }

    /// The custody wallet every v11 money path of this circle must be given.
    public fun bound_wallet_id(circle: &Circle): Option<ID> {
        if (has_asset_policy(circle)) {
            option::some(policy_ref(circle).wallet_id)
        } else {
            option::none()
        }
    }

    public fun policy_settlement_asset(policy: &CircleAssetPolicy): vector<u8> { policy.settlement_asset }
    public fun policy_assets(policy: &CircleAssetPolicy): vector<AssetTerms> { policy.assets }
    public fun policy_set_at_ms(policy: &CircleAssetPolicy): u64 { policy.set_at_ms }
    public fun policy_terms_for(policy: &CircleAssetPolicy, asset: vector<u8>): Option<AssetTerms> {
        find_terms(policy, &asset)
    }
    public fun policy_settlement_terms(policy: &CircleAssetPolicy): AssetTerms {
        option::destroy_some(find_terms(policy, &policy.settlement_asset))
    }
    public fun terms_asset(terms: &AssetTerms): vector<u8> { terms.asset }
    public fun terms_decimals(terms: &AssetTerms): u8 { terms.decimals }
    public fun terms_contribution_amount(terms: &AssetTerms): u64 { terms.contribution_amount }
    public fun terms_security_deposit(terms: &AssetTerms): u64 { terms.security_deposit }

    /// The member's security deposit in `asset`, as recorded in the
    /// circle's custody wallet (0 when none).
    public fun member_deposit_of(circle: &Circle, member: address, asset: vector<u8>): u64 {
        let key = member_deposit_key(member, asset);
        if (dynamic_field::exists_with_type<MemberDepositKey, u64>(&circle.id, key)) {
            *dynamic_field::borrow<MemberDepositKey, u64>(&circle.id, key)
        } else {
            0
        }
    }

    /// Everyone who has ever had a deposit recorded in `asset`
    /// (append-only; refunded members stay listed with a zero record).
    public fun depositors_of(circle: &Circle, asset: vector<u8>): vector<address> {
        let key = DepositorsKey { asset };
        if (dynamic_field::exists_with_type<DepositorsKey, vector<address>>(&circle.id, key)) {
            *dynamic_field::borrow<DepositorsKey, vector<address>>(&circle.id, key)
        } else {
            vector::empty()
        }
    }

    public fun total_member_deposits(circle: &Circle, asset: vector<u8>): u64 {
        let depositors = depositors_of(circle, asset);
        let mut total = 0;
        let mut i = 0;
        while (i < vector::length(&depositors)) {
            total = total + member_deposit_of(circle, *vector::borrow(&depositors, i), asset);
            i = i + 1;
        };
        total
    }

    /// The asset a member's current deposit is in (none when they hold no
    /// deposit record).
    public fun deposit_marker_of(circle: &Circle, member: address): Option<vector<u8>> {
        let key = DepositMarkerKey { member };
        if (dynamic_field::exists_with_type<DepositMarkerKey, vector<u8>>(&circle.id, key)) {
            option::some(*dynamic_field::borrow<DepositMarkerKey, vector<u8>>(&circle.id, key))
        } else {
            option::none()
        }
    }

    /// When the last refund run for `asset` completed (ms), if any.
    public fun refund_record_of(circle: &Circle, asset: vector<u8>): Option<u64> {
        let key = RefundRecordKey { asset };
        if (dynamic_field::exists_with_type<RefundRecordKey, u64>(&circle.id, key)) {
            option::some(*dynamic_field::borrow<RefundRecordKey, u64>(&circle.id, key))
        } else {
            option::none()
        }
    }

    // ---------------- conversion of a pre-v11 circle ----------------

    /// Converts a circle created before v11: pins its asset terms and moves
    /// its legacy security deposits into the v11 deposit records of the SAME
    /// custody wallet, credited to each member exactly as the wallet's
    /// append-only ledger records them. Permissionless and deterministic:
    /// nothing leaves the wallet, no balance moves between members, and the
    /// terms restate what the circle already does —
    ///   - `T` = SUI requires the circle to be in SUI mode and pins its
    ///     configured SUI amounts;
    ///   - a USD-pegged `T` requires the circle to be in stablecoin mode and
    ///     pins its USD amounts at the peg.
    /// All-or-nothing: if the ledger is not exactly "security deposits in
    /// `T` and their refunds" and does not add up to the wallet's legacy
    /// balance of `T`, nothing changes (E_LEGACY_NOT_MIGRATABLE).
    public fun adopt_asset_policy<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        registry: &price_validator::AssetRegistry,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        assert!(!has_asset_policy(circle), E_POLICY_EXISTS);
        assert_original_wallet(circle, wallet);

        let decimals = price_validator::assert_usable<T>(registry, price_validator::flag_settlement());
        let asset = core::coin_type_bytes<T>();
        let auto_swap = config::is_auto_swap_enabled(&circle.id);
        let (contribution_native, deposit_native) = if (core::is_sui<T>()) {
            assert!(auto_swap, E_TERMS_INVALID);
            (config::get_contribution_amount(&circle.id), config::get_security_deposit(&circle.id))
        } else {
            assert!(!auto_swap, E_TERMS_INVALID);
            assert!(price_validator::is_usd_pegged<T>(registry), E_TERMS_INVALID);
            (
                core::usd_cents_to_pegged_units(config::get_contribution_amount_usd(&circle.id), decimals),
                core::usd_cents_to_pegged_units(config::get_security_deposit_usd(&circle.id), decimals)
            )
        };
        assert!(contribution_native > 0 && deposit_native > 0, E_TERMS_INVALID);

        // The ledger is the source of the per-member amounts.
        assert!(custody::legacy_is_single_asset<T>(wallet), E_LEGACY_NOT_MIGRATABLE);
        let (consistent, users, nets) = custody::legacy_deposit_nets(wallet);
        assert!(consistent, E_LEGACY_NOT_MIGRATABLE);
        let mut total = 0;
        let mut i = 0;
        while (i < vector::length(&nets)) {
            total = total + *vector::borrow(&nets, i);
            i = i + 1;
        };
        assert!(total == custody::legacy_balance_of<T>(wallet), E_LEGACY_NOT_MIGRATABLE);
        assert_ledger_covers_deposit_holders(circle, &users, &nets);

        let ledger_entries = custody::legacy_history_length(wallet);
        let moved = custody::migrate_legacy_to_deposit_balance<T>(wallet, clock);
        assert!(moved == total, E_LEGACY_NOT_MIGRATABLE);

        let mut migrated_members = 0;
        let mut k = 0;
        while (k < vector::length(&users)) {
            let user = *vector::borrow(&users, k);
            let net = *vector::borrow(&nets, k);
            if (net > 0) {
                credit_member_deposit(circle, user, asset, net);
                set_deposit_marker(circle, user, asset);
                if (table::contains(&circle.members, user)) {
                    members::set_deposit_paid(table::borrow_mut(&mut circle.members, user), true);
                };
                migrated_members = migrated_members + 1;
            };
            clear_legacy_deposit_fields(circle, user);
            k = k + 1;
        };
        // The legacy per-member deposit fields describe legacy storage,
        // which no longer holds this circle's deposits.
        let admin = circle.admin;
        clear_legacy_deposit_fields(circle, admin);
        let rotation = circle.rotation_order;
        let mut r = 0;
        while (r < vector::length(&rotation)) {
            clear_legacy_deposit_fields(circle, *vector::borrow(&rotation, r));
            r = r + 1;
        };

        let now = clock::timestamp_ms(clock);
        let wallet_id = object::id(wallet);
        let terms = AssetTerms {
            asset,
            decimals,
            contribution_amount: contribution_native,
            security_deposit: deposit_native,
        };
        pin_asset_policy(circle, terms, wallet_id, ledger_entries, now);

        event::emit(CircleAssetPolicySet {
            circle_id: object::uid_to_inner(&circle.id),
            wallet_id,
            settlement_asset: string::utf8(asset),
            decimals,
            contribution_amount: contribution_native,
            security_deposit: deposit_native,
            converted_from_legacy: true,
            migrated_members,
            migrated_total: total,
            legacy_ledger_entries: ledger_entries,
            set_at_ms: now,
        });
    }

    // The custody wallet a pre-v11 circle's deposits live in, identified by
    // facts fixed when the circle was created: the wallet points at this
    // circle; the circle's recorded wallet id, where it is a real id
    // (circles created since v9), names it; and it was created by the
    // circle's admin in the circle's own create transaction (same creator,
    // same clock reading). The ledger coverage check in
    // `adopt_asset_policy` completes it: every member holding a deposit
    // must appear in this wallet's ledger.
    fun assert_original_wallet(circle: &Circle, wallet: &CustodyWallet) {
        let circle_id = object::uid_to_inner(&circle.id);
        assert!(custody::get_circle_id(wallet) == circle_id, EWalletCircleMismatch);
        let recorded = get_wallet_id(circle);
        if (option::is_some(&recorded) && *option::borrow(&recorded) != circle_id) {
            assert!(*option::borrow(&recorded) == object::id(wallet), EWalletCircleMismatch);
        };
        assert!(custody::get_admin(wallet) == circle.admin, EWalletCircleMismatch);
        assert!(custody::get_created_at(wallet) == circle.created_at, EWalletCircleMismatch);
    }

    // Every member the circle records as holding a deposit (flag set, or a
    // legacy balance recorded) must have a deposit in this wallet's ledger.
    // Fails closed: a circle whose records and ledger disagree is left as
    // it is.
    fun assert_ledger_covers_deposit_holders(
        circle: &Circle,
        users: &vector<address>,
        nets: &vector<u64>
    ) {
        assert_ledger_covers(circle, circle.admin, users, nets);
        let mut i = 0;
        while (i < vector::length(&circle.rotation_order)) {
            assert_ledger_covers(circle, *vector::borrow(&circle.rotation_order, i), users, nets);
            i = i + 1;
        };
    }

    fun assert_ledger_covers(
        circle: &Circle,
        addr: address,
        users: &vector<address>,
        nets: &vector<u64>
    ) {
        if (addr == @0x0 || !table::contains(&circle.members, addr)) {
            return
        };
        let member = table::borrow(&circle.members, addr);
        if (members::has_paid_deposit(member) || members::get_deposit_balance(member) > 0) {
            let (found, index) = vector::index_of(users, &addr);
            assert!(found && *vector::borrow(nets, index) > 0, E_LEGACY_NOT_MIGRATABLE);
        };
    }

    fun clear_legacy_deposit_fields(circle: &mut Circle, addr: address) {
        if (addr == @0x0 || !table::contains(&circle.members, addr)) {
            return
        };
        let member = table::borrow_mut(&mut circle.members, addr);
        members::set_deposit_balance(member, 0);
        members::clear_all_recovery_balances(member);
    }

    // ---------------- security deposits ----------------

    /// Posts the sender's security deposit in coin `T`: one of the circle's
    /// pinned assets, at exactly its pinned amount, and (registry) still
    /// allowed for security deposits. The coin is recorded as the sender's deposit
    /// in the circle's custody wallet; it leaves only as a refund to them.
    public fun post_security_deposit<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        registry: &price_validator::AssetRegistry,
        deposit: Coin<T>,
        _clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_bound_wallet(circle, wallet);
        assert!(is_member(circle, sender), ENotMember);
        let status = members::get_status(table::borrow(&circle.members, sender));
        assert!(status == core::member_status_active() || sender == circle.admin, EMemberNotActive);
        let state = config::get_recovery_state(&circle.id);
        assert!(
            state == config::recovery_state_active() || state == config::recovery_state_proposal_pending(),
            E_CIRCLE_STOPPED
        );

        let asset = core::coin_type_bytes<T>();
        let terms_opt = find_terms(policy_ref(circle), &asset);
        assert!(option::is_some(&terms_opt), E_ASSET_NOT_ALLOWED);
        let terms = option::destroy_some(terms_opt);
        assert!(terms.security_deposit > 0, E_ASSET_NOT_ALLOWED);
        price_validator::assert_usable<T>(registry, price_validator::flag_deposit());

        let amount = coin::value(&deposit);
        assert!(amount == terms.security_deposit, EIncorrectDepositAmount);
        assert!(
            !dynamic_field::exists_(&circle.id, DepositMarkerKey { member: sender }),
            E_DEPOSIT_ALREADY_POSTED
        );

        custody::store_member_deposit<T>(wallet, deposit, sender);
        credit_member_deposit(circle, sender, asset, amount);
        set_deposit_marker(circle, sender, asset);
        members::set_deposit_paid(table::borrow_mut(&mut circle.members, sender), true);

        event::emit(SecurityDepositPosted {
            circle_id: object::uid_to_inner(&circle.id),
            member: sender,
            coin_type: string::utf8(asset),
            decimals: terms.decimals,
            amount,
        });
    }

    // ---------------- stop, then refund per asset ----------------

    /// Stops a converted circle after a passed emergency-stop vote. Moves no
    /// coins and reads no balance or member list, so no asset and no member
    /// state can make it fail. Refunds follow per asset (`refund_asset<T>`).
    public fun stop_for_recovery(circle: &mut Circle, clock: &Clock, ctx: &mut TxContext) {
        assert!(is_converted(circle), E_CIRCLE_NOT_CONVERTED);
        assert!(
            config::can_execute_recovery(&circle.id, clock)
                && config::is_recovery_proposal_passed(&circle.id),
            ERecoveryExecutionNotReady
        );
        stop_internal(circle, false, RECOVERY_TRIGGER_ROLE_VOTE_EXECUTION, clock, ctx);
    }

    /// Stops a converted circle through its auto-release rule (same roles as
    /// `trigger_auto_release`). Moves no coins.
    public fun stop_for_auto_release(circle: &mut Circle, clock: &Clock, ctx: &mut TxContext) {
        assert!(is_converted(circle), E_CIRCLE_NOT_CONVERTED);
        assert!(config::is_auto_release_ready(&circle.id, clock), ERecoveryExecutionNotReady);
        let trigger_role = resolve_auto_release_trigger_role(
            circle,
            tx_context::sender(ctx),
            clock::timestamp_ms(clock)
        );
        stop_internal(circle, true, trigger_role, clock, ctx);
    }

    /// Returns every recorded deposit in `T` to the member it is recorded
    /// for. Permissionless once the circle is stopped (by any package
    /// version). Touches only `T`; never aborts for lack of something to
    /// refund, so one transaction can chain it for every asset. Records the
    /// run, and marks the circle refunded once every pinned asset is done.
    public fun refund_asset<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let state = config::get_recovery_state(&circle.id);
        assert!(
            state == config::recovery_state_stopped() || state == config::recovery_state_refunded(),
            E_CIRCLE_NOT_STOPPED
        );
        // No pinned terms, no v11 deposit records: nothing to return.
        if (!has_asset_policy(circle)) {
            return
        };
        assert_bound_wallet(circle, wallet);
        refund_asset_internal<T>(circle, wallet, clock, ctx);
    }

    /// `stop_for_recovery` (unless already stopped), then `refund_asset<T>`.
    public fun execute_recovery_asset<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        if (!is_stopped(circle)) {
            stop_for_recovery(circle, clock, ctx);
        };
        refund_asset<T>(circle, wallet, clock, ctx);
    }

    /// `stop_for_auto_release` (unless already stopped), then
    /// `refund_asset<T>`.
    public fun trigger_auto_release_asset<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        if (!is_stopped(circle)) {
            stop_for_auto_release(circle, clock, ctx);
        };
        refund_asset<T>(circle, wallet, clock, ctx);
    }

    /// The sender collects their own recorded deposit in `T`: after the
    /// circle is stopped, or at any time once they are no longer a member
    /// (e.g. removed while their deposit stayed recorded). Paid to the
    /// sender only; a no-op when nothing is recorded.
    public fun claim_own_refund<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_bound_wallet(circle, wallet);
        assert!(is_stopped(circle) || !table::contains(&circle.members, sender), E_CIRCLE_NOT_STOPPED);
        refund_member_deposit<T>(circle, wallet, sender, clock, ctx);
    }

    fun is_stopped(circle: &Circle): bool {
        let state = config::get_recovery_state(&circle.id);
        state == config::recovery_state_stopped() || state == config::recovery_state_refunded()
    }

    // The stop itself: same circle-state effects as the legacy recovery, no
    // coin movement. Emits the recovery start event (totals = deposits
    // recorded at stop time), which existing recovery readers follow.
    fun stop_internal(
        circle: &mut Circle,
        used_auto_release: bool,
        trigger_role: u8,
        clock: &Clock,
        ctx: &TxContext
    ) {
        let executor = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);
        let circle_id = object::uid_to_inner(&circle.id);
        let (sui_total, other_total) = deposit_totals_by_rail(circle);
        event::emit(RecoveryExecutionStarted {
            circle_id,
            executor,
            member_count: circle.current_members,
            total_sui_refund: sui_total,
            total_stablecoin_refund: other_total,
            used_auto_release,
            trigger_role,
            timestamp: now,
        });

        config::mark_recovery_stopped(&mut circle.id, clock);
        circle.is_active = false;
        circle.paused_after_cycle = false;
        circle.contributions_this_cycle = 0;
        clear_cycle_contributors(circle);
        circle.next_payout_time = now;
        circle.active_auction = option::none();
    }

    fun refund_asset_internal<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let asset = core::coin_type_bytes<T>();
        let now = clock::timestamp_ms(clock);
        let circle_id = object::uid_to_inner(&circle.id);
        let pinned = option::is_some(&find_terms(policy_ref(circle), &asset));
        let settles_in_sui = core::is_sui<T>();

        let depositors = depositors_of(circle, asset);
        let mut total = 0;
        let mut refunded = 0;
        let mut i = 0;
        while (i < vector::length(&depositors)) {
            let member = *vector::borrow(&depositors, i);
            let amount = refund_member_deposit<T>(circle, wallet, member, clock, ctx);
            if (amount > 0) {
                total = total + amount;
                refunded = refunded + 1;
                // Legacy per-member event, for existing recovery readers.
                event::emit(RecoveryMemberRefunded {
                    circle_id,
                    member,
                    sui_contributions_refunded: 0,
                    sui_deposit_refunded: if (settles_in_sui) { amount } else { 0 },
                    stablecoin_contributions_refunded: 0,
                    stablecoin_deposit_refunded: if (settles_in_sui) { 0 } else { amount },
                    timestamp: now,
                });
            };
            i = i + 1;
        };

        if (pinned) {
            let key = RefundRecordKey { asset };
            if (dynamic_field::exists_with_type<RefundRecordKey, u64>(&circle.id, key)) {
                *dynamic_field::borrow_mut<RefundRecordKey, u64>(&mut circle.id, key) = now;
            } else {
                dynamic_field::add(&mut circle.id, key, now);
            };
            event::emit(AssetRefundCompleted {
                circle_id,
                coin_type: string::utf8(asset),
                total_amount: total,
                members: refunded,
                timestamp: now,
            });
        };

        if (
            config::get_recovery_state(&circle.id) == config::recovery_state_stopped()
                && all_pinned_assets_refunded(circle)
        ) {
            config::mark_recovery_refunded(&mut circle.id, clock);
            event::emit(RecoveryExecutionCompleted {
                circle_id,
                executor: tx_context::sender(ctx),
                refunded_members: refunded,
                total_sui_refund: if (settles_in_sui) { total } else { 0 },
                total_stablecoin_refund: if (settles_in_sui) { 0 } else { total },
                timestamp: now,
            });
        };
    }

    // Pays `member` their recorded deposit in `T` — to `member`, for exactly
    // the recorded amount — and zeroes the record. 0 means nothing was
    // recorded (no-op). The single exit of the v11 deposit records.
    fun refund_member_deposit<T>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        member: address,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        let asset = core::coin_type_bytes<T>();
        let amount = clear_member_deposit(circle, member, asset);
        if (amount == 0) {
            return 0
        };
        let refund = coin::from_balance(custody::split_deposit_balance<T>(wallet, amount), ctx);
        transfer::public_transfer(refund, member);
        clear_deposit_marker_if(circle, member, &asset);
        if (table::contains(&circle.members, member) && deposit_held(circle, member) == 0) {
            members::set_deposit_paid(table::borrow_mut(&mut circle.members, member), false);
        };

        // Full coin type; followed by the deposit-returned notification relay.
        event::emit(SecurityDepositReturned {
            circle_id: object::uid_to_inner(&circle.id),
            wallet_id: object::id(wallet),
            member,
            amount,
            coin_type: string::utf8(asset),
            timestamp: clock::timestamp_ms(clock),
        });
        amount
    }

    // ---------------- internal helpers ----------------

    fun policy_ref(circle: &Circle): &CircleAssetPolicy {
        assert!(has_asset_policy(circle), E_POLICY_MISSING);
        dynamic_field::borrow<AssetPolicyKey, CircleAssetPolicy>(&circle.id, AssetPolicyKey {})
    }

    fun find_terms(policy: &CircleAssetPolicy, asset: &vector<u8>): Option<AssetTerms> {
        let mut i = 0;
        while (i < vector::length(&policy.assets)) {
            let terms = vector::borrow(&policy.assets, i);
            if (&terms.asset == asset) {
                return option::some(*terms)
            };
            i = i + 1;
        };
        option::none()
    }

    fun pin_asset_policy(
        circle: &mut Circle,
        terms: AssetTerms,
        wallet_id: ID,
        ledger_entries: u64,
        now: u64
    ) {
        let policy = CircleAssetPolicy {
            settlement_asset: terms.asset,
            assets: vector[terms],
            set_at_ms: now,
            wallet_id,
            legacy_ledger_entries: ledger_entries,
        };
        dynamic_field::add(&mut circle.id, AssetPolicyKey {}, policy);
    }

    fun is_bound_wallet(circle: &Circle, wallet: &CustodyWallet): bool {
        has_asset_policy(circle)
            && object::id(wallet) == policy_ref(circle).wallet_id
            && custody::get_circle_id(wallet) == object::uid_to_inner(&circle.id)
    }

    fun assert_bound_wallet(circle: &Circle, wallet: &CustodyWallet) {
        assert!(has_asset_policy(circle), E_POLICY_MISSING);
        assert!(is_bound_wallet(circle, wallet), EWalletCircleMismatch);
    }

    fun member_deposit_key(member: address, asset: vector<u8>): MemberDepositKey {
        MemberDepositKey { member, asset, kind: DEPOSIT_KIND_SECURITY }
    }

    fun credit_member_deposit(circle: &mut Circle, member: address, asset: vector<u8>, amount: u64) {
        let key = member_deposit_key(member, asset);
        if (dynamic_field::exists_with_type<MemberDepositKey, u64>(&circle.id, key)) {
            let record = dynamic_field::borrow_mut<MemberDepositKey, u64>(&mut circle.id, key);
            *record = *record + amount;
        } else {
            dynamic_field::add(&mut circle.id, key, amount);
        };

        let depositors_key = DepositorsKey { asset };
        if (dynamic_field::exists_with_type<DepositorsKey, vector<address>>(&circle.id, depositors_key)) {
            let list = dynamic_field::borrow_mut<DepositorsKey, vector<address>>(&mut circle.id, depositors_key);
            if (!vector::contains(list, &member)) {
                vector::push_back(list, member);
            };
        } else {
            dynamic_field::add(&mut circle.id, depositors_key, vector[member]);
        };
    }

    fun clear_member_deposit(circle: &mut Circle, member: address, asset: vector<u8>): u64 {
        let key = member_deposit_key(member, asset);
        if (!dynamic_field::exists_with_type<MemberDepositKey, u64>(&circle.id, key)) {
            return 0
        };
        let record = dynamic_field::borrow_mut<MemberDepositKey, u64>(&mut circle.id, key);
        let amount = *record;
        *record = 0;
        amount
    }

    fun set_deposit_marker(circle: &mut Circle, member: address, asset: vector<u8>) {
        let key = DepositMarkerKey { member };
        if (dynamic_field::exists_with_type<DepositMarkerKey, vector<u8>>(&circle.id, key)) {
            *dynamic_field::borrow_mut<DepositMarkerKey, vector<u8>>(&mut circle.id, key) = asset;
        } else {
            dynamic_field::add(&mut circle.id, key, asset);
        };
    }

    fun clear_deposit_marker_if(circle: &mut Circle, member: address, asset: &vector<u8>) {
        let key = DepositMarkerKey { member };
        if (
            dynamic_field::exists_with_type<DepositMarkerKey, vector<u8>>(&circle.id, key)
                && dynamic_field::borrow<DepositMarkerKey, vector<u8>>(&circle.id, key) == asset
        ) {
            let _removed: vector<u8> = dynamic_field::remove(&mut circle.id, key);
        };
    }

    // The member's recorded deposits across the circle's pinned assets.
    fun deposit_held(circle: &Circle, member: address): u64 {
        if (!has_asset_policy(circle)) {
            return 0
        };
        let policy = policy_ref(circle);
        let mut total = 0;
        let mut i = 0;
        while (i < vector::length(&policy.assets)) {
            total = total + member_deposit_of(circle, member, vector::borrow(&policy.assets, i).asset);
            i = i + 1;
        };
        total
    }

    fun any_member_deposit_held(circle: &Circle): bool {
        let policy = policy_ref(circle);
        let mut i = 0;
        while (i < vector::length(&policy.assets)) {
            if (total_member_deposits(circle, vector::borrow(&policy.assets, i).asset) > 0) {
                return true
            };
            i = i + 1;
        };
        false
    }

    // (SUI, everything else) recorded deposit totals, for the legacy event.
    fun deposit_totals_by_rail(circle: &Circle): (u64, u64) {
        let policy = policy_ref(circle);
        let sui = core::coin_type_bytes<SUI>();
        let mut sui_total = 0;
        let mut other_total = 0;
        let mut i = 0;
        while (i < vector::length(&policy.assets)) {
            let asset = vector::borrow(&policy.assets, i).asset;
            let total = total_member_deposits(circle, asset);
            if (asset == sui) {
                sui_total = sui_total + total;
            } else {
                other_total = other_total + total;
            };
            i = i + 1;
        };
        (sui_total, other_total)
    }

    fun all_pinned_assets_refunded(circle: &Circle): bool {
        let policy = policy_ref(circle);
        let mut i = 0;
        while (i < vector::length(&policy.assets)) {
            let asset = vector::borrow(&policy.assets, i).asset;
            if (!dynamic_field::exists_(&circle.id, RefundRecordKey { asset })) {
                return false
            };
            if (total_member_deposits(circle, asset) > 0) {
                return false
            };
            i = i + 1;
        };
        true
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

    /// Configures a test circle as a smart-goal circle (goal_type +
    /// target_amount on its attached MilestoneConfig) so the
    /// njangi_milestones creation gate (`has_goal_type`) can be
    /// exercised; the test factory attaches an empty milestone config.
    #[test_only]
    public fun set_goal_type_for_testing(
        circle: &mut Circle,
        goal_type: u8,
        target_amount: u64
    ) {
        config::set_goal_for_testing(
            config::get_milestone_config_mut(&mut circle.id),
            goal_type,
            target_amount
        );
    }

    #[test_only]
    public fun set_paused_after_cycle_for_testing(circle: &mut Circle, paused: bool) {
        circle.paused_after_cycle = paused;
    }

    /// The test factory shares an ACTIVE circle; migration happens before
    /// activation, so these rewind it to the pre-activation shape.
    #[test_only]
    public fun set_is_active_for_testing(circle: &mut Circle, active: bool) {
        circle.is_active = active;
    }

    /// The factory sizes max_members to the initial roster, and the public
    /// setter (admin_set_max_members) only works on an inactive circle, so
    /// lifecycle tests that admit a member between laps raise the cap here.
    #[test_only]
    public fun set_max_members_for_testing(circle: &mut Circle, max_members: u64) {
        config::set_max_members(&mut circle.id, max_members);
    }

    /// activate_circle refuses to start until every seat in the rotation has
    /// posted its security deposit. The factory creates members unpaid.
    #[test_only]
    public fun mark_all_deposits_paid_for_testing(circle: &mut Circle) {
        let rotation = circle.rotation_order;
        let len = vector::length(&rotation);
        let mut i = 0;
        while (i < len) {
            let addr = *vector::borrow(&rotation, i);
            let member = table::borrow_mut(&mut circle.members, addr);
            members::set_deposit_paid(member, true);
            i = i + 1;
        };
    }

    #[test_only]
    public fun has_received_payout_for_testing(circle: &Circle, member_addr: address): bool {
        members::has_received_payout(table::borrow(&circle.members, member_addr))
    }

    /// Test-only: the pre-v11 security-deposit path (the body
    /// `member_deposit_security_deposit` had before v11), used to build
    /// circles in the state earlier package versions leave them in — legacy
    /// typed balance, ledger op 3, legacy per-member fields.
    #[test_only]
    public fun legacy_deposit_for_testing<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        deposit_coin: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = coin::value(&deposit_coin);
        let required_sui_amount = config::get_security_deposit(&circle.id);
        let required_usd_cents = config::get_security_deposit_usd(&circle.id);
        assert!(custody::get_circle_id(wallet) == get_id(circle), EWalletCircleMismatch);
        assert!(is_member(circle, sender), 8);
        let member = get_member_mut(circle, sender);
        assert!(members::get_deposit_balance(member) == 0, 21);
        let is_sui_deposit = std::type_name::get<CoinType>() == std::type_name::get<SUI>();
        if (is_sui_deposit) {
            assert!(amount == required_sui_amount, 2);
        } else {
            assert!(amount == custody::usd_cents_to_usdc_amount(required_usd_cents), 2);
        };
        members::set_deposit_balance(member, amount);
        members::set_deposit_paid(member, true);
        if (is_sui_deposit) {
            members::set_recovery_sui_deposit(member, amount);
            members::clear_recovery_stablecoin_deposit(member);
        } else {
            members::set_recovery_stablecoin_deposit(member, amount);
            members::clear_recovery_sui_deposit(member);
        };
        custody::legacy_store_for_testing<CoinType>(
            wallet,
            deposit_coin,
            sender,
            core::custody_op_stablecoin_deposit(),
            clock
        );
    }

    /// Test-only: a pre-v11 legacy-rail contribution (ledger op 0).
    #[test_only]
    public fun legacy_contribution_for_testing<CoinType>(
        wallet: &mut CustodyWallet,
        payment: Coin<CoinType>,
        member: address,
        clock: &Clock,
        ctx: &TxContext
    ) {
        let _ = ctx;
        custody::legacy_store_for_testing<CoinType>(wallet, payment, member, core::custody_op_deposit(), clock);
    }

    #[test_only]
    public fun mark_recovery_refunded_for_testing(circle: &mut Circle, clock: &Clock) {
        config::mark_recovery_refunded(&mut circle.id, clock);
    }

    #[test_only]
    public fun set_auto_swap_for_testing(circle: &mut Circle, enabled: bool) {
        config::toggle_auto_swap(&mut circle.id, enabled);
    }

    /// Records `wallet_id` where pre-v11 readers look for the circle's
    /// wallet (as create_circle has done since v9).
    #[test_only]
    public fun set_wallet_id_for_testing(circle: &mut Circle, wallet_id: ID) {
        let key = string::utf8(b"wallet_id");
        if (dynamic_field::exists_(&circle.id, key)) {
            *dynamic_field::borrow_mut<String, ID>(&mut circle.id, key) = wallet_id;
        } else {
            dynamic_field::add(&mut circle.id, key, wallet_id);
        };
    }

    #[test_only]
    public fun get_created_at_for_testing(circle: &Circle): u64 {
        circle.created_at
    }

    #[test_only]
    public fun legacy_deposit_fields_for_testing(circle: &Circle, member_addr: address): (u64, u64, u64) {
        let member = table::borrow(&circle.members, member_addr);
        (
            members::get_deposit_balance(member),
            members::get_recovery_sui_deposit(member),
            members::get_recovery_stablecoin_deposit(member)
        )
    }

    // ----------------------------------------------------------
    // Rotation-order lifecycle lock
    //
    // rotation_order[current_position] IS the next payout recipient, so an
    // admin who can reorder mid-cycle can redirect a payout members have
    // already funded. These pin the lock that removes that discretion.
    // ----------------------------------------------------------

    #[test]
    #[expected_failure(abort_code = ECircleNotPausedForConfigChange)]
    fun test_reorder_rotation_blocked_while_cycle_running() {
        let admin = @0xA;
        let bob = @0xB;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(vector[admin, bob], 1_000_000_000, 100, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        // Circle is active and not paused: the admin must not be able to put
        // themselves in front of the queue now.
        reorder_rotation_positions(
            &mut circle,
            vector[bob, admin],
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECircleNotPausedForConfigChange)]
    fun test_set_rotation_position_blocked_while_cycle_running() {
        let admin = @0xA;
        let bob = @0xB;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(vector[admin, bob], 1_000_000_000, 100, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        set_rotation_position(&mut circle, admin, 0, &clock, sui::test_scenario::ctx(&mut scenario));
        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_reorder_rotation_allowed_while_paused_between_cycles() {
        // The lock is a timing constraint, not a ban: members can still agree
        // a new order between cycles, when nobody has funded the next payout.
        let admin = @0xA;
        let bob = @0xB;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(vector[admin, bob], 1_000_000_000, 100, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        set_paused_after_cycle_for_testing(&mut circle, true);
        reorder_rotation_positions(
            &mut circle,
            vector[bob, admin],
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        assert!(*vector::borrow(&circle.rotation_order, 0) == bob, 0);
        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    // ----------------------------------------------------------
    // Circle-level compliance requirement tests
    // ----------------------------------------------------------

    #[test]
    fun test_requires_attestation_defaults_false_and_admin_can_enable() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        compliance::init_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        let cconfig = sui::test_scenario::take_shared<ComplianceConfig>(&scenario);
        assert!(!requires_attestation(&circle), 9400);
        assert!(option::is_none(&pinned_compliance_config_id(&circle)), 9402);
        set_requires_attestation(
            &mut circle, &cconfig, true, &clock, sui::test_scenario::ctx(&mut scenario)
        );
        assert!(requires_attestation(&circle), 9401);
        // Enabling pins the presented config's object id on the circle.
        let pin = pinned_compliance_config_id(&circle);
        assert!(option::is_some(&pin), 9403);
        assert!(*option::borrow(&pin) == object::id(&cconfig), 9404);
        sui::test_scenario::return_shared(cconfig);
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
        compliance::init_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        let cconfig = sui::test_scenario::take_shared<ComplianceConfig>(&scenario);
        set_requires_attestation(
            &mut circle, &cconfig, true, &clock, sui::test_scenario::ctx(&mut scenario)
        );
        // Members already joined: switching the promise off must abort.
        set_requires_attestation(
            &mut circle, &cconfig, false, &clock, sui::test_scenario::ctx(&mut scenario)
        );
        abort 0
    }

    #[test]
    fun test_requires_attestation_can_be_disabled_while_admin_is_sole_member() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        compliance::init_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        let cconfig = sui::test_scenario::take_shared<ComplianceConfig>(&scenario);
        set_requires_attestation(
            &mut circle, &cconfig, true, &clock, sui::test_scenario::ctx(&mut scenario)
        );
        assert!(requires_attestation(&circle), 9410);
        // Nobody else has joined yet, so the admin may still back out.
        set_requires_attestation(
            &mut circle, &cconfig, false, &clock, sui::test_scenario::ctx(&mut scenario)
        );
        assert!(!requires_attestation(&circle), 9411);
        // Disabling removes the pin too (pin present iff required).
        assert!(option::is_none(&pinned_compliance_config_id(&circle)), 9412);
        sui::test_scenario::return_shared(cconfig);
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
        compliance::init_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, @0xB);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        let cconfig = sui::test_scenario::take_shared<ComplianceConfig>(&scenario);
        set_requires_attestation(
            &mut circle, &cconfig, true, &clock, sui::test_scenario::ctx(&mut scenario)
        );
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
    fun test_derive_native_display_amounts_from_usd() {
        // At $2.50/SUI: $2.50 => 1 SUI, $5.00 => 2 SUI.
        let (contribution_native, security_deposit_native) = derive_native_display_amounts(250, 500, 250);
        assert!(contribution_native == 1_000_000_000, 9019);
        assert!(security_deposit_native == 2_000_000_000, 9020);
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

    // The tests above pin the PREDICATES. This one pins the ENFORCEMENT: that
    // the role resolver actually aborts for a caller the predicates reject,
    // rather than falling through to a permitted role.
    //
    // It matters because the admin exclusion cannot be observed on a live
    // circle within a test session. The minimum auto-release delay is longer
    // than one cycle (7 days for a weekly circle) and every signed admin
    // action refreshes the heartbeat, so reaching an armed fallback means a
    // week of admin silence. Simulating trigger_auto_release before then
    // returns ERecoveryExecutionNotReady — "nothing is armed" — which is a
    // correct refusal for the wrong reason and proves nothing about identity.
    // This test is therefore the authority for that claim.
    #[test]
    #[expected_failure(abort_code = ERecoveryAutoReleaseUnauthorized)]
    fun test_auto_release_rejects_admin_even_when_member_fallback_is_open() {
        // has_valid_delegate = false, caller_is_delegate = false,
        // caller_can_fallback = false (this is the admin — see
        // can_active_member_trigger_auto_release_internal(true, true) above),
        // member_fallback_open = true: everything armed, admin still refused.
        resolve_auto_release_trigger_role_internal(false, false, false, true);
    }

    #[test]
    #[expected_failure(abort_code = ERecoveryAutoReleaseUnauthorized)]
    fun test_auto_release_rejects_non_delegate_during_the_delegate_window() {
        // A valid delegate exists and the member-fallback window has not
        // opened yet, so an eligible member is still too early to act.
        resolve_auto_release_trigger_role_internal(true, false, true, false);
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

    // ----------------------------------------------------------
    // Mid-cycle migration
    //
    // A group that has been running offline arrives part-way through its
    // rotation. Declaring "positions 0..k already collected" writes those
    // members out of this round's payout queue, so these pin the two things
    // that keep it inside compliance invariant #1: it cannot touch a live
    // circle, and it does nothing until every member has ratified it.
    // ----------------------------------------------------------

    #[test_only]
    fun ack_migration_as(
        scenario: &mut sui::test_scenario::Scenario,
        who: address,
        version: u64,
        clock: &Clock
    ) {
        sui::test_scenario::next_tx(scenario, who);
        let mut circle = sui::test_scenario::take_shared<Circle>(scenario);
        acknowledge_migration_state(&mut circle, version, clock, sui::test_scenario::ctx(scenario));
        sui::test_scenario::return_shared(circle);
    }

    /// Rewinds the (active) test factory circle to the pre-activation shape a
    /// migrating group is actually in: not started, every deposit posted.
    #[test_only]
    fun prepare_for_migration(scenario: &mut sui::test_scenario::Scenario, admin: address) {
        sui::test_scenario::next_tx(scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(scenario);
        set_is_active_for_testing(&mut circle, false);
        mark_all_deposits_paid_for_testing(&mut circle);
        sui::test_scenario::return_shared(circle);
    }

    #[test]
    fun test_migration_activates_at_declared_position() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol, dave],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        // Two rounds finished offline; in this one admin and bob have already
        // collected, so carol's turn is next.
        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 2, 2, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        assert!(version == 1, 9500);
        assert!(!is_migration_ratified(&circle), 9501);
        sui::test_scenario::return_shared(circle);

        ack_migration_as(&mut scenario, admin, version, &clock);
        ack_migration_as(&mut scenario, bob, version, &clock);
        ack_migration_as(&mut scenario, carol, version, &clock);
        ack_migration_as(&mut scenario, dave, version, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        assert!(is_migration_ratified(&circle), 9502);
        assert!(get_migration_ack_count(&circle) == 4, 9503);
        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));

        // The circle resumes at carol, continues the group's round numbering,
        // and records the two members who already collected.
        assert!(get_current_position(&circle) == 2, 9504);
        assert!(get_current_cycle(&circle) == 3, 9505);
        let recipient = get_next_payout_recipient(&circle);
        assert!(option::is_some(&recipient), 9506);
        assert!(*option::borrow(&recipient) == carol, 9507);
        assert!(has_received_payout_for_testing(&circle, admin), 9508);
        assert!(has_received_payout_for_testing(&circle, bob), 9509);
        assert!(!has_received_payout_for_testing(&circle, carol), 9510);
        assert!(!has_received_payout_for_testing(&circle, dave), 9511);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EMigrationNotRatified)]
    fun test_activate_aborts_when_migration_not_ratified() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        sui::test_scenario::return_shared(circle);

        // Bob never confirms that admin already collected. The admin must not
        // be able to write off bob's turn alone.
        ack_migration_as(&mut scenario, admin, version, &clock);
        ack_migration_as(&mut scenario, carol, version, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EMigrationLedgerChanged)]
    fun test_ack_at_stale_version_aborts() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));
        let stale_version = get_migration_version(&circle);
        // The admin rewrites the ledger after bob read it.
        declare_migration_state(&mut circle, 0, 2, &clock, sui::test_scenario::ctx(&mut scenario));
        sui::test_scenario::return_shared(circle);

        // Bob confirms what he saw, not what is now on chain.
        ack_migration_as(&mut scenario, bob, stale_version, &clock);

        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_redeclaration_clears_prior_acks() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        sui::test_scenario::return_shared(circle);

        ack_migration_as(&mut scenario, admin, version, &clock);
        ack_migration_as(&mut scenario, bob, version, &clock);
        ack_migration_as(&mut scenario, carol, version, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        assert!(is_migration_ratified(&circle), 9520);

        // Changing the declared position must send everyone back to confirm.
        declare_migration_state(&mut circle, 0, 2, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(get_migration_version(&circle) == version + 1, 9521);
        assert!(get_migration_ack_count(&circle) == 0, 9522);
        assert!(!is_migration_ratified(&circle), 9523);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EMigrationRotationChanged)]
    fun test_reordering_after_confirmation_blocks_activation() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol, dave],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        // Everyone confirms that carol (position 2) is next.
        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 2, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        sui::test_scenario::return_shared(circle);

        ack_migration_as(&mut scenario, admin, version, &clock);
        ack_migration_as(&mut scenario, bob, version, &clock);
        ack_migration_as(&mut scenario, carol, version, &clock);
        ack_migration_as(&mut scenario, dave, version, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        assert!(is_migration_ratified(&circle), 9570);

        // The admin now swaps carol out of position 2. The confirmations still
        // stand, but they were given for a different queue — position 2 is
        // dave now, and activating here would hand him carol's turn.
        reorder_rotation_positions(
            &mut circle,
            vector[admin, bob, dave, carol],
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        assert!(is_migration_ratified(&circle), 9571); // still "ratified"...
        assert!(!migration_matches_rotation(&circle), 9572); // ...but stale

        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECircleIsActive)]
    fun test_declare_migration_blocked_while_active() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        // The factory circle is live. Rewriting where the rotation stands now
        // would redirect a cycle members may already have funded.
        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECircleIsActive)]
    fun test_activate_blocked_when_already_active() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        // Re-activating used to succeed silently, re-stamping current_cycle
        // and next_payout_time on a running circle.
        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EIncompleteRotationOrder)]
    fun test_declare_migration_requires_complete_rotation() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        config::set_max_members(&mut circle.id, 8);
        // Dave joins but has no rotation slot yet, so the positions the admin
        // is about to declare do not describe the whole circle.
        admin_approve_member(&mut circle, dave, &clock, sui::test_scenario::ctx(&mut scenario));
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 29)]
    fun test_declare_migration_rejects_out_of_range_position() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        // A three-member rotation has no position 3; a circle that has
        // finished its round is not mid-rotation, it is between rounds.
        declare_migration_state(&mut circle, 0, 3, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENothingToMigrate)]
    fun test_declare_migration_rejects_empty_history() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        // Position 0 with no prior rounds is an ordinary new circle; making a
        // ledger for it would demand ratification for nothing.
        declare_migration_state(&mut circle, 0, 0, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotMember)]
    fun test_non_member_cannot_acknowledge() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let stranger = @0xF;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        sui::test_scenario::return_shared(circle);

        ack_migration_as(&mut scenario, stranger, version, &clock);

        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = EMigrationAlreadyAcknowledged)]
    fun test_double_ack_aborts() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 1, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        sui::test_scenario::return_shared(circle);

        // One member must not be able to stand in for the quorum by confirming
        // repeatedly.
        ack_migration_as(&mut scenario, bob, version, &clock);
        ack_migration_as(&mut scenario, bob, version, &clock);

        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_clear_migration_state_removes_ledger() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 1, 1, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(has_migration_ledger(&circle), 9530);

        // Abandoning the migration leaves an ordinary circle that starts at
        // the top of its rotation.
        clear_migration_state(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(!has_migration_ledger(&circle), 9531);

        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(get_current_position(&circle) == 0, 9532);
        assert!(get_current_cycle(&circle) == 1, 9533);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_activate_without_ledger_is_unchanged() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));

        assert!(get_current_position(&circle) == 0, 9540);
        assert!(get_current_cycle(&circle) == 1, 9541);
        assert!(!has_received_payout_for_testing(&circle, admin), 9542);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_migrated_partial_round_pauses_then_resumes_full() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol, dave],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );
        prepare_for_migration(&mut scenario, admin);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        declare_migration_state(&mut circle, 0, 2, &clock, sui::test_scenario::ctx(&mut scenario));
        let version = get_migration_version(&circle);
        sui::test_scenario::return_shared(circle);

        ack_migration_as(&mut scenario, admin, version, &clock);
        ack_migration_as(&mut scenario, bob, version, &clock);
        ack_migration_as(&mut scenario, carol, version, &clock);
        ack_migration_as(&mut scenario, dave, version, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        activate_circle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));

        // The migrated round owes only the two turns that were still
        // outstanding, then the circle pauses like any completed round.
        advance_rotation_position_and_cycle(&mut circle, carol, &clock);
        assert!(get_current_position(&circle) == 3, 9550);
        assert!(!is_paused_after_cycle(&circle), 9551);

        advance_rotation_position_and_cycle(&mut circle, dave, &clock);
        assert!(is_paused_after_cycle(&circle), 9552);

        // From here it is an ordinary circle: a full round from the top with
        // everyone eligible again.
        resume_cycle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(get_current_position(&circle) == 0, 9553);
        assert!(get_current_cycle(&circle) == 2, 9554);
        assert!(!has_received_payout_for_testing(&circle, admin), 9555);
        assert!(!has_received_payout_for_testing(&circle, bob), 9556);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    // ----------------------------------------------------------
    // Approval lifecycle lock
    //
    // A member admitted mid-cycle gets no rotation slot, so the funding gate
    // and any open escrow snapshot cannot see them — yet they can still
    // contribute on the legacy rail, and cannot be given a position until the
    // circle pauses. These pin the lock that stops that ghost being created.
    // ----------------------------------------------------------

    #[test]
    #[expected_failure(abort_code = ECircleNotPausedForConfigChange)]
    fun test_approve_member_blocked_while_cycle_running() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        config::set_max_members(&mut circle.id, 8);
        admin_approve_member(&mut circle, dave, &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ECircleNotPausedForConfigChange)]
    fun test_approve_members_batch_blocked_while_cycle_running() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        config::set_max_members(&mut circle.id, 8);
        admin_approve_members(&mut circle, vector[dave], &clock, sui::test_scenario::ctx(&mut scenario));

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_approve_member_allowed_while_paused_between_cycles() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        config::set_max_members(&mut circle.id, 8);
        // Between rounds the rotation can still be edited, so a new member can
        // be given a position before the next round opens.
        set_paused_after_cycle_for_testing(&mut circle, true);
        admin_approve_member(&mut circle, dave, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(is_member(&circle, dave), 9560);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    // ----------------------------------------------------------
    // Security deposits persist across laps (resume_cycle liveness)
    //
    // Deposits are posted through the real entrypoint against a real custody
    // wallet, so every member starts exactly as a production member does:
    // deposit_paid = true and deposit_balance = the held amount.
    // ----------------------------------------------------------

    // share_circle_for_testing sets security_deposit = contribution / 2.
    #[test_only] const TEST_DEPOSIT_SUI: u64 = 500_000_000;

    #[test_only]
    fun share_circle_with_wallet_for_testing(
        scenario: &mut sui::test_scenario::Scenario,
        member_addrs: vector<address>,
        clock: &Clock
    ) {
        let circle_id = share_circle_for_testing(
            member_addrs,
            1_000_000_000,
            100,
            clock,
            sui::test_scenario::ctx(scenario)
        );
        custody::create_custody_wallet(
            circle_id,
            clock::timestamp_ms(clock),
            sui::test_scenario::ctx(scenario)
        );
    }

    #[test_only]
    fun deposit_sui_as(scenario: &mut sui::test_scenario::Scenario, who: address, clock: &Clock) {
        sui::test_scenario::next_tx(scenario, who);
        let mut circle = sui::test_scenario::take_shared<Circle>(scenario);
        let mut wallet = sui::test_scenario::take_shared<CustodyWallet>(scenario);
        let deposit = coin::mint_for_testing<SUI>(TEST_DEPOSIT_SUI, sui::test_scenario::ctx(scenario));
        legacy_deposit_for_testing<SUI>(
            &mut circle,
            &mut wallet,
            deposit,
            clock,
            sui::test_scenario::ctx(scenario)
        );
        sui::test_scenario::return_shared(circle);
        sui::test_scenario::return_shared(wallet);
    }

    #[test_only]
    fun assert_deposit_held(circle: &Circle, addr: address, code: u64) {
        let member = get_member(circle, addr);
        assert!(members::has_paid_deposit(member), code);
        assert!(members::get_deposit_balance(member) == TEST_DEPOSIT_SUI, code + 1);
    }

    #[test]
    fun test_resume_cycle_keeps_held_security_deposits() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_with_wallet_for_testing(&mut scenario, vector[admin, bob, carol], &clock);
        deposit_sui_as(&mut scenario, admin, &clock);
        deposit_sui_as(&mut scenario, bob, &clock);
        deposit_sui_as(&mut scenario, carol, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        assert_deposit_held(&circle, admin, 9600);
        assert_deposit_held(&circle, bob, 9602);
        assert_deposit_held(&circle, carol, 9604);

        // End of lap 1: the circle pauses, the admin resumes it.
        set_paused_after_cycle_for_testing(&mut circle, true);
        resume_cycle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(!is_paused_after_cycle(&circle), 9606);
        assert!(get_current_cycle(&circle) == 2, 9607);
        assert!(get_current_position(&circle) == 0, 9608);

        // Lap 2 starts with every deposit still held AND still recognised:
        // nobody is asked to post a deposit they cannot post.
        assert_deposit_held(&circle, admin, 9610);
        assert_deposit_held(&circle, bob, 9612);
        assert_deposit_held(&circle, carol, 9614);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    // The abort the live circle hit is the correct refusal of a DOUBLE
    // deposit; the fix is that resume no longer asks for one.
    #[test]
    #[expected_failure(abort_code = 21)]
    fun test_second_deposit_after_resume_is_refused_as_already_paid() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_with_wallet_for_testing(&mut scenario, vector[admin, bob, carol], &clock);
        deposit_sui_as(&mut scenario, admin, &clock);
        deposit_sui_as(&mut scenario, bob, &clock);
        deposit_sui_as(&mut scenario, carol, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        set_paused_after_cycle_for_testing(&mut circle, true);
        resume_cycle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));
        sui::test_scenario::return_shared(circle);

        deposit_sui_as(&mut scenario, bob, &clock);

        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    // The genuine re-deposit path: a member admitted between laps owes a
    // deposit and can post it after resume because their balance is 0.
    #[test]
    fun test_member_admitted_while_paused_deposits_after_resume() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let dave = @0xD;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_with_wallet_for_testing(&mut scenario, vector[admin, bob, carol], &clock);
        deposit_sui_as(&mut scenario, admin, &clock);
        deposit_sui_as(&mut scenario, bob, &clock);
        deposit_sui_as(&mut scenario, carol, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        config::set_max_members(&mut circle.id, 8);
        set_paused_after_cycle_for_testing(&mut circle, true);
        admin_approve_member(&mut circle, dave, &clock, sui::test_scenario::ctx(&mut scenario));
        assert!(!members::has_paid_deposit(get_member(&circle, dave)), 9620);
        assert!(members::get_deposit_balance(get_member(&circle, dave)) == 0, 9621);

        resume_cycle(&mut circle, &clock, sui::test_scenario::ctx(&mut scenario));
        // Resume leaves the newcomer's obligation in place ...
        assert!(!members::has_paid_deposit(get_member(&circle, dave)), 9622);
        sui::test_scenario::return_shared(circle);

        // ... and they can meet it, while everyone else's deposit is untouched.
        deposit_sui_as(&mut scenario, dave, &clock);

        sui::test_scenario::next_tx(&mut scenario, admin);
        let circle = sui::test_scenario::take_shared<Circle>(&scenario);
        assert_deposit_held(&circle, dave, 9624);
        assert_deposit_held(&circle, admin, 9626);
        assert_deposit_held(&circle, bob, 9628);
        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_reconcile_deposit_paid_restores_flag_for_held_deposit() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_with_wallet_for_testing(&mut scenario, vector[admin, bob, carol], &clock);
        deposit_sui_as(&mut scenario, admin, &clock);
        deposit_sui_as(&mut scenario, bob, &clock);
        deposit_sui_as(&mut scenario, carol, &clock);

        // Reproduce what the pre-fix resume_cycle left behind: flag cleared,
        // funds still held.
        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        members::set_deposit_paid(get_member_mut(&mut circle, bob), false);
        assert!(!members::has_paid_deposit(get_member(&circle, bob)), 9630);
        assert!(members::get_deposit_balance(get_member(&circle, bob)) == TEST_DEPOSIT_SUI, 9631);
        sui::test_scenario::return_shared(circle);

        // Anyone may repair it - here a non-admin member.
        sui::test_scenario::next_tx(&mut scenario, carol);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        reconcile_deposit_paid(&mut circle, bob, &clock);
        assert_deposit_held(&circle, bob, 9632);
        // Idempotent, and a no-op on members that were never affected.
        reconcile_deposit_paid(&mut circle, bob, &clock);
        reconcile_deposit_paid(&mut circle, admin, &clock);
        assert_deposit_held(&circle, bob, 9634);
        assert_deposit_held(&circle, admin, 9636);
        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    fun test_reconcile_deposit_paid_never_clears_flag_or_invents_a_deposit() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        // Flag set with nothing held (how a zero-deposit circle looks): kept.
        mark_all_deposits_paid_for_testing(&mut circle);
        reconcile_deposit_paid(&mut circle, bob, &clock);
        assert!(members::has_paid_deposit(get_member(&circle, bob)), 9640);
        assert!(members::get_deposit_balance(get_member(&circle, bob)) == 0, 9641);

        // Flag clear with nothing held (a member who still owes): kept clear.
        members::set_deposit_paid(get_member_mut(&mut circle, carol), false);
        reconcile_deposit_paid(&mut circle, carol, &clock);
        assert!(!members::has_paid_deposit(get_member(&circle, carol)), 9642);

        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = ENotMember)]
    fun test_reconcile_deposit_paid_rejects_non_member() {
        let admin = @0xA;
        let bob = @0xB;
        let carol = @0xC;
        let mut scenario = sui::test_scenario::begin(admin);
        let clock = clock::create_for_testing(sui::test_scenario::ctx(&mut scenario));
        share_circle_for_testing(
            vector[admin, bob, carol],
            1_000_000_000,
            100,
            &clock,
            sui::test_scenario::ctx(&mut scenario)
        );

        sui::test_scenario::next_tx(&mut scenario, admin);
        let mut circle = sui::test_scenario::take_shared<Circle>(&scenario);
        reconcile_deposit_paid(&mut circle, @0xDEAD, &clock);
        sui::test_scenario::return_shared(circle);
        clock::destroy_for_testing(clock);
        sui::test_scenario::end(scenario);
    }
}
