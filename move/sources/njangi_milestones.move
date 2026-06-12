module njangi::njangi_milestones {
    use std::ascii;
    use std::string::{Self, String};
    use std::type_name;

    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::table::{Self, Table};

    use njangi::njangi_core as core;
    use njangi::njangi_circles::{Self as circles, Circle};
    use njangi::njangi_cycle_escrow::{Self as escrow, CycleEscrow};

    // ----------------------------------------------------------
    // Circle smart-goals machinery (June 2026 completion of the old
    // half-built scaffolding; product decision 2026-06-12: circle-level
    // goals first).
    //
    // A `CircleMilestones<T>` shared object tracks an ordered list of
    // milestones for one circle, denominated in the base units of the
    // coin type `T` the circle's cycles settle in (SUI MIST for
    // `open_cycle`, stablecoin base units for `open_cycle_stable`).
    //
    //   * Creation: the circle admin defines ordered milestones
    //     (monetary cumulative targets or clock-time targets) before
    //     the rotation gets going; the definition locks permanently the
    //     moment any progress is recorded or any milestone completes.
    //   * Progress: permissionless. `record_cycle_progress` credits a
    //     settled (claimed) `CycleEscrow<T>` exactly once. The credited
    //     amount is read from the escrow's own frozen snapshot
    //     (contributors x per-member contribution = the pot that was
    //     actually paid in and redeemed), never from a caller-supplied
    //     number — so progress cannot be faked, and because only
    //     claimed escrows count it can never need reversal (refunds
    //     are impossible after redeem).
    //   * Completion: permissionless. Anyone may mark the next
    //     milestone complete once its condition is met on-chain;
    //     `MilestoneCompleted` fires per milestone and `GoalAchieved`
    //     fires when the final one completes (community celebration
    //     hook for the UI / WhatsApp notifier).
    //   * Verification: optional per milestone. A milestone created
    //     with `requires_verification` additionally needs the admin's
    //     one-time confirmation (members may anchor opaque proof bytes
    //     for the admin to review off-chain). The confirmation gates
    //     only the celebration flag — milestones observe funds, they
    //     never hold or move them, so the non-custodial invariant is
    //     untouched.
    // ----------------------------------------------------------

    // Error codes (400+ to avoid collisions with sibling modules:
    // escrow owns 200-233, compliance owns 300-306).
    const E_NOT_ADMIN: u64 = 400;
    const E_CIRCLE_MISMATCH: u64 = 401;
    const E_INVALID_MILESTONE_INDEX: u64 = 402;
    const E_DEFINITION_LOCKED: u64 = 403;
    const E_CYCLE_ALREADY_STARTED: u64 = 404;
    const E_TARGET_INVALID: u64 = 405;
    const E_TARGET_NOT_INCREASING: u64 = 406;
    const E_TOO_MANY_MILESTONES: u64 = 407;
    const E_ESCROW_NOT_SETTLED: u64 = 408;
    const E_ESCROW_ALREADY_CREDITED: u64 = 409;
    const E_OUT_OF_ORDER: u64 = 410;
    const E_TARGET_NOT_REACHED: u64 = 411;
    const E_VERIFICATION_REQUIRED: u64 = 412;
    const E_ALREADY_VERIFIED: u64 = 413;
    const E_VERIFICATION_NOT_REQUIRED: u64 = 414;
    const E_ALREADY_COMPLETED: u64 = 415;
    const E_NOT_MEMBER: u64 = 416;
    const E_PROOF_TOO_LARGE: u64 = 417;
    const E_TOO_MANY_PROOFS: u64 = 418;
    const E_AMOUNT_OVERFLOW: u64 = 419;
    const E_GOAL_NOT_CONFIGURED: u64 = 420;
    const E_DESCRIPTION_TOO_LONG: u64 = 421;

    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;
    /// Hard caps keep every loop in this module trivially bounded and
    /// the shared object small.
    const MAX_MILESTONES: u64 = 32;
    const MAX_PROOFS_PER_MILESTONE: u64 = 16;
    const MAX_PROOF_BYTES: u64 = 512;
    const MAX_DESCRIPTION_BYTES: u64 = 256;

    /// One step of the circle's goal. Exactly one of the two targets is
    /// meaningful, selected by `kind`:
    ///   * `core::milestone_type_monetary()` (0): `target_amount` is a
    ///     CUMULATIVE contribution total in base units of `T`; the
    ///     milestone is achievable once `cumulative_contributed`
    ///     reaches it.
    ///   * `core::milestone_type_time()` (1): `target_timestamp_ms` is
    ///     a Sui clock timestamp; the milestone is achievable once the
    ///     chain clock reaches it.
    /// Milestones complete strictly in index order (a later milestone
    /// whose condition is already true still waits for its
    /// predecessors), which is what makes the list "ordered".
    public struct Milestone has store, drop {
        kind: u8,
        target_amount: u64,        // base units of T; 0 for time milestones
        target_timestamp_ms: u64,  // clock ms; 0 for monetary milestones
        description: String,
        requires_verification: bool,
        verified_by: Option<address>,
        proofs: vector<vector<u8>>,
        completed: bool,
        completed_at_ms: u64,
        achieved_value: u64,       // cumulative (monetary) or timestamp (time)
    }

    /// Shared per-circle goal tracker. The phantom `T` pins the coin
    /// type progress is measured in: `record_cycle_progress` only
    /// accepts a `CycleEscrow<T>` of the same `T`, so SUI escrow pots
    /// can never be summed into a USDC-denominated goal (or vice
    /// versa). Purely observational — it holds no Balance and exposes
    /// no path that moves funds.
    public struct CircleMilestones<phantom T> has key {
        id: UID,
        circle_id: ID,
        milestones: vector<Milestone>,
        /// Index of the next milestone eligible for completion.
        /// Equals `milestones.length()` once the goal is achieved.
        next_to_complete: u64,
        /// Sum of every credited escrow pot, in base units of `T`.
        cumulative_contributed: u64,
        /// Escrows already credited, so each settled cycle counts
        /// exactly once no matter how many times the permissionless
        /// recorder is called.
        credited_escrows: Table<ID, bool>,
        /// Flips true on the first recorded progress or completed
        /// milestone and never resets: targets are immutable once the
        /// goal is in motion.
        locked: bool,
    }

    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------

    public struct MilestonesCreated has copy, drop {
        circle_id: ID,
        milestones_id: ID,
        /// Canonical type bytes of `T` so indexers know the unit
        /// without parsing the object type tag.
        asset_type: vector<u8>,
    }

    public struct MilestoneAdded has copy, drop {
        circle_id: ID,
        milestones_id: ID,
        milestone_index: u64,
        kind: u8,
        target_amount: u64,
        target_timestamp_ms: u64,
        requires_verification: bool,
    }

    public struct GoalProgressUpdated has copy, drop {
        circle_id: ID,
        milestones_id: ID,
        escrow_id: ID,
        cycle_no: u64,
        amount_credited: u64,
        cumulative_contributed: u64,
    }

    public struct MilestoneProofSubmitted has copy, drop {
        circle_id: ID,
        milestone_index: u64,
        submitted_by: address,
        proof_index: u64,
    }

    public struct MilestoneVerified has copy, drop {
        circle_id: ID,
        milestone_index: u64,
        verified_by: address,
    }

    public struct MilestoneCompleted has copy, drop {
        circle_id: ID,
        milestone_index: u64,
        kind: u8,
        achieved_value: u64,
        completed_at_ms: u64,
        completed_by: address,
    }

    /// Fires exactly once, when the final milestone completes — the
    /// community celebration hook for the UI / WhatsApp notifier.
    public struct GoalAchieved has copy, drop {
        circle_id: ID,
        milestones_id: ID,
        milestone_count: u64,
        achieved_at_ms: u64,
    }

    // ----------------------------------------------------------
    // Creation (admin, before the rotation gets going)
    // ----------------------------------------------------------

    /// Creates and shares the goal tracker for a smart-goal circle.
    /// Admin-only; the circle must carry a configured goal_type (set at
    /// circle creation from njangi_circle_config's smart-goal params)
    /// and must not have settled a cycle yet (`current_cycle` advances
    /// past 1 on the first settled payout). Expected to be created once
    /// per circle; the UI should treat the first `MilestonesCreated`
    /// event for a circle as canonical.
    public fun create_circle_milestones<T>(
        circle: &Circle,
        ctx: &mut TxContext
    ) {
        assert_admin(circle, ctx);
        assert!(circles::has_goal_type(circle), E_GOAL_NOT_CONFIGURED);
        assert_rotation_not_started(circle);

        let circle_id = circles::get_id(circle);
        let tracker = CircleMilestones<T> {
            id: object::new(ctx),
            circle_id,
            milestones: vector::empty(),
            next_to_complete: 0,
            cumulative_contributed: 0,
            credited_escrows: table::new<ID, bool>(ctx),
            locked: false,
        };

        event::emit(MilestonesCreated {
            circle_id,
            milestones_id: object::uid_to_inner(&tracker.id),
            asset_type: canonical_type_bytes<T>(),
        });

        transfer::share_object(tracker);
    }

    /// Appends a monetary milestone: achieved once the circle's
    /// cumulative settled contributions (base units of `T`) reach
    /// `target_amount`. Targets are cumulative, so each must strictly
    /// exceed the previous monetary milestone's target.
    public fun add_monetary_milestone<T>(
        tracker: &mut CircleMilestones<T>,
        circle: &Circle,
        target_amount: u64,
        description: vector<u8>,
        requires_verification: bool,
        ctx: &mut TxContext
    ) {
        assert_admin(circle, ctx);
        assert_same_circle(tracker, circle);
        assert_definition_open(tracker, circle);
        assert!(target_amount > 0, E_TARGET_INVALID);
        assert!(
            target_amount > last_target_of_kind(tracker, core::milestone_type_monetary()),
            E_TARGET_NOT_INCREASING
        );

        push_milestone(
            tracker,
            core::milestone_type_monetary(),
            target_amount,
            0,
            description,
            requires_verification
        );
    }

    /// Appends a time milestone: achieved once the chain clock reaches
    /// `target_timestamp_ms`. Must lie in the future and after the
    /// previous time milestone's target.
    public fun add_time_milestone<T>(
        tracker: &mut CircleMilestones<T>,
        circle: &Circle,
        target_timestamp_ms: u64,
        description: vector<u8>,
        requires_verification: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert_admin(circle, ctx);
        assert_same_circle(tracker, circle);
        assert_definition_open(tracker, circle);
        assert!(target_timestamp_ms > clock::timestamp_ms(clock), E_TARGET_INVALID);
        assert!(
            target_timestamp_ms > last_target_of_kind(tracker, core::milestone_type_time()),
            E_TARGET_NOT_INCREASING
        );

        push_milestone(
            tracker,
            core::milestone_type_time(),
            0,
            target_timestamp_ms,
            description,
            requires_verification
        );
    }

    fun push_milestone<T>(
        tracker: &mut CircleMilestones<T>,
        kind: u8,
        target_amount: u64,
        target_timestamp_ms: u64,
        description: vector<u8>,
        requires_verification: bool
    ) {
        assert!(vector::length(&tracker.milestones) < MAX_MILESTONES, E_TOO_MANY_MILESTONES);
        assert!(vector::length(&description) <= MAX_DESCRIPTION_BYTES, E_DESCRIPTION_TOO_LONG);

        let milestone_index = vector::length(&tracker.milestones);
        vector::push_back(&mut tracker.milestones, Milestone {
            kind,
            target_amount,
            target_timestamp_ms,
            description: string::utf8(description),
            requires_verification,
            verified_by: option::none(),
            proofs: vector::empty(),
            completed: false,
            completed_at_ms: 0,
            achieved_value: 0,
        });

        event::emit(MilestoneAdded {
            circle_id: tracker.circle_id,
            milestones_id: object::uid_to_inner(&tracker.id),
            milestone_index,
            kind,
            target_amount,
            target_timestamp_ms,
            requires_verification,
        });
    }

    // ----------------------------------------------------------
    // Progress (permissionless, derived from settled escrows)
    // ----------------------------------------------------------

    /// Credits one settled per-cycle escrow into the goal's cumulative
    /// progress. Permissionless: anyone may pay the gas. Unfakeable by
    /// construction:
    ///   * the escrow object can only be created by
    ///     `njangi_cycle_escrow::open_cycle*`, which snapshots the
    ///     circle's own trustless contribution amount;
    ///   * it must belong to THIS circle (`E_CIRCLE_MISMATCH`);
    ///   * it must be CLAIMED — the recipient actually redeemed the pot
    ///     (`E_ESCROW_NOT_SETTLED`). A claimed escrow can never be
    ///     refunded, so `contributors_count` and the per-member amount
    ///     are frozen and the credited pot is exactly the money that
    ///     moved;
    ///   * each escrow credits exactly once (`E_ESCROW_ALREADY_CREDITED`).
    /// No amount is ever supplied by the caller.
    public fun record_cycle_progress<T>(
        tracker: &mut CircleMilestones<T>,
        settled: &CycleEscrow<T>,
    ) {
        assert!(escrow::circle_id(settled) == tracker.circle_id, E_CIRCLE_MISMATCH);
        assert!(escrow::is_claimed(settled), E_ESCROW_NOT_SETTLED);

        let escrow_id = object::id(settled);
        assert!(!table::contains(&tracker.credited_escrows, escrow_id), E_ESCROW_ALREADY_CREDITED);

        // The pot the recipient redeemed: every recorded contributor
        // paid exactly the snapshot's per-member amount, and after a
        // claim neither value can ever change again.
        let contributors = escrow::contributor_count(settled);
        let per_contribution = escrow::contribution_amount(settled);
        assert!(
            per_contribution == 0 || contributors <= MAX_U64 / per_contribution,
            E_AMOUNT_OVERFLOW
        );
        let pot = contributors * per_contribution;
        assert!(tracker.cumulative_contributed <= MAX_U64 - pot, E_AMOUNT_OVERFLOW);

        table::add(&mut tracker.credited_escrows, escrow_id, true);
        tracker.cumulative_contributed = tracker.cumulative_contributed + pot;
        // First real progress freezes the milestone definition.
        tracker.locked = true;

        event::emit(GoalProgressUpdated {
            circle_id: tracker.circle_id,
            milestones_id: object::uid_to_inner(&tracker.id),
            escrow_id,
            cycle_no: escrow::cycle_no(settled),
            amount_credited: pot,
            cumulative_contributed: tracker.cumulative_contributed,
        });
    }

    // ----------------------------------------------------------
    // Verification (optional, per milestone)
    // ----------------------------------------------------------

    /// Anchors opaque proof bytes (e.g. the hash of an off-chain
    /// document) on a verification-gated milestone for the admin to
    /// review. Member-initiated; bounded in count and size.
    public fun submit_milestone_proof<T>(
        tracker: &mut CircleMilestones<T>,
        circle: &Circle,
        milestone_index: u64,
        proof: vector<u8>,
        ctx: &TxContext
    ) {
        assert_same_circle(tracker, circle);
        let sender = tx_context::sender(ctx);
        assert!(circles::is_member(circle, sender), E_NOT_MEMBER);
        assert!(milestone_index < vector::length(&tracker.milestones), E_INVALID_MILESTONE_INDEX);
        assert!(vector::length(&proof) <= MAX_PROOF_BYTES, E_PROOF_TOO_LARGE);

        let milestone = vector::borrow_mut(&mut tracker.milestones, milestone_index);
        assert!(milestone.requires_verification, E_VERIFICATION_NOT_REQUIRED);
        assert!(!milestone.completed, E_ALREADY_COMPLETED);
        assert!(vector::length(&milestone.proofs) < MAX_PROOFS_PER_MILESTONE, E_TOO_MANY_PROOFS);

        vector::push_back(&mut milestone.proofs, proof);
        let proof_index = vector::length(&milestone.proofs) - 1;

        event::emit(MilestoneProofSubmitted {
            circle_id: tracker.circle_id,
            milestone_index,
            submitted_by: sender,
            proof_index,
        });
    }

    /// Admin's one-time confirmation of a verification-gated milestone.
    /// This gates ONLY the completion flag (a celebration marker) — it
    /// moves no funds, so it does not violate the non-custodial
    /// invariant. Milestones without `requires_verification` are fully
    /// automatic and never pass through here.
    public fun verify_milestone<T>(
        tracker: &mut CircleMilestones<T>,
        circle: &Circle,
        milestone_index: u64,
        ctx: &TxContext
    ) {
        assert_admin(circle, ctx);
        assert_same_circle(tracker, circle);
        assert!(milestone_index < vector::length(&tracker.milestones), E_INVALID_MILESTONE_INDEX);

        let milestone = vector::borrow_mut(&mut tracker.milestones, milestone_index);
        assert!(milestone.requires_verification, E_VERIFICATION_NOT_REQUIRED);
        assert!(option::is_none(&milestone.verified_by), E_ALREADY_VERIFIED);
        assert!(!milestone.completed, E_ALREADY_COMPLETED);

        let admin = tx_context::sender(ctx);
        milestone.verified_by = option::some(admin);

        event::emit(MilestoneVerified {
            circle_id: tracker.circle_id,
            milestone_index,
            verified_by: admin,
        });
    }

    // ----------------------------------------------------------
    // Completion (permissionless, condition asserted on-chain)
    // ----------------------------------------------------------

    /// Marks the next milestone complete. Anyone may call; the
    /// milestone's condition is asserted against on-chain state (the
    /// cumulative credited contributions, or the chain clock), so the
    /// caller contributes nothing but gas. Milestones complete strictly
    /// in index order. Completing the final milestone additionally
    /// emits `GoalAchieved`.
    public fun complete_milestone<T>(
        tracker: &mut CircleMilestones<T>,
        milestone_index: u64,
        clock: &Clock,
        ctx: &TxContext
    ) {
        let len = vector::length(&tracker.milestones);
        assert!(milestone_index < len, E_INVALID_MILESTONE_INDEX);
        assert!(milestone_index == tracker.next_to_complete, E_OUT_OF_ORDER);

        let now = clock::timestamp_ms(clock);
        let cumulative = tracker.cumulative_contributed;

        let milestone = vector::borrow_mut(&mut tracker.milestones, milestone_index);
        if (milestone.requires_verification) {
            assert!(option::is_some(&milestone.verified_by), E_VERIFICATION_REQUIRED);
        };

        let achieved_value: u64;
        if (milestone.kind == core::milestone_type_monetary()) {
            assert!(cumulative >= milestone.target_amount, E_TARGET_NOT_REACHED);
            achieved_value = cumulative;
        } else {
            // Adds only ever create the two known kinds; assert anyway
            // so a future kind can't silently fall into time semantics.
            assert!(milestone.kind == core::milestone_type_time(), E_TARGET_INVALID);
            assert!(now >= milestone.target_timestamp_ms, E_TARGET_NOT_REACHED);
            achieved_value = now;
        };

        milestone.completed = true;
        milestone.completed_at_ms = now;
        milestone.achieved_value = achieved_value;
        let kind = milestone.kind;

        tracker.next_to_complete = milestone_index + 1;
        // A completed milestone also freezes the definition (covers
        // time milestones that complete before any monetary progress).
        tracker.locked = true;

        event::emit(MilestoneCompleted {
            circle_id: tracker.circle_id,
            milestone_index,
            kind,
            achieved_value,
            completed_at_ms: now,
            completed_by: tx_context::sender(ctx),
        });

        if (tracker.next_to_complete == len) {
            event::emit(GoalAchieved {
                circle_id: tracker.circle_id,
                milestones_id: object::uid_to_inner(&tracker.id),
                milestone_count: len,
                achieved_at_ms: now,
            });
        };
    }

    // ----------------------------------------------------------
    // Read accessors (indexers + frontend)
    // ----------------------------------------------------------

    public fun circle_id<T>(tracker: &CircleMilestones<T>): ID { tracker.circle_id }
    public fun milestone_count<T>(tracker: &CircleMilestones<T>): u64 {
        vector::length(&tracker.milestones)
    }
    public fun next_to_complete<T>(tracker: &CircleMilestones<T>): u64 {
        tracker.next_to_complete
    }
    public fun cumulative_contributed<T>(tracker: &CircleMilestones<T>): u64 {
        tracker.cumulative_contributed
    }
    public fun is_locked<T>(tracker: &CircleMilestones<T>): bool { tracker.locked }
    public fun is_goal_achieved<T>(tracker: &CircleMilestones<T>): bool {
        let len = vector::length(&tracker.milestones);
        len > 0 && tracker.next_to_complete == len
    }
    public fun has_credited_escrow<T>(tracker: &CircleMilestones<T>, escrow_id: ID): bool {
        table::contains(&tracker.credited_escrows, escrow_id)
    }

    public fun milestone_kind<T>(tracker: &CircleMilestones<T>, milestone_index: u64): u8 {
        borrow_milestone(tracker, milestone_index).kind
    }
    public fun milestone_target_amount<T>(tracker: &CircleMilestones<T>, milestone_index: u64): u64 {
        borrow_milestone(tracker, milestone_index).target_amount
    }
    public fun milestone_target_timestamp_ms<T>(tracker: &CircleMilestones<T>, milestone_index: u64): u64 {
        borrow_milestone(tracker, milestone_index).target_timestamp_ms
    }
    public fun milestone_description<T>(tracker: &CircleMilestones<T>, milestone_index: u64): String {
        borrow_milestone(tracker, milestone_index).description
    }
    public fun milestone_requires_verification<T>(tracker: &CircleMilestones<T>, milestone_index: u64): bool {
        borrow_milestone(tracker, milestone_index).requires_verification
    }
    public fun milestone_verified_by<T>(tracker: &CircleMilestones<T>, milestone_index: u64): Option<address> {
        borrow_milestone(tracker, milestone_index).verified_by
    }
    public fun is_milestone_completed<T>(tracker: &CircleMilestones<T>, milestone_index: u64): bool {
        borrow_milestone(tracker, milestone_index).completed
    }
    public fun milestone_completed_at_ms<T>(tracker: &CircleMilestones<T>, milestone_index: u64): u64 {
        borrow_milestone(tracker, milestone_index).completed_at_ms
    }
    public fun milestone_achieved_value<T>(tracker: &CircleMilestones<T>, milestone_index: u64): u64 {
        borrow_milestone(tracker, milestone_index).achieved_value
    }
    public fun milestone_proof_count<T>(tracker: &CircleMilestones<T>, milestone_index: u64): u64 {
        vector::length(&borrow_milestone(tracker, milestone_index).proofs)
    }

    // ----------------------------------------------------------
    // Internal helpers
    // ----------------------------------------------------------

    fun assert_admin(circle: &Circle, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), E_NOT_ADMIN);
    }

    fun assert_same_circle<T>(tracker: &CircleMilestones<T>, circle: &Circle) {
        assert!(tracker.circle_id == circles::get_id(circle), E_CIRCLE_MISMATCH);
    }

    /// Milestones may be defined at or after circle creation, but only
    /// until (a) any progress is recorded / any milestone completes
    /// (`locked`, the load-bearing guarantee that targets never move
    /// under recorded progress), or (b) the circle settles its first
    /// payout (see `assert_rotation_not_started`).
    fun assert_definition_open<T>(tracker: &CircleMilestones<T>, circle: &Circle) {
        assert!(!tracker.locked, E_DEFINITION_LOCKED);
        assert_rotation_not_started(circle);
    }

    /// True only while no payout has ever settled: `current_cycle` is 0
    /// before activation and 1 during the whole first rotation (it only
    /// advances when a full rotation completes and resumes), so the
    /// rotation position — which `advance_circle_after_claim` bumps on
    /// every settled payout — and the end-of-rotation pause flag are
    /// what actually detect "the cycle has started".
    fun assert_rotation_not_started(circle: &Circle) {
        assert!(
            circles::get_current_cycle(circle) <= 1
                && circles::get_current_position(circle) == 0
                && !circles::is_paused_after_cycle(circle),
            E_CYCLE_ALREADY_STARTED
        );
    }

    /// Largest (== most recently added, since adds enforce monotonic
    /// growth) target among milestones of `kind`; 0 when none exist.
    fun last_target_of_kind<T>(tracker: &CircleMilestones<T>, kind: u8): u64 {
        let mut last = 0u64;
        let mut i = 0;
        let len = vector::length(&tracker.milestones);
        while (i < len) {
            let milestone = vector::borrow(&tracker.milestones, i);
            if (milestone.kind == kind) {
                last = if (kind == core::milestone_type_monetary()) {
                    milestone.target_amount
                } else {
                    milestone.target_timestamp_ms
                };
            };
            i = i + 1;
        };
        last
    }

    fun borrow_milestone<T>(tracker: &CircleMilestones<T>, milestone_index: u64): &Milestone {
        assert!(milestone_index < vector::length(&tracker.milestones), E_INVALID_MILESTONE_INDEX);
        vector::borrow(&tracker.milestones, milestone_index)
    }

    fun canonical_type_bytes<T>(): vector<u8> {
        ascii::into_bytes(type_name::into_string(type_name::get<T>()))
    }

    // ----------------------------------------------------------
    // Tests
    // ----------------------------------------------------------

    #[test_only] use sui::test_scenario as ts;
    #[test_only] use sui::coin;
    #[test_only] use sui::sui::SUI;

    #[test_only] const TEST_ADMIN: address = @0xA11CE;
    #[test_only] const TEST_BOB: address = @0xB0B;
    #[test_only] const TEST_CAROL: address = @0xCA801;
    #[test_only] const TEST_OUTSIDER: address = @0xDEAD;
    #[test_only] const TEST_CONTRIBUTION: u64 = 1_000_000_000; // 1 SUI
    #[test_only] const TEST_USD_CENTS: u64 = 250;
    #[test_only] const TEST_START_MS: u64 = 1_000_000;
    #[test_only] const TEST_30_DAYS_MS: u64 = 2_592_000_000;
    #[test_only] const TEST_GOAL_TYPE_AMOUNT: u8 = 0; // matches frontend GOAL_TYPE_AMOUNT

    /// tx1: share a 3-member active circle (admin = rotation position 0
    /// = first recipient); tx2 (admin): mark it a smart-goal circle and
    /// create the SUI goal tracker. Returns (clock, circle_id,
    /// tracker_id).
    #[test_only]
    fun setup_goal_circle(scenario: &mut ts::Scenario): (Clock, ID, ID) {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        let circle_id = circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(scenario)
        );

        ts::next_tx(scenario, TEST_ADMIN);
        let mut circle = ts::take_shared_by_id<Circle>(scenario, circle_id);
        circles::set_goal_type_for_testing(
            &mut circle, TEST_GOAL_TYPE_AMOUNT, 4 * TEST_CONTRIBUTION
        );
        create_circle_milestones<SUI>(&circle, ts::ctx(scenario));
        ts::return_shared(circle);

        ts::next_tx(scenario, TEST_ADMIN);
        let tracker_id = option::destroy_some(
            ts::most_recent_id_shared<CircleMilestones<SUI>>()
        );
        (clock, circle_id, tracker_id)
    }

    #[test_only]
    fun add_monetary_as_admin(
        scenario: &mut ts::Scenario,
        tracker_id: ID,
        circle_id: ID,
        target: u64,
        requires_verification: bool
    ) {
        ts::next_tx(scenario, TEST_ADMIN);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(scenario, circle_id);
        add_monetary_milestone(
            &mut tracker, &circle, target, b"save up", requires_verification,
            ts::ctx(scenario)
        );
        ts::return_shared(circle);
        ts::return_shared(tracker);
    }

    /// Runs one full real escrow cycle: open (snapshot from the
    /// circle), each contributor pays the exact snapshot amount, the
    /// scheduled recipient finalizes + redeems. Returns the escrow id.
    #[test_only]
    fun settle_cycle(
        scenario: &mut ts::Scenario,
        clock: &Clock,
        circle_id: ID,
        contributors: vector<address>,
        recipient: address
    ): ID {
        ts::next_tx(scenario, recipient);
        let circle = ts::take_shared_by_id<Circle>(scenario, circle_id);
        escrow::open_cycle<SUI>(&circle, clock, ts::ctx(scenario));
        ts::return_shared(circle);

        ts::next_tx(scenario, recipient);
        let escrow_id = option::destroy_some(
            ts::most_recent_id_shared<CycleEscrow<SUI>>()
        );

        let mut i = 0;
        while (i < vector::length(&contributors)) {
            let who = *vector::borrow(&contributors, i);
            ts::next_tx(scenario, who);
            let mut esc = ts::take_shared_by_id<CycleEscrow<SUI>>(scenario, escrow_id);
            let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(scenario));
            escrow::contribute(&mut esc, payment, ts::ctx(scenario));
            ts::return_shared(esc);
            i = i + 1;
        };

        ts::next_tx(scenario, recipient);
        let mut esc = ts::take_shared_by_id<CycleEscrow<SUI>>(scenario, escrow_id);
        escrow::finalize_and_redeem(&mut esc, clock, ts::ctx(scenario));
        ts::return_shared(esc);
        escrow_id
    }

    #[test_only]
    fun record_progress_as(
        scenario: &mut ts::Scenario,
        who: address,
        tracker_id: ID,
        escrow_id: ID
    ) {
        ts::next_tx(scenario, who);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(scenario, tracker_id);
        let esc = ts::take_shared_by_id<CycleEscrow<SUI>>(scenario, escrow_id);
        record_cycle_progress(&mut tracker, &esc);
        ts::return_shared(esc);
        ts::return_shared(tracker);
    }

    #[test_only]
    fun complete_as(
        scenario: &mut ts::Scenario,
        who: address,
        tracker_id: ID,
        milestone_index: u64,
        clock: &Clock
    ) {
        ts::next_tx(scenario, who);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(scenario, tracker_id);
        complete_milestone(&mut tracker, milestone_index, clock, ts::ctx(scenario));
        ts::return_shared(tracker);
    }

    #[test_only]
    fun advance_after_claim_as(
        scenario: &mut ts::Scenario,
        who: address,
        clock: &Clock,
        circle_id: ID,
        escrow_id: ID
    ) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared_by_id<Circle>(scenario, circle_id);
        let esc = ts::take_shared_by_id<CycleEscrow<SUI>>(scenario, escrow_id);
        escrow::advance_circle_after_claim(&mut circle, &esc, clock, ts::ctx(scenario));
        ts::return_shared(esc);
        ts::return_shared(circle);
    }

    // --- creation validation -----------------------------------------

    #[test]
    fun test_create_and_add_ordered_milestones() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 4 * TEST_CONTRIBUTION, false);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        add_time_milestone(
            &mut tracker, &circle, TEST_START_MS + TEST_30_DAYS_MS, b"keep going",
            false, &clock, ts::ctx(&mut scenario)
        );
        assert!(milestone_count(&tracker) == 3, 9300);
        assert!(next_to_complete(&tracker) == 0, 9301);
        assert!(cumulative_contributed(&tracker) == 0, 9302);
        assert!(!is_locked(&tracker), 9303);
        assert!(!is_goal_achieved(&tracker), 9304);
        assert!(milestone_kind(&tracker, 0) == core::milestone_type_monetary(), 9305);
        assert!(milestone_target_amount(&tracker, 1) == 4 * TEST_CONTRIBUTION, 9306);
        assert!(milestone_kind(&tracker, 2) == core::milestone_type_time(), 9307);
        assert!(milestone_target_timestamp_ms(&tracker, 2) == TEST_START_MS + TEST_30_DAYS_MS, 9308);
        ts::return_shared(tracker);
        ts::return_shared(circle);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_ADMIN)]
    fun test_create_requires_admin() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        let circle_id = circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION, TEST_USD_CENTS, &clock, ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        circles::set_goal_type_for_testing(
            &mut circle, TEST_GOAL_TYPE_AMOUNT, 4 * TEST_CONTRIBUTION
        );
        create_circle_milestones<SUI>(&circle, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_GOAL_NOT_CONFIGURED)]
    fun test_create_requires_goal_type() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        let circle_id = circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION, TEST_USD_CENTS, &clock, ts::ctx(&mut scenario)
        );

        // The factory leaves goal_type unset: not a smart-goal circle.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        create_circle_milestones<SUI>(&circle, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_ADMIN)]
    fun test_add_requires_admin() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (_clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        add_monetary_milestone(
            &mut tracker, &circle, TEST_CONTRIBUTION, b"x", false, ts::ctx(&mut scenario)
        );
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_TARGET_INVALID)]
    fun test_add_zero_monetary_target_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (_clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 0, false);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_TARGET_NOT_INCREASING)]
    fun test_add_non_increasing_monetary_target_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (_clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);
        // Equal to the previous target: cumulative targets must grow.
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_TARGET_INVALID)]
    fun test_add_past_time_target_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        // Exactly "now" is not in the future.
        add_time_milestone(
            &mut tracker, &circle, TEST_START_MS, b"x", false, &clock,
            ts::ctx(&mut scenario)
        );
        abort 0
    }

    // --- progress from real contributions ----------------------------

    #[test]
    fun test_progress_derives_from_settled_escrow() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);

        // Real cycle: BOB + CAROL pay 1 SUI each, ADMIN redeems the pot.
        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );

        // Anyone records the settled cycle; the credited amount comes
        // from the escrow snapshot, not the caller.
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        assert!(cumulative_contributed(&tracker) == 2 * TEST_CONTRIBUTION, 9310);
        assert!(has_credited_escrow(&tracker, escrow_id), 9311);
        assert!(is_locked(&tracker), 9312);
        ts::return_shared(tracker);

        // Target reached: anyone completes the milestone.
        complete_as(&mut scenario, TEST_BOB, tracker_id, 0, &clock);

        // events_by_type is scoped to the in-flight transaction, so
        // check before the next next_tx.
        let completed_events = event::events_by_type<MilestoneCompleted>();
        assert!(vector::length(&completed_events) == 1, 9316);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        assert!(is_milestone_completed(&tracker, 0), 9313);
        assert!(milestone_achieved_value(&tracker, 0) == 2 * TEST_CONTRIBUTION, 9314);
        assert!(is_goal_achieved(&tracker), 9315);
        ts::return_shared(tracker);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // --- cannot fake progress ----------------------------------------

    #[test]
    #[expected_failure(abort_code = E_ESCROW_NOT_SETTLED)]
    fun test_unsettled_escrow_cannot_be_recorded() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);

        // Open + contribute, but never finalize/redeem: not settled.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        escrow::open_cycle<SUI>(&circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);

        ts::next_tx(&mut scenario, TEST_BOB);
        let escrow_id = option::destroy_some(
            ts::most_recent_id_shared<CycleEscrow<SUI>>()
        );
        let mut esc = ts::take_shared_by_id<CycleEscrow<SUI>>(&scenario, escrow_id);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(&mut scenario));
        escrow::contribute(&mut esc, payment, ts::ctx(&mut scenario));
        ts::return_shared(esc);

        record_progress_as(&mut scenario, TEST_BOB, tracker_id, escrow_id);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ESCROW_ALREADY_CREDITED)]
    fun test_settled_escrow_credits_only_once() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);

        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);
        // Replaying the same settled escrow must not double-count.
        record_progress_as(&mut scenario, TEST_BOB, tracker_id, escrow_id);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_CIRCLE_MISMATCH)]
    fun test_foreign_circle_escrow_cannot_be_recorded() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, _circle_id, tracker_id) = setup_goal_circle(&mut scenario);

        // A second, unrelated circle settles a perfectly real cycle...
        let other_circle_id = circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION, TEST_USD_CENTS, &clock, ts::ctx(&mut scenario)
        );
        let other_escrow_id = settle_cycle(
            &mut scenario, &clock, other_circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );

        // ...which must not count toward THIS circle's goal.
        record_progress_as(&mut scenario, TEST_BOB, tracker_id, other_escrow_id);
        abort 0
    }

    // --- completion asserts -------------------------------------------

    #[test]
    #[expected_failure(abort_code = E_TARGET_NOT_REACHED)]
    fun test_complete_below_target_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        // Target needs two settled cycles; only one settles.
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 4 * TEST_CONTRIBUTION, false);
        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);
        complete_as(&mut scenario, TEST_BOB, tracker_id, 0, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_OUT_OF_ORDER)]
    fun test_complete_out_of_order_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 4 * TEST_CONTRIBUTION, false);

        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);
        // Milestone 0 is still open: 1 must wait its turn.
        complete_as(&mut scenario, TEST_BOB, tracker_id, 1, &clock);
        abort 0
    }

    #[test]
    fun test_time_milestone_completes_at_target() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (mut clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        add_time_milestone(
            &mut tracker, &circle, TEST_START_MS + TEST_30_DAYS_MS, b"30 days saved",
            false, &clock, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);
        ts::return_shared(tracker);

        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_30_DAYS_MS);
        complete_as(&mut scenario, TEST_CAROL, tracker_id, 0, &clock);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        assert!(is_milestone_completed(&tracker, 0), 9320);
        assert!(milestone_achieved_value(&tracker, 0) == TEST_START_MS + TEST_30_DAYS_MS, 9321);
        assert!(is_goal_achieved(&tracker), 9322);
        ts::return_shared(tracker);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_TARGET_NOT_REACHED)]
    fun test_time_milestone_before_target_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (mut clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        add_time_milestone(
            &mut tracker, &circle, TEST_START_MS + TEST_30_DAYS_MS, b"x",
            false, &clock, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);
        ts::return_shared(tracker);

        // One millisecond early.
        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_30_DAYS_MS - 1);
        complete_as(&mut scenario, TEST_CAROL, tracker_id, 0, &clock);
        abort 0
    }

    // --- definition freezing ------------------------------------------

    #[test]
    #[expected_failure(abort_code = E_DEFINITION_LOCKED)]
    fun test_add_after_recorded_progress_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);

        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);

        // Targets are frozen once real progress exists.
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 4 * TEST_CONTRIBUTION, false);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_CYCLE_ALREADY_STARTED)]
    fun test_add_after_first_settled_cycle_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);

        // Settle cycle 1 and rotate; current_cycle moves past 1, but the
        // tracker never recorded progress so `locked` is still false.
        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        advance_after_claim_as(&mut scenario, TEST_CAROL, &clock, circle_id, escrow_id);

        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);
        abort 0
    }

    // --- GoalAchieved on the final milestone --------------------------

    #[test]
    fun test_goal_achieved_on_final_milestone() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 4 * TEST_CONTRIBUTION, false);

        // Cycle 1: ADMIN receives, BOB + CAROL pay in.
        let escrow1 = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow1);
        complete_as(&mut scenario, TEST_BOB, tracker_id, 0, &clock);

        // events_by_type is scoped to the in-flight transaction: the
        // intermediate milestone fires MilestoneCompleted but must NOT
        // fire GoalAchieved.
        assert!(vector::length(&event::events_by_type<MilestoneCompleted>()) == 1, 9330);
        assert!(vector::length(&event::events_by_type<GoalAchieved>()) == 0, 9335);

        // Rotate, then cycle 2: BOB receives, ADMIN + CAROL pay in.
        advance_after_claim_as(&mut scenario, TEST_CAROL, &clock, circle_id, escrow1);
        let escrow2 = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_ADMIN, TEST_CAROL], TEST_BOB
        );
        record_progress_as(&mut scenario, TEST_BOB, tracker_id, escrow2);
        complete_as(&mut scenario, TEST_CAROL, tracker_id, 1, &clock);

        // The final completion's transaction fires both events.
        let completed_events = event::events_by_type<MilestoneCompleted>();
        assert!(vector::length(&completed_events) == 1, 9333);
        let achieved_events = event::events_by_type<GoalAchieved>();
        assert!(vector::length(&achieved_events) == 1, 9334);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        assert!(cumulative_contributed(&tracker) == 4 * TEST_CONTRIBUTION, 9331);
        assert!(is_milestone_completed(&tracker, 0), 9336);
        assert!(is_milestone_completed(&tracker, 1), 9337);
        assert!(is_goal_achieved(&tracker), 9332);
        ts::return_shared(tracker);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // --- verification flow --------------------------------------------

    #[test]
    #[expected_failure(abort_code = E_VERIFICATION_REQUIRED)]
    fun test_verification_gate_blocks_unverified_completion() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, true);

        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);

        // Target reached, but the admin has not confirmed yet.
        complete_as(&mut scenario, TEST_BOB, tracker_id, 0, &clock);
        abort 0
    }

    #[test]
    fun test_verified_milestone_completes() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, true);

        let escrow_id = settle_cycle(
            &mut scenario, &clock, circle_id,
            vector[TEST_BOB, TEST_CAROL], TEST_ADMIN
        );
        record_progress_as(&mut scenario, TEST_CAROL, tracker_id, escrow_id);

        // A member anchors proof bytes for the admin to review.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        submit_milestone_proof(
            &mut tracker, &circle, 0, b"walrus-blob-hash", ts::ctx(&mut scenario)
        );
        assert!(milestone_proof_count(&tracker, 0) == 1, 9340);
        ts::return_shared(circle);
        ts::return_shared(tracker);

        // Admin confirms; anyone may then complete.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        verify_milestone(&mut tracker, &circle, 0, ts::ctx(&mut scenario));
        assert!(option::is_some(&milestone_verified_by(&tracker, 0)), 9341);
        ts::return_shared(circle);
        ts::return_shared(tracker);

        complete_as(&mut scenario, TEST_CAROL, tracker_id, 0, &clock);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        assert!(is_milestone_completed(&tracker, 0), 9342);
        assert!(is_goal_achieved(&tracker), 9343);
        ts::return_shared(tracker);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_ADMIN)]
    fun test_verify_requires_admin() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (_clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, true);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        verify_milestone(&mut tracker, &circle, 0, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_MEMBER)]
    fun test_proof_submission_requires_membership() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (_clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, true);

        ts::next_tx(&mut scenario, TEST_OUTSIDER);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        submit_milestone_proof(&mut tracker, &circle, 0, b"x", ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_VERIFICATION_NOT_REQUIRED)]
    fun test_verify_automatic_milestone_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let (_clock, circle_id, tracker_id) = setup_goal_circle(&mut scenario);
        add_monetary_as_admin(&mut scenario, tracker_id, circle_id, 2 * TEST_CONTRIBUTION, false);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut tracker = ts::take_shared_by_id<CircleMilestones<SUI>>(&scenario, tracker_id);
        let circle = ts::take_shared_by_id<Circle>(&scenario, circle_id);
        verify_milestone(&mut tracker, &circle, 0, ts::ctx(&mut scenario));
        abort 0
    }
}
