module njangi::njangi_goal_pool {
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::table::{Self, Table};
    use std::ascii;
    use std::string::{Self, String};
    use std::type_name;

    use njangi::njangi_compliance::{Self as compliance, ComplianceAttestation, ComplianceConfig};

    // ----------------------------------------------------------
    // Non-rotating goal pool.
    //
    // A `GoalPool<T>` is a standalone shared vault for the "pool money with
    // friends and watch the pot grow" experience. Unlike `njangi_cycle_escrow`
    // (which rotates a fixed per-cycle pot to a different member each cycle and
    // therefore needs a security deposit to cover early-recipient default), a
    // goal pool ACCUMULATES variable-amount contributions toward a single shared
    // goal and releases the WHOLE pot exactly once — to a beneficiary that is
    // pre-committed and disclosed on-chain at open time.
    //
    // Because no one receives a payout until the goal is met, there is no
    // early-recipient default risk, so goal pools charge NO security deposit.
    // This module deliberately has NO rotation, NO per-cycle escrow, NO
    // membership/activation gate, and NO admin discretion over where funds go:
    //   * release  -> the pre-committed beneficiary, only once the goal is met
    //   * refund   -> the recorded contributors, only if the pool is cancelled
    // The admin can configure the goal at open and can cancel (which opens
    // refunds), but can never redirect funds or change the beneficiary.
    //
    // Goal kinds:
    //   * AMOUNT (0): release unlocks when total_raised >= target_amount.
    //   * DATE   (1): release unlocks when clock >= target_date_ms.
    // Optional `deadline_ms` (both kinds) is a contributor-protection backstop:
    //   * AMOUNT goal: if the target is not met by the deadline, anyone may
    //     cancel so contributors refund (a failed fundraiser).
    //   * DATE goal: set the deadline AFTER the disbursement date; if the pot is
    //     somehow never released by then, anyone may cancel so contributors
    //     refund.
    // A DATE goal opened with NO deadline disburses to the on-chain-disclosed
    // beneficiary at the target date and has no later contributor refund — the
    // contributors trust the disclosed beneficiary, like any group gift.
    // ----------------------------------------------------------

    // Error codes (500+ to avoid collisions with sibling modules:
    // payments 22-39, escrow 200-233, compliance 300-306, milestones 400-421)
    const E_NOT_ADMIN: u64 = 500;
    const E_ALREADY_RELEASED: u64 = 501;
    const E_POOL_CANCELLED: u64 = 502;
    const E_GOAL_NOT_MET: u64 = 503;
    const E_ZERO_CONTRIBUTION: u64 = 504;
    const E_WRONG_ASSET_TYPE: u64 = 505;
    const E_AMOUNT_OVERFLOW: u64 = 506;
    const E_NOTHING_TO_REFUND: u64 = 507;
    const E_NOT_CANCELLED: u64 = 508;
    const E_NOTHING_TO_RELEASE: u64 = 509;
    const E_INVALID_GOAL_KIND: u64 = 510;
    const E_INVALID_TARGET_AMOUNT: u64 = 511;
    const E_INVALID_TARGET_DATE: u64 = 512;
    const E_INVALID_BENEFICIARY: u64 = 513;
    const E_INVALID_DEADLINE: u64 = 514;
    const E_NO_DEADLINE: u64 = 515;
    const E_DEADLINE_NOT_PASSED: u64 = 516;
    // 517 retired (was E_NOT_AMOUNT_GOAL; the deadline backstop now serves both kinds)
    const E_GOAL_ALREADY_MET: u64 = 518;
    const E_COMPLIANCE_ATTESTATION_REQUIRED: u64 = 519;
    const E_COMPLIANCE_ATTESTATION_INVALID: u64 = 520;
    const E_COMPLIANCE_CONFIG_NOT_PINNED: u64 = 521;
    const E_COMPLIANCE_CONFIG_MISMATCH: u64 = 522;

    const GOAL_KIND_AMOUNT: u8 = 0;
    const GOAL_KIND_DATE: u8 = 1;
    // Combined "reach an amount by a date": releases when EITHER the amount is
    // reached OR the date arrives (keep-what-you-raise). For the all-or-nothing
    // variant the frontend uses a plain AMOUNT goal + deadline_ms (refund path).
    const GOAL_KIND_AMOUNT_BY_DATE: u8 = 2;
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;

    // Reason codes for GoalPoolCancelled
    const CANCEL_REASON_ADMIN: u8 = 0;
    const CANCEL_REASON_DEADLINE: u8 = 1;

    public struct GoalPool<phantom T> has key {
        id: UID,
        // Display name / goal description (may carry a leading emoji).
        name: String,
        admin: address,
        // Pre-committed, immutable destination for the pot on goal-met.
        beneficiary: address,
        goal_kind: u8,
        // base units of T (e.g. SUI MIST); used for AMOUNT goals (0 for DATE)
        target_amount: u64,
        // unix ms; used for DATE goals (0 for AMOUNT)
        target_date_ms: u64,
        // optional refund escape for AMOUNT goals (0 = none)
        deadline_ms: u64,
        // canonical full type-name string of T (defense-in-depth + indexers)
        asset_type: vector<u8>,
        balance: Balance<T>,
        // per-contributor cumulative amount (for exact, idempotent refunds)
        contributions: Table<address, u64>,
        contributor_count: u64,
        total_raised: u64,
        released: bool,
        cancelled: bool,
        requires_attestation: bool,
        compliance_config_id: Option<ID>,
        created_at: u64,
    }

    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    public struct GoalPoolOpened has copy, drop {
        pool_id: ID,
        name: String,
        admin: address,
        beneficiary: address,
        goal_kind: u8,
        target_amount: u64,
        target_date_ms: u64,
        deadline_ms: u64,
        asset_type: vector<u8>,
        requires_attestation: bool,
        compliance_config_id: Option<ID>,
        opened_at_ms: u64,
    }

    public struct ContributionRecorded has copy, drop {
        pool_id: ID,
        contributor: address,
        amount: u64,
        contributor_total: u64,
        total_raised: u64,
    }

    public struct GoalReleased has copy, drop {
        pool_id: ID,
        beneficiary: address,
        amount: u64,
        released_by: address,
        released_at_ms: u64,
    }

    public struct GoalPoolCancelled has copy, drop {
        pool_id: ID,
        cancelled_by: address,
        reason: u8,
        total_at_cancel: u64,
        cancelled_at_ms: u64,
    }

    public struct ContributionRefunded has copy, drop {
        pool_id: ID,
        contributor: address,
        amount: u64,
    }

    // ----------------------------------------------------------
    // Open
    // ----------------------------------------------------------

    /// Open an un-gated goal pool. `sender` becomes the admin.
    public fun open<T>(
        name: vector<u8>,
        beneficiary: address,
        goal_kind: u8,
        target_amount: u64,
        target_date_ms: u64,
        deadline_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        open_internal<T>(
            name, beneficiary, goal_kind, target_amount, target_date_ms,
            deadline_ms, false, option::none<ID>(), clock, ctx,
        );
    }

    /// Open a KYC-gated goal pool. Contributions must then come through
    /// `contribute_with_attestation` carrying a valid attestation for the
    /// exact `compliance_config` pinned here.
    public fun open_with_gate<T>(
        name: vector<u8>,
        beneficiary: address,
        goal_kind: u8,
        target_amount: u64,
        target_date_ms: u64,
        deadline_ms: u64,
        compliance_config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        open_internal<T>(
            name, beneficiary, goal_kind, target_amount, target_date_ms,
            deadline_ms, true, option::some(object::id(compliance_config)), clock, ctx,
        );
    }

    fun open_internal<T>(
        name: vector<u8>,
        beneficiary: address,
        goal_kind: u8,
        target_amount: u64,
        target_date_ms: u64,
        deadline_ms: u64,
        requires_attestation: bool,
        compliance_config_id: Option<ID>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(beneficiary != @0x0, E_INVALID_BENEFICIARY);
        assert!(
            goal_kind == GOAL_KIND_AMOUNT
                || goal_kind == GOAL_KIND_DATE
                || goal_kind == GOAL_KIND_AMOUNT_BY_DATE,
            E_INVALID_GOAL_KIND,
        );

        // A goal can have an amount target, a release date, or both. The pot
        // releases when EITHER is met (see is_goal_met_internal).
        let has_amount = goal_kind == GOAL_KIND_AMOUNT || goal_kind == GOAL_KIND_AMOUNT_BY_DATE;
        let has_release_date = goal_kind == GOAL_KIND_DATE || goal_kind == GOAL_KIND_AMOUNT_BY_DATE;

        let mut norm_target_amount = 0;
        let mut norm_target_date = 0;
        let mut norm_deadline = 0;
        if (has_amount) {
            assert!(target_amount > 0, E_INVALID_TARGET_AMOUNT);
            norm_target_amount = target_amount;
        };
        if (has_release_date) {
            assert!(target_date_ms > now, E_INVALID_TARGET_DATE);
            norm_target_date = target_date_ms;
        };
        // Optional refund deadline (all-or-nothing variant): a plain AMOUNT goal
        // that must be reached by this date, or contributors refund. Not used
        // together with a release date (which pays out instead).
        if (deadline_ms > 0) {
            assert!(deadline_ms > now, E_INVALID_DEADLINE);
            norm_deadline = deadline_ms;
        };

        let asset_type = canonical_type_bytes<T>();
        let pool = GoalPool<T> {
            id: object::new(ctx),
            name: string::utf8(name),
            admin: tx_context::sender(ctx),
            beneficiary,
            goal_kind,
            target_amount: norm_target_amount,
            target_date_ms: norm_target_date,
            deadline_ms: norm_deadline,
            asset_type,
            balance: balance::zero<T>(),
            contributions: table::new(ctx),
            contributor_count: 0,
            total_raised: 0,
            released: false,
            cancelled: false,
            requires_attestation,
            compliance_config_id,
            created_at: now,
        };

        event::emit(GoalPoolOpened {
            pool_id: object::uid_to_inner(&pool.id),
            name: pool.name,
            admin: pool.admin,
            beneficiary: pool.beneficiary,
            goal_kind: pool.goal_kind,
            target_amount: pool.target_amount,
            target_date_ms: pool.target_date_ms,
            deadline_ms: pool.deadline_ms,
            asset_type: pool.asset_type,
            requires_attestation: pool.requires_attestation,
            compliance_config_id: pool.compliance_config_id,
            opened_at_ms: now,
        });

        transfer::share_object(pool);
    }

    // ----------------------------------------------------------
    // Contribute (accumulate, variable amount, repeat allowed)
    // ----------------------------------------------------------

    /// Contribute any positive amount to an un-gated pool. Anyone may chip in.
    public fun contribute<T>(
        pool: &mut GoalPool<T>,
        payment: Coin<T>,
        ctx: &mut TxContext,
    ) {
        assert!(!pool.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        contribute_internal<T>(pool, payment, tx_context::sender(ctx));
    }

    /// Contribute to a KYC-gated pool. The attestation is borrowed (never
    /// consumed) and must belong to the sender and validate against the EXACT
    /// ComplianceConfig pinned on the pool.
    public fun contribute_with_attestation<T>(
        pool: &mut GoalPool<T>,
        payment: Coin<T>,
        attestation: &ComplianceAttestation,
        config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        // Pin defense: only the exact config recorded at open can vouch.
        assert!(option::is_some(&pool.compliance_config_id), E_COMPLIANCE_CONFIG_NOT_PINNED);
        assert!(object::id(config) == *option::borrow(&pool.compliance_config_id), E_COMPLIANCE_CONFIG_MISMATCH);
        // Subject binding: a member cannot borrow someone else's pass.
        assert!(compliance::subject(attestation) == sender, E_COMPLIANCE_ATTESTATION_INVALID);
        // Validity: folds in expected-issuer, revocation, and expiry.
        assert!(compliance::is_attestation_valid(config, attestation, clock), E_COMPLIANCE_ATTESTATION_INVALID);
        contribute_internal<T>(pool, payment, sender);
    }

    fun contribute_internal<T>(
        pool: &mut GoalPool<T>,
        payment: Coin<T>,
        sender: address,
    ) {
        assert!(!pool.released, E_ALREADY_RELEASED);
        assert!(!pool.cancelled, E_POOL_CANCELLED);

        let amount = coin::value(&payment);
        assert!(amount > 0, E_ZERO_CONTRIBUTION);
        assert!(canonical_type_bytes<T>() == pool.asset_type, E_WRONG_ASSET_TYPE);
        assert!(pool.total_raised <= MAX_U64 - amount, E_AMOUNT_OVERFLOW);

        // Accumulate per-contributor (variable amounts, repeats welcome).
        if (table::contains(&pool.contributions, sender)) {
            let entry = table::borrow_mut(&mut pool.contributions, sender);
            *entry = *entry + amount;
        } else {
            table::add(&mut pool.contributions, sender, amount);
            pool.contributor_count = pool.contributor_count + 1;
        };
        pool.total_raised = pool.total_raised + amount;
        balance::join(&mut pool.balance, coin::into_balance(payment));

        let contributor_total = *table::borrow(&pool.contributions, sender);
        event::emit(ContributionRecorded {
            pool_id: object::uid_to_inner(&pool.id),
            contributor: sender,
            amount,
            contributor_total,
            total_raised: pool.total_raised,
        });
    }

    // ----------------------------------------------------------
    // Release (whole pot -> pre-committed beneficiary, once goal met)
    // ----------------------------------------------------------

    /// Permissionless once the goal is met: pushes the ENTIRE pot to the
    /// pre-committed beneficiary. Anyone may pay gas to trigger it; funds can
    /// only ever go to the beneficiary recorded at open, so there is no
    /// discretion to abuse.
    public fun release<T>(
        pool: &mut GoalPool<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!pool.released, E_ALREADY_RELEASED);
        assert!(!pool.cancelled, E_POOL_CANCELLED);
        assert!(is_goal_met_internal(pool, clock), E_GOAL_NOT_MET);

        let amount = balance::value(&pool.balance);
        assert!(amount > 0, E_NOTHING_TO_RELEASE);

        pool.released = true;
        let payout = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
        transfer::public_transfer(payout, pool.beneficiary);

        event::emit(GoalReleased {
            pool_id: object::uid_to_inner(&pool.id),
            beneficiary: pool.beneficiary,
            amount,
            released_by: tx_context::sender(ctx),
            released_at_ms: clock::timestamp_ms(clock),
        });
    }

    // ----------------------------------------------------------
    // Cancel (opens refunds) + per-contributor refund (pull)
    // ----------------------------------------------------------

    /// Admin cancels an active pool, opening refunds for every contributor.
    /// Once the goal is MET the pot is owed to the disclosed beneficiary, so the
    /// admin can no longer cancel — the only terminal action is `release`. This
    /// makes release-vs-refund deterministic at goal-met instead of a race the
    /// admin could win against a pending `release` tx.
    public fun cancel<T>(pool: &mut GoalPool<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(tx_context::sender(ctx) == pool.admin, E_NOT_ADMIN);
        assert!(!pool.released, E_ALREADY_RELEASED);
        assert!(!pool.cancelled, E_POOL_CANCELLED);
        assert!(!is_goal_met_internal(pool, clock), E_GOAL_ALREADY_MET);
        pool.cancelled = true;
        emit_cancelled(pool, CANCEL_REASON_ADMIN, clock, ctx);
    }

    /// Permissionless all-or-nothing refund hatch for a goal opened with a
    /// refund `deadline_ms`: if the amount target is not met by the deadline,
    /// anyone may cancel so contributors can refund. Aborts if the goal is
    /// already met (in which case the correct action is release, not refund).
    public fun cancel_after_deadline<T>(pool: &mut GoalPool<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(!pool.released, E_ALREADY_RELEASED);
        assert!(!pool.cancelled, E_POOL_CANCELLED);
        assert!(pool.deadline_ms > 0, E_NO_DEADLINE);
        assert!(clock::timestamp_ms(clock) > pool.deadline_ms, E_DEADLINE_NOT_PASSED);
        assert!(!is_goal_met_internal(pool, clock), E_GOAL_ALREADY_MET);
        pool.cancelled = true;
        emit_cancelled(pool, CANCEL_REASON_DEADLINE, clock, ctx);
    }

    fun emit_cancelled<T>(pool: &GoalPool<T>, reason: u8, clock: &Clock, ctx: &TxContext) {
        event::emit(GoalPoolCancelled {
            pool_id: object::uid_to_inner(&pool.id),
            cancelled_by: tx_context::sender(ctx),
            reason,
            total_at_cancel: pool.total_raised,
            cancelled_at_ms: clock::timestamp_ms(clock),
        });
    }

    /// A contributor reclaims their exact recorded contribution after the pool
    /// is cancelled. Idempotent: the entry is removed on payout, so a second
    /// call aborts with E_NOTHING_TO_REFUND.
    public fun claim_refund<T>(pool: &mut GoalPool<T>, ctx: &mut TxContext) {
        assert!(pool.cancelled, E_NOT_CANCELLED);
        // (Cancelled and released are mutually exclusive, but assert anyway.)
        assert!(!pool.released, E_ALREADY_RELEASED);
        let sender = tx_context::sender(ctx);
        assert!(table::contains(&pool.contributions, sender), E_NOTHING_TO_REFUND);

        let amount = table::remove(&mut pool.contributions, sender);
        assert!(amount > 0, E_NOTHING_TO_REFUND);
        pool.contributor_count = pool.contributor_count - 1;
        pool.total_raised = pool.total_raised - amount;

        let refund = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
        transfer::public_transfer(refund, sender);

        event::emit(ContributionRefunded {
            pool_id: object::uid_to_inner(&pool.id),
            contributor: sender,
            amount,
        });
    }

    // ----------------------------------------------------------
    // Internal helpers
    // ----------------------------------------------------------

    /// The pot is releasable when EITHER configured trigger is met: the amount
    /// target is reached, OR the release date has arrived. (A goal sets one or
    /// both; an unset trigger is stored as 0 and never fires.)
    fun is_goal_met_internal<T>(pool: &GoalPool<T>, clock: &Clock): bool {
        (pool.target_amount > 0 && pool.total_raised >= pool.target_amount)
            || (pool.target_date_ms > 0 && clock::timestamp_ms(clock) >= pool.target_date_ms)
    }

    fun canonical_type_bytes<T>(): vector<u8> {
        ascii::into_bytes(type_name::into_string(type_name::get<T>()))
    }

    // ----------------------------------------------------------
    // Read-only getters
    // ----------------------------------------------------------

    public fun name<T>(pool: &GoalPool<T>): String { pool.name }
    public fun admin<T>(pool: &GoalPool<T>): address { pool.admin }
    public fun beneficiary<T>(pool: &GoalPool<T>): address { pool.beneficiary }
    public fun goal_kind<T>(pool: &GoalPool<T>): u8 { pool.goal_kind }
    public fun target_amount<T>(pool: &GoalPool<T>): u64 { pool.target_amount }
    public fun target_date_ms<T>(pool: &GoalPool<T>): u64 { pool.target_date_ms }
    public fun deadline_ms<T>(pool: &GoalPool<T>): u64 { pool.deadline_ms }
    public fun total_raised<T>(pool: &GoalPool<T>): u64 { pool.total_raised }
    public fun balance_value<T>(pool: &GoalPool<T>): u64 { balance::value(&pool.balance) }
    public fun contributor_count<T>(pool: &GoalPool<T>): u64 { pool.contributor_count }
    public fun is_released<T>(pool: &GoalPool<T>): bool { pool.released }
    public fun is_cancelled<T>(pool: &GoalPool<T>): bool { pool.cancelled }
    public fun requires_attestation<T>(pool: &GoalPool<T>): bool { pool.requires_attestation }
    public fun pinned_compliance_config_id<T>(pool: &GoalPool<T>): Option<ID> { pool.compliance_config_id }
    public fun asset_type<T>(pool: &GoalPool<T>): vector<u8> { pool.asset_type }

    public fun contributed_by<T>(pool: &GoalPool<T>, who: address): u64 {
        if (table::contains(&pool.contributions, who)) {
            *table::borrow(&pool.contributions, who)
        } else {
            0
        }
    }

    public fun is_goal_met<T>(pool: &GoalPool<T>, clock: &Clock): bool {
        is_goal_met_internal(pool, clock)
    }

    // ----------------------------------------------------------
    // Tests
    // ----------------------------------------------------------
    #[test_only]
    use sui::sui::SUI;
    #[test_only]
    use sui::test_scenario as ts;

    #[test_only]
    const ADMIN: address = @0xA;
    #[test_only]
    const ALICE: address = @0xA11CE;
    #[test_only]
    const BOB: address = @0xB0B;
    #[test_only]
    const CAROL: address = @0xCA801;
    #[test_only]
    const BENEFICIARY: address = @0xBEEF;

    #[test_only]
    fun mint(amount: u64, ctx: &mut TxContext): Coin<SUI> {
        coin::mint_for_testing<SUI>(amount, ctx)
    }

    // ---- Amount goal: full happy path (accumulate -> release) ----
    #[test]
    fun test_amount_goal_accumulate_and_release() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        // Admin opens a 1,000 MIST amount goal for BENEFICIARY.
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        // Alice contributes 400.
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(400, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            assert!(total_raised(&pool) == 400, 1);
            assert!(contributor_count(&pool) == 1, 2);
            assert!(contributed_by(&pool, ALICE) == 400, 3);
            ts::return_shared(pool);
        };

        // Bob contributes 300, then 300 more (repeat) -> 600.
        ts::next_tx(&mut scenario, BOB);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(300, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            contribute<SUI>(&mut pool, mint(300, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            assert!(contributed_by(&pool, BOB) == 600, 4);
            assert!(contributor_count(&pool) == 2, 5);
            assert!(total_raised(&pool) == 1000, 6);
            assert!(is_goal_met(&pool, &clock), 7);
            ts::return_shared(pool);
        };

        // Anyone releases -> whole pot (1000) to BENEFICIARY.
        ts::next_tx(&mut scenario, CAROL);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            assert!(is_released(&pool), 8);
            assert!(balance_value(&pool) == 0, 9);
            ts::return_shared(pool);
        };

        // BENEFICIARY received exactly 1000.
        ts::next_tx(&mut scenario, BENEFICIARY);
        {
            let coin = ts::take_from_address<Coin<SUI>>(&scenario, BENEFICIARY);
            assert!(coin::value(&coin) == 1000, 10);
            ts::return_to_address(BENEFICIARY, coin);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Date goal: release only after the target date ----
    #[test]
    fun test_date_goal_release_after_date() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000);

        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_DATE, 0, 5_000, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(750, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            assert!(!is_goal_met(&pool, &clock), 1); // before the date
            ts::return_shared(pool);
        };

        // Advance past the target date and release.
        clock::set_for_testing(&mut clock, 5_001);
        ts::next_tx(&mut scenario, BOB);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            assert!(is_goal_met(&pool, &clock), 2);
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            assert!(is_released(&pool), 3);
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Cancel + refunds (exact per-contributor amounts) ----
    #[test]
    fun test_cancel_and_refund_exact_amounts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 10_000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(400, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, BOB);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(600, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };

        // Admin cancels (goal never reached).
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            assert!(is_cancelled(&pool), 1);
            ts::return_shared(pool);
        };

        // Alice refunds 400.
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            claim_refund<SUI>(&mut pool, ts::ctx(&mut scenario));
            assert!(total_raised(&pool) == 600, 2);
            assert!(contributor_count(&pool) == 1, 3);
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let coin = ts::take_from_address<Coin<SUI>>(&scenario, ALICE);
            assert!(coin::value(&coin) == 400, 4);
            ts::return_to_address(ALICE, coin);
        };

        // Bob refunds 600; pool fully drained.
        ts::next_tx(&mut scenario, BOB);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            claim_refund<SUI>(&mut pool, ts::ctx(&mut scenario));
            assert!(total_raised(&pool) == 0, 5);
            assert!(balance_value(&pool) == 0, 6);
            assert!(contributor_count(&pool) == 0, 7);
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Permissionless cancel after a missed deadline ----
    #[test]
    fun test_cancel_after_deadline_permissionless() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000);

        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 10_000, 0, 2_000, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(500, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };

        // Past the deadline, goal unmet: a non-admin can cancel.
        clock::set_for_testing(&mut clock, 2_001);
        ts::next_tx(&mut scenario, CAROL);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel_after_deadline<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            assert!(is_cancelled(&pool), 1);
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: release before goal is met ----
    #[test]
    #[expected_failure(abort_code = E_GOAL_NOT_MET)]
    fun test_release_before_goal_met_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(400, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario)); // only 400/1000
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: double release ----
    #[test]
    #[expected_failure(abort_code = E_ALREADY_RELEASED)]
    fun test_double_release_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(1000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario)); // second time
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: contribute after release ----
    #[test]
    #[expected_failure(abort_code = E_ALREADY_RELEASED)]
    fun test_contribute_after_release_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(1000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            contribute<SUI>(&mut pool, mint(100, ts::ctx(&mut scenario)), ts::ctx(&mut scenario)); // blocked
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: refund without cancel ----
    #[test]
    #[expected_failure(abort_code = E_NOT_CANCELLED)]
    fun test_refund_without_cancel_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(400, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            claim_refund<SUI>(&mut pool, ts::ctx(&mut scenario)); // not cancelled
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: double refund ----
    #[test]
    #[expected_failure(abort_code = E_NOTHING_TO_REFUND)]
    fun test_double_refund_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(400, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            claim_refund<SUI>(&mut pool, ts::ctx(&mut scenario));
            claim_refund<SUI>(&mut pool, ts::ctx(&mut scenario)); // nothing left
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: non-admin cancel ----
    #[test]
    #[expected_failure(abort_code = E_NOT_ADMIN)]
    fun test_non_admin_cancel_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, BOB);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel<SUI>(&mut pool, &clock, ts::ctx(&mut scenario)); // BOB is not admin
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: cancel after release ----
    #[test]
    #[expected_failure(abort_code = E_ALREADY_RELEASED)]
    fun test_cancel_after_release_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(1000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel<SUI>(&mut pool, &clock, ts::ctx(&mut scenario)); // already released
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: cancel_after_deadline before the deadline ----
    #[test]
    #[expected_failure(abort_code = E_DEADLINE_NOT_PASSED)]
    fun test_cancel_after_deadline_too_early_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000);
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 10_000, 0, 5_000, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, CAROL);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel_after_deadline<SUI>(&mut pool, &clock, ts::ctx(&mut scenario)); // before deadline
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: zero contribution ----
    #[test]
    #[expected_failure(abort_code = E_ZERO_CONTRIBUTION)]
    fun test_zero_contribution_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, coin::zero<SUI>(ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: amount goal must have target > 0 ----
    #[test]
    #[expected_failure(abort_code = E_INVALID_TARGET_AMOUNT)]
    fun test_amount_goal_zero_target_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 0, 0, 0, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Negative: date goal must be in the future ----
    #[test]
    #[expected_failure(abort_code = E_INVALID_TARGET_DATE)]
    fun test_date_goal_past_date_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 10_000);
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_DATE, 0, 5_000, 0, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Review fix 1: admin cannot cancel a goal that is already MET ----
    #[test]
    #[expected_failure(abort_code = E_GOAL_ALREADY_MET)]
    fun test_admin_cancel_met_goal_aborts() {
        let mut scenario = ts::begin(ADMIN);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT, 1000, 0, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(1000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario)); // meets target
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            cancel<SUI>(&mut pool, &clock, ts::ctx(&mut scenario)); // met -> blocked
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Combined "amount by date" (release): releases at the date even if
    //      the amount target was not reached (keep-what-you-raise) ----
    #[test]
    fun test_amount_by_date_releases_at_date_when_under_target() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000);
        // Target 10_000 by date 5_000.
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT_BY_DATE, 10_000, 5_000, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(3_000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            assert!(!is_goal_met(&pool, &clock), 1); // under target, before date
            ts::return_shared(pool);
        };

        // Date arrives (still under target): the pot releases to the beneficiary.
        clock::set_for_testing(&mut clock, 5_001);
        ts::next_tx(&mut scenario, CAROL);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            assert!(is_goal_met(&pool, &clock), 2);
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            assert!(is_released(&pool), 3);
            ts::return_shared(pool);
        };
        ts::next_tx(&mut scenario, BENEFICIARY);
        {
            let coin = ts::take_from_address<Coin<SUI>>(&scenario, BENEFICIARY);
            assert!(coin::value(&coin) == 3_000, 4); // keep-what-you-raise
            ts::return_to_address(BENEFICIARY, coin);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Combined "amount by date": hitting the amount early releases before
    //      the date too ----
    #[test]
    fun test_amount_by_date_releases_early_on_target() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000);
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT_BY_DATE, 1_000, 50_000, 0, &clock, ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<GoalPool<SUI>>(&scenario);
            contribute<SUI>(&mut pool, mint(1_000, ts::ctx(&mut scenario)), ts::ctx(&mut scenario));
            assert!(is_goal_met(&pool, &clock), 1); // target hit well before the date
            release<SUI>(&mut pool, &clock, ts::ctx(&mut scenario));
            assert!(is_released(&pool), 2);
            ts::return_shared(pool);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ---- Combined goal requires BOTH an amount and a future date ----
    #[test]
    #[expected_failure(abort_code = E_INVALID_TARGET_AMOUNT)]
    fun test_amount_by_date_requires_amount() {
        let mut scenario = ts::begin(ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 1_000);
        open<SUI>(b"goal", BENEFICIARY, GOAL_KIND_AMOUNT_BY_DATE, 0, 5_000, 0, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
