module njangi::njangi_cycle_escrow {
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::table::{Self, Table};
    use std::ascii;
    use std::type_name;

    use njangi::njangi_circles::{Self as circles, Circle};
    use njangi::njangi_compliance::{Self as compliance, ComplianceAttestation};

    // ----------------------------------------------------------
    // Phase 2 per-cycle escrow primitive.
    //
    // The original `njangi_payments::contribute` + `trigger_payout` flow
    // pushes funds into a shared `CustodyWallet` and then routes payouts
    // back out via package-internal helpers. That design works, but it
    // leaves the wallet (and its package-trusted neighbors) on the trust
    // path of every member contribution.
    //
    // This module adds an alternate flow per the audit's recommended
    // end state: each cycle gets its own short-lived `CycleEscrow<T>`
    // shared object with a frozen `CycleSnapshot` (members, recipient,
    // amount, asset type, due time). Members contribute exactly the
    // snapshot's contribution amount; once everyone has contributed, any
    // address may finalize the cycle, which mints an owned `Claim<T>`
    // for the predetermined recipient. Only the recipient can redeem the
    // claim, and they redeem the entire balance directly into a `Coin<T>`.
    // No admin discretion exists at any point in the lifecycle; no other
    // module can pull funds out of the escrow.
    //
    // Phase 2 ships this as an additive module; the legacy contribute /
    // trigger_payout / claim_payout flow continues to work unchanged so
    // we can migrate frontends gradually.
    // ----------------------------------------------------------

    // Error codes (200+ to avoid collisions with sibling modules)
    const E_NOT_MEMBER: u64 = 200;
    const E_ALREADY_CONTRIBUTED: u64 = 201;
    const E_BAD_AMOUNT: u64 = 202;
    const E_NOT_FULLY_FUNDED: u64 = 204;
    const E_ALREADY_FINALIZED: u64 = 205;
    const E_ALREADY_CLAIMED: u64 = 206;
    const E_NOT_RECIPIENT: u64 = 207;
    const E_WRONG_ASSET_TYPE: u64 = 209;
    const E_CYCLE_MISMATCH: u64 = 210;
    const E_CLAIM_EXPIRED: u64 = 211;
    const E_RECIPIENT_NOT_FOUND: u64 = 212;
    const E_NO_REQUIRED_CONTRIBUTORS: u64 = 213;
    const E_INVALID_CONTRIBUTION_AMOUNT: u64 = 214;
    const E_RECIPIENT_NOT_MEMBER: u64 = 215;
    const E_COMPLIANCE_ATTESTATION_REQUIRED: u64 = 216;
    const E_COMPLIANCE_ATTESTATION_INVALID: u64 = 217;
    const E_RECIPIENT_CANNOT_CONTRIBUTE: u64 = 218;
    const E_INVALID_DECIMALS: u64 = 219;
    const E_NOT_CLAIMED: u64 = 220;
    const E_ALREADY_ADVANCED: u64 = 221;

    const CLAIM_WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 days

    public struct CycleSnapshot has store, copy, drop {
        cycle_no: u64,
        recipient: address,
        members: vector<address>,
        required_contributors: u64,
        contribution_amount: u64,
        asset_type: vector<u8>,
        due_at_ms: u64,
        opened_at_ms: u64,
    }

    public struct CycleEscrow<phantom T> has key {
        id: UID,
        circle_id: ID,
        snapshot: CycleSnapshot,
        contributed: Table<address, bool>,
        contributors_count: u64,
        balance: Balance<T>,
        finalized: bool,
        claimed: bool,
        /// Phase 7 compliance gate. When true, contribute/finalize paths
        /// must receive a non-revoked, non-expired ComplianceAttestation
        /// owned by the caller. The flag is set at open time so existing
        /// escrows opened before the gate flipped on continue to work.
        requires_attestation: bool,
    }

    public struct Claim<phantom T> has key, store {
        id: UID,
        escrow_id: ID,
        cycle_no: u64,
        recipient: address,
        amount: u64,
        expires_at_ms: u64,
    }

    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    public struct CycleEscrowOpened has copy, drop {
        circle_id: ID,
        escrow_id: ID,
        cycle_no: u64,
        recipient: address,
        contribution_amount: u64,
        required_contributors: u64,
        asset_type: vector<u8>,
        opened_at_ms: u64,
    }

    public struct ContributionRecorded has copy, drop {
        escrow_id: ID,
        cycle_no: u64,
        contributor: address,
        amount: u64,
        contributors_so_far: u64,
        total_contributed: u64,
    }

    public struct CycleFinalized has copy, drop {
        escrow_id: ID,
        cycle_no: u64,
        recipient: address,
        amount: u64,
        finalized_by: address,
    }

    public struct ClaimRedeemed has copy, drop {
        escrow_id: ID,
        cycle_no: u64,
        recipient: address,
        amount: u64,
    }

    // ----------------------------------------------------------
    // Public entrypoints
    // ----------------------------------------------------------

    /// Opens a new per-cycle escrow that anchors the rotation snapshot.
    /// The contribution amount, member set, and recipient are all locked
    /// at open-time so subsequent contributions can be checked against an
    /// immutable target. The escrow is created and shared in a single call.
    ///
    /// This uses the circle's raw `contribution_amount`, which is denominated
    /// in SUI MIST (9 decimals). Use it for SUI-settled circles. For circles
    /// that settle in a USD-pegged stablecoin (e.g. USDC), use
    /// `open_cycle_stable` so the on-chain target is derived from the circle's
    /// USD value rather than its SUI amount.
    public fun open_cycle<T>(
        circle: &Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = circles::get_contribution_amount_raw(circle);
        open_cycle_internal<T>(circle, amount, clock, false, ctx);
    }

    /// Phase 7: opens a per-cycle escrow that requires every contributor
    /// and claimant to present a valid `ComplianceAttestation`. Use this
    /// in jurisdictions where the operator must gate on partner-led KYC.
    /// Existing non-gated escrows (opened with `open_cycle`) continue to
    /// work when the gate is toggled on — only newly opened ones enforce.
    public fun open_cycle_with_gate<T>(
        circle: &Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = circles::get_contribution_amount_raw(circle);
        open_cycle_internal<T>(circle, amount, clock, true, ctx);
    }

    /// Opens a per-cycle escrow that settles in a USD-pegged stablecoin
    /// `T` (e.g. USDC). Stablecoins peg 1:1 to USD, so the per-member
    /// contribution target is derived from the circle's stored USD value
    /// (`contribution_amount_usd`, in cents) converted to the coin's base
    /// units: `base_units = cents * 10^(stable_decimals - 2)`. For USDC,
    /// `stable_decimals = 6`, so $0.30 (30 cents) becomes 300000 base units.
    /// This keeps the amount trustless — it is read from the circle, not
    /// supplied by the caller.
    public fun open_cycle_stable<T>(
        circle: &Circle,
        stable_decimals: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = stable_contribution_amount(circle, stable_decimals);
        open_cycle_internal<T>(circle, amount, clock, false, ctx);
    }

    /// Compliance-gated variant of `open_cycle_stable`.
    public fun open_cycle_stable_with_gate<T>(
        circle: &Circle,
        stable_decimals: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = stable_contribution_amount(circle, stable_decimals);
        open_cycle_internal<T>(circle, amount, clock, true, ctx);
    }

    fun open_cycle_internal<T>(
        circle: &Circle,
        contribution_amount: u64,
        clock: &Clock,
        requires_attestation: bool,
        ctx: &mut TxContext
    ) {
        let cycle_no = circles::get_current_cycle(circle);
        let rotation_order = circles::get_rotation_order(circle);
        let recipient_opt = circles::get_next_payout_recipient(circle);
        assert!(option::is_some(&recipient_opt), E_RECIPIENT_NOT_FOUND);
        let recipient = *option::borrow(&recipient_opt);

        let members = filter_active_members(&rotation_order);
        let member_count = vector::length(&members);
        // Recipients collect the pot; they don't pay into it. Excluding
        // them from required_contributors makes the finalize gate match
        // reality: a 3-member cycle needs 2 paying members, not 3.
        assert!(member_count >= 2, E_NO_REQUIRED_CONTRIBUTORS);
        let required_contributors = member_count - 1;
        // The recipient should be on the member list — otherwise the cycle
        // can never be finalized to a valid address.
        assert!(is_member(&members, recipient), E_RECIPIENT_NOT_MEMBER);

        assert!(contribution_amount > 0, E_INVALID_CONTRIBUTION_AMOUNT);

        let asset_type = canonical_type_bytes<T>();
        let opened_at_ms = clock::timestamp_ms(clock);
        let due_at_ms = circles::get_next_payout_time(circle);
        let circle_id = circles::get_id(circle);

        let snapshot = CycleSnapshot {
            cycle_no,
            recipient,
            members,
            required_contributors,
            contribution_amount,
            asset_type,
            due_at_ms,
            opened_at_ms,
        };

        let escrow = CycleEscrow<T> {
            id: object::new(ctx),
            circle_id,
            snapshot,
            contributed: table::new<address, bool>(ctx),
            contributors_count: 0,
            balance: balance::zero<T>(),
            finalized: false,
            claimed: false,
            requires_attestation,
        };

        let escrow_id = object::uid_to_inner(&escrow.id);
        let snapshot_asset = escrow.snapshot.asset_type;
        event::emit(CycleEscrowOpened {
            circle_id,
            escrow_id,
            cycle_no,
            recipient,
            contribution_amount,
            required_contributors,
            asset_type: snapshot_asset,
            opened_at_ms,
        });

        transfer::share_object(escrow);
    }

    /// Records a member's contribution into the escrow. The amount must
    /// match the snapshot's frozen contribution amount exactly; the asset
    /// type must match the escrow's typed parameter; and each member can
    /// only contribute once per cycle. When the escrow was opened with
    /// the compliance gate, this function aborts — callers must use
    /// `contribute_with_attestation` and present a valid attestation.
    public fun contribute<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        contribute_internal<T>(escrow, payment, ctx);
    }

    /// Phase 7: gated contribute. The attestation is only inspected
    /// (never taken), so members don't have to give it up when paying
    /// into the pot. `compliance::subject` must match the sender to
    /// prevent a cheap "borrow someone else's pass" attack.
    public fun contribute_with_attestation<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        attestation: &ComplianceAttestation,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_attestation_valid(attestation, sender, clock);
        contribute_internal<T>(escrow, payment, ctx);
    }

    fun contribute_internal<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.finalized, E_ALREADY_FINALIZED);

        let sender = tx_context::sender(ctx);
        assert!(is_member(&escrow.snapshot.members, sender), E_NOT_MEMBER);
        // Recipients collect the pot; they don't pay into it. Blocking this
        // at the protocol layer prevents a misconfigured client (or a
        // member who hand-rolls a PTB) from inflating the contributor count
        // for the cycle they're scheduled to receive.
        assert!(sender != escrow.snapshot.recipient, E_RECIPIENT_CANNOT_CONTRIBUTE);
        assert!(!table::contains(&escrow.contributed, sender), E_ALREADY_CONTRIBUTED);

        let amount = coin::value(&payment);
        assert!(amount == escrow.snapshot.contribution_amount, E_BAD_AMOUNT);

        let asset_type = canonical_type_bytes<T>();
        assert!(asset_type == escrow.snapshot.asset_type, E_WRONG_ASSET_TYPE);

        table::add(&mut escrow.contributed, sender, true);
        escrow.contributors_count = escrow.contributors_count + 1;
        balance::join(&mut escrow.balance, coin::into_balance(payment));

        event::emit(ContributionRecorded {
            escrow_id: object::uid_to_inner(&escrow.id),
            cycle_no: escrow.snapshot.cycle_no,
            contributor: sender,
            amount,
            contributors_so_far: escrow.contributors_count,
            total_contributed: balance::value(&escrow.balance),
        });
    }

    fun assert_attestation_valid(
        attestation: &ComplianceAttestation,
        expected_subject: address,
        clock: &Clock,
    ) {
        assert!(
            compliance::subject(attestation) == expected_subject,
            E_COMPLIANCE_ATTESTATION_INVALID,
        );
        assert!(
            compliance::is_attestation_valid(attestation, clock),
            E_COMPLIANCE_ATTESTATION_INVALID,
        );
    }

    /// Finalizes the cycle once every snapshot member has contributed and
    /// transfers a `Claim<T>` to the predetermined recipient. Anyone may
    /// pay the gas — there is no admin discretion in either the call
    /// surface or the return value.
    public fun finalize_to_recipient<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        let claim = mint_claim<T>(escrow, clock, ctx);
        let recipient = escrow.snapshot.recipient;
        transfer::transfer(claim, recipient);
    }

    /// Same as `finalize_to_recipient`, but returns the `Claim<T>` to the
    /// caller's PTB instead of transferring it. Useful when a script
    /// wants to atomically finalize and redeem within a single tx (the
    /// scheduled recipient calling on their own behalf, for example).
    public fun finalize<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ): Claim<T> {
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        mint_claim<T>(escrow, clock, ctx)
    }

    /// Redeems a finalized claim for the underlying coin. Only the
    /// recipient address recorded on the claim may redeem; redemption is
    /// idempotent (the escrow tracks `claimed` so a second redeem aborts).
    public fun redeem_claim<T>(
        escrow: &mut CycleEscrow<T>,
        claim: Claim<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ): Coin<T> {
        let Claim<T> { id, escrow_id, cycle_no, recipient, amount, expires_at_ms } = claim;
        let sender = tx_context::sender(ctx);

        assert!(sender == recipient, E_NOT_RECIPIENT);
        assert!(object::uid_to_inner(&escrow.id) == escrow_id, E_CYCLE_MISMATCH);
        assert!(escrow.snapshot.cycle_no == cycle_no, E_CYCLE_MISMATCH);
        assert!(!escrow.claimed, E_ALREADY_CLAIMED);
        assert!(clock::timestamp_ms(clock) <= expires_at_ms, E_CLAIM_EXPIRED);

        escrow.claimed = true;
        object::delete(id);

        let escrow_id_inner = object::uid_to_inner(&escrow.id);
        let payout_balance = balance::split(&mut escrow.balance, amount);
        let payout_coin = coin::from_balance(payout_balance, ctx);
        event::emit(ClaimRedeemed {
            escrow_id: escrow_id_inner,
            cycle_no,
            recipient,
            amount,
        });
        payout_coin
    }

    /// Convenience entry function: finalize + redeem in a single tx,
    /// transferring the resulting coin to the scheduled recipient. Only
    /// callable by the scheduled recipient themselves so it preserves the
    /// pull-only semantics.
    public fun finalize_and_redeem<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        finalize_and_redeem_internal<T>(escrow, clock, ctx);
    }

    /// Phase 7: gated finalize + redeem. The recipient must present their
    /// own valid ComplianceAttestation. Combined with the contribute-side
    /// gate, this means nobody can pay into or collect from a compliance-
    /// enforced escrow without a current partner-led KYC check on file.
    public fun finalize_and_redeem_with_attestation<T>(
        escrow: &mut CycleEscrow<T>,
        attestation: &ComplianceAttestation,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_attestation_valid(attestation, sender, clock);
        finalize_and_redeem_internal<T>(escrow, clock, ctx);
    }

    fun finalize_and_redeem_internal<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == escrow.snapshot.recipient, E_NOT_RECIPIENT);
        let claim = mint_claim_internal<T>(escrow, clock, ctx);
        let recipient = escrow.snapshot.recipient;
        let coin = redeem_claim<T>(escrow, claim, clock, ctx);
        transfer::public_transfer(coin, recipient);
    }

    /// Advance the circle's rotation after this escrow's payout has been
    /// collected. Collecting a per-cycle escrow (`finalize_and_redeem`) only
    /// moves the coins and marks the escrow claimed — it does NOT rotate the
    /// circle, so without this call the cycle stalls on the same recipient and
    /// re-opening just snapshots that same recipient again.
    ///
    /// Permissionless: anyone may push a settled round forward (matching the
    /// old permissionless `trigger_payout` semantics). Idempotent and
    /// replay-safe: it only advances while the circle still sits on THIS
    /// escrow's exact round (same cycle number, same current recipient) and
    /// isn't already paused, so a second call — or a stale/foreign escrow —
    /// aborts rather than over-advancing.
    ///
    /// Call it in the same PTB right after `finalize_and_redeem` so the
    /// recipient's collect atomically rotates the circle; or standalone to
    /// recover a circle whose payout was collected before this existed.
    public fun advance_circle_after_claim<T>(
        circle: &mut Circle,
        escrow: &CycleEscrow<T>,
        clock: &Clock,
        _ctx: &mut TxContext,
    ) {
        assert!(escrow.circle_id == circles::get_id(circle), E_CYCLE_MISMATCH);
        assert!(escrow.claimed, E_NOT_CLAIMED);
        // Replay / double-advance guard: the circle must still be on this
        // escrow's round (same cycle, same next recipient) and not yet paused.
        assert!(escrow.snapshot.cycle_no == circles::get_current_cycle(circle), E_ALREADY_ADVANCED);
        assert!(!circles::is_paused_after_cycle(circle), E_ALREADY_ADVANCED);
        let recipient_opt = circles::get_next_payout_recipient(circle);
        assert!(option::is_some(&recipient_opt), E_ALREADY_ADVANCED);
        assert!(*option::borrow(&recipient_opt) == escrow.snapshot.recipient, E_ALREADY_ADVANCED);
        circles::advance_rotation_position_and_cycle(circle, escrow.snapshot.recipient, clock);
    }

    // ----------------------------------------------------------
    // Read accessors (used by indexers + frontend)
    // ----------------------------------------------------------
    public fun cycle_no<T>(escrow: &CycleEscrow<T>): u64 { escrow.snapshot.cycle_no }
    public fun circle_id<T>(escrow: &CycleEscrow<T>): ID { escrow.circle_id }
    public fun recipient<T>(escrow: &CycleEscrow<T>): address { escrow.snapshot.recipient }
    public fun contribution_amount<T>(escrow: &CycleEscrow<T>): u64 { escrow.snapshot.contribution_amount }
    public fun required_contributors<T>(escrow: &CycleEscrow<T>): u64 { escrow.snapshot.required_contributors }
    public fun contributor_count<T>(escrow: &CycleEscrow<T>): u64 { escrow.contributors_count }
    public fun total_contributed<T>(escrow: &CycleEscrow<T>): u64 { balance::value(&escrow.balance) }
    public fun is_finalized<T>(escrow: &CycleEscrow<T>): bool { escrow.finalized }
    public fun is_claimed<T>(escrow: &CycleEscrow<T>): bool { escrow.claimed }
    public fun requires_attestation<T>(escrow: &CycleEscrow<T>): bool { escrow.requires_attestation }
    public fun has_member_contributed<T>(escrow: &CycleEscrow<T>, addr: address): bool {
        table::contains(&escrow.contributed, addr)
    }
    public fun snapshot_asset_type<T>(escrow: &CycleEscrow<T>): vector<u8> {
        escrow.snapshot.asset_type
    }

    // ----------------------------------------------------------
    // Internal helpers
    // ----------------------------------------------------------

    fun mint_claim<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ): Claim<T> {
        // Public path enforces the gate one more time for belt-and-braces.
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        mint_claim_internal<T>(escrow, clock, ctx)
    }

    /// Same as `mint_claim` but skips the requires_attestation check so
    /// gated call paths can run after their own attestation validation.
    fun mint_claim_internal<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ): Claim<T> {
        assert!(!escrow.finalized, E_ALREADY_FINALIZED);
        assert!(escrow.contributors_count >= escrow.snapshot.required_contributors, E_NOT_FULLY_FUNDED);
        escrow.finalized = true;

        let amount = balance::value(&escrow.balance);
        let escrow_id = object::uid_to_inner(&escrow.id);
        let cycle_no = escrow.snapshot.cycle_no;
        let recipient = escrow.snapshot.recipient;
        let expires_at_ms = clock::timestamp_ms(clock) + CLAIM_WINDOW_MS;

        event::emit(CycleFinalized {
            escrow_id,
            cycle_no,
            recipient,
            amount,
            finalized_by: tx_context::sender(ctx),
        });

        Claim<T> {
            id: object::new(ctx),
            escrow_id,
            cycle_no,
            recipient,
            amount,
            expires_at_ms,
        }
    }

    fun canonical_type_bytes<T>(): vector<u8> {
        ascii::into_bytes(type_name::into_string(type_name::get<T>()))
    }

    fun pow10(exp: u8): u64 {
        let mut result = 1u64;
        let mut i = 0u8;
        while (i < exp) {
            result = result * 10;
            i = i + 1;
        };
        result
    }

    /// Converts the circle's stored USD contribution (in cents) into the
    /// base units of a USD-pegged stablecoin with `stable_decimals`
    /// decimals. e.g. 30 cents at 6 decimals (USDC) → 300000 base units.
    fun stable_contribution_amount(circle: &Circle, stable_decimals: u8): u64 {
        assert!(stable_decimals >= 2, E_INVALID_DECIMALS);
        let cents = circles::get_contribution_amount_usd(circle);
        cents * pow10(stable_decimals - 2)
    }

    fun filter_active_members(rotation: &vector<address>): vector<address> {
        let mut out = vector::empty<address>();
        let mut i = 0;
        let len = vector::length(rotation);
        while (i < len) {
            let addr = *vector::borrow(rotation, i);
            if (addr != @0x0 && !vector::contains(&out, &addr)) {
                vector::push_back(&mut out, addr);
            };
            i = i + 1;
        };
        out
    }

    fun is_member(members: &vector<address>, candidate: address): bool {
        vector::contains(members, &candidate)
    }

    #[test_only]
    public fun __test_filter_active_members(
        rotation: vector<address>
    ): vector<address> {
        filter_active_members(&rotation)
    }

    #[test]
    fun test_filter_active_members_drops_zero_and_dedupes() {
        let v = vector[@0x1, @0x0, @0x2, @0x1, @0x3];
        let out = __test_filter_active_members(v);
        assert!(vector::length(&out) == 3, 9100);
        assert!(*vector::borrow(&out, 0) == @0x1, 9101);
        assert!(*vector::borrow(&out, 1) == @0x2, 9102);
        assert!(*vector::borrow(&out, 2) == @0x3, 9103);
    }

    #[test]
    fun test_canonical_type_bytes_matches_type_name() {
        let bytes = canonical_type_bytes<sui::sui::SUI>();
        let expected = b"0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
        assert!(bytes == expected, 9110);
    }
}
