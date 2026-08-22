module njangi::njangi_cycle_escrow {
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::table::{Self, Table};
    use sui::dynamic_field as df;
    use std::ascii;
    use std::type_name;

    use njangi::njangi_circles::{Self as circles, Circle};
    use njangi::njangi_circle_config as config;
    use njangi::njangi_compliance::{Self as compliance, ComplianceAttestation, ComplianceConfig};

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
    const E_NOT_FINALIZED: u64 = 222;
    const E_CLAIM_NOT_EXPIRED: u64 = 223;
    const E_CANCEL_TOO_EARLY: u64 = 224;
    const E_NOTHING_TO_REFUND: u64 = 225;
    const E_ESCROW_REFUNDED: u64 = 226;
    const E_CIRCLE_NOT_IN_RECOVERY: u64 = 227;
    const E_AMOUNT_OVERFLOW: u64 = 228;
    // Granular attestation-gate failures (June 2026 audit fix) so the
    // frontend can tell members exactly why a pass was rejected.
    const E_ATTESTATION_WRONG_ISSUER: u64 = 229;
    const E_ATTESTATION_REVOKED: u64 = 230;
    const E_ATTESTATION_EXPIRED: u64 = 231;
    // The supplied ComplianceConfig is not the exact config object this
    // escrow pinned at open time (June 2026 adversarial-review repair:
    // the gate must not trust whatever config the caller's PTB supplies).
    const E_COMPLIANCE_CONFIG_MISMATCH: u64 = 232;
    // A gated escrow cannot be opened without a config pin to enforce.
    const E_COMPLIANCE_CONFIG_NOT_PINNED: u64 = 233;

    const CLAIM_WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 days
    /// Grace period after the cycle's snapshot due date before anyone may
    /// cancel an unfinalized escrow and refund the recorded contributors.
    /// Long enough for slow contributors / a late finalize; short enough
    /// that a stalled cycle doesn't strand funds for long.
    const CANCEL_GRACE_MS: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;
    /// Upper bound for caller-supplied stablecoin decimals. No real coin
    /// uses more than 18; bounding it keeps pow10 trivially overflow-safe.
    const MAX_STABLE_DECIMALS: u8 = 18;

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

    /// Dynamic-field key for a member's contribution timestamp on the
    /// escrow's UID (Circle Record v1.1). Written only by the *_timed
    /// contribute paths; absent for contributions made through the
    /// original entry points, so readers must treat "no timestamp" as
    /// "not recorded", never as "not contributed" — the `contributed`
    /// table remains the authority on THAT question.
    public struct ContributionTimeKey has copy, drop, store { member: address }

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
        /// Object id of the ONLY ComplianceConfig the gated paths accept
        /// (June 2026 adversarial-review repair). Captured at open time —
        /// from the circle's admin-pinned config for circle-required
        /// gates, or from the opener-presented config for opt-in gates —
        /// so a caller's PTB cannot substitute a stale or fabricated
        /// config. `some` iff `requires_attestation`.
        compliance_config_id: Option<ID>,
        /// Terminal refund flag. Set when either refund path begins
        /// (cancel of an unfinalized escrow, or refund of an expired
        /// claim). Once set: contributions, finalization, and claim
        /// redemption all abort — the escrow can only drain back to the
        /// recorded contributors. This is the authoritative guard that
        /// makes redeem-after-refund impossible.
        refunded: bool,
        /// Mirror of the minted Claim's `expires_at_ms` (0 until
        /// finalized). Stored on the escrow so the expired-claim refund
        /// path does not need the recipient-owned Claim object — the
        /// whole point is that the recipient may be unreachable.
        claim_expires_at_ms: u64,
    }

    /// Abilities are deliberately UNCHANGED (`key, store`).
    ///
    /// Removing `store` would also close the payout-denial grief described on
    /// `finalize`, and more elegantly — a Claim that cannot be transferred
    /// cannot be stranded. But altering a public struct's abilities is an
    /// upgrade-INCOMPATIBLE change in Sui: it would force a fresh publish,
    /// mint a new package id, and orphan every circle on the existing
    /// lineage, since Move type identity is anchored to the original package.
    ///
    /// Stranding users' circles to fix a griefing vector is a bad trade, so
    /// the fix lives in `finalize` instead, where an added assert is
    /// upgrade-compatible.
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
        /// Whether this escrow's money paths are attestation-gated, and
        /// against which exact ComplianceConfig object (`some` iff gated).
        requires_attestation: bool,
        compliance_config_id: Option<ID>,
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

    /// Emitted once when an unfinalized escrow is cancelled (deadline +
    /// grace elapsed, or the circle entered recovery) and refunds begin.
    public struct EscrowCancelled has copy, drop {
        escrow_id: ID,
        circle_id: ID,
        cycle_no: u64,
        contributors: u64,
        total_refund: u64,
        cancelled_at_ms: u64,
    }

    /// Emitted per contributor whenever a recorded contribution is
    /// returned (both the cancel path and the expired-claim path).
    public struct ContributionRefunded has copy, drop {
        escrow_id: ID,
        cycle_no: u64,
        contributor: address,
        amount: u64,
    }

    /// Emitted once when a finalized-but-never-redeemed escrow starts
    /// refunding contributors after the claim window expired.
    public struct ExpiredClaimRefunded has copy, drop {
        escrow_id: ID,
        circle_id: ID,
        cycle_no: u64,
        recipient: address,
        contributors: u64,
        total_refund: u64,
        refunded_at_ms: u64,
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
        let _ = open_cycle_internal<T>(circle, amount, clock, option::none(), ctx);
    }

    /// Phase 7: opens a per-cycle escrow that requires every contributor
    /// and claimant to present a valid `ComplianceAttestation`, validated
    /// against exactly the `ComplianceConfig` presented here (its object
    /// id is pinned on the escrow). Use this in jurisdictions where the
    /// operator must gate on partner-led KYC. Existing non-gated escrows
    /// (opened with `open_cycle`) continue to work when the gate is
    /// toggled on — only newly opened ones enforce. For circles whose
    /// admin enabled `requires_attestation` on-chain, the circle's
    /// admin-pinned config takes precedence over the one presented here.
    public fun open_cycle_with_gate<T>(
        circle: &Circle,
        compliance_config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = circles::get_contribution_amount_raw(circle);
        let _ = open_cycle_internal<T>(
            circle, amount, clock, option::some(object::id(compliance_config)), ctx
        );
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
        let _ = open_cycle_internal<T>(circle, amount, clock, option::none(), ctx);
    }

    /// Compliance-gated variant of `open_cycle_stable` (see
    /// `open_cycle_with_gate` for the config-pinning semantics).
    public fun open_cycle_stable_with_gate<T>(
        circle: &Circle,
        compliance_config: &ComplianceConfig,
        stable_decimals: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = stable_contribution_amount(circle, stable_decimals);
        let _ = open_cycle_internal<T>(
            circle, amount, clock, option::some(object::id(compliance_config)), ctx
        );
    }

    // ----------------------------------------------------------
    // Circle Record v1.1 — indexed opens and timed contributions.
    //
    // Additive entry points only: Sui upgrades forbid changing existing
    // public signatures, so the original opens (immutable &Circle) stay
    // exactly as they are and these *_indexed variants take &mut Circle
    // to also append the new escrow's id to the circle's on-chain
    // history (circles::record_escrow_opened). That single append is
    // what makes past escrows enumerable by object read; without it the
    // only route is an event scan.
    //
    // The frontend switches to these targets behind a flag once the
    // package version carrying them is published; older circles keep
    // working through the original entries indefinitely.
    // ----------------------------------------------------------

    public fun open_cycle_indexed<T>(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = circles::get_contribution_amount_raw(circle);
        let escrow_id = open_cycle_internal<T>(circle, amount, clock, option::none(), ctx);
        circles::record_escrow_opened(circle, escrow_id);
    }

    public fun open_cycle_stable_indexed<T>(
        circle: &mut Circle,
        stable_decimals: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = stable_contribution_amount(circle, stable_decimals);
        let escrow_id = open_cycle_internal<T>(circle, amount, clock, option::none(), ctx);
        circles::record_escrow_opened(circle, escrow_id);
    }

    public fun open_cycle_indexed_with_gate<T>(
        circle: &mut Circle,
        compliance_config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = circles::get_contribution_amount_raw(circle);
        let escrow_id = open_cycle_internal<T>(
            circle, amount, clock, option::some(object::id(compliance_config)), ctx
        );
        circles::record_escrow_opened(circle, escrow_id);
    }

    public fun open_cycle_stable_indexed_with_gate<T>(
        circle: &mut Circle,
        compliance_config: &ComplianceConfig,
        stable_decimals: u8,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let amount = stable_contribution_amount(circle, stable_decimals);
        let escrow_id = open_cycle_internal<T>(
            circle, amount, clock, option::some(object::id(compliance_config)), ctx
        );
        circles::record_escrow_opened(circle, escrow_id);
    }

    /// `contribute`, plus a per-member timestamp so "paid on time" can be
    /// an on-chain fact instead of a guess. The timestamp is written
    /// AFTER contribute_internal's asserts, so a rejected contribution
    /// never leaves a time record behind.
    public fun contribute_timed<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        let sender = tx_context::sender(ctx);
        contribute_internal<T>(escrow, payment, ctx);
        record_contribution_time(escrow, sender, clock::timestamp_ms(clock));
    }

    /// Gated twin of `contribute_timed` (see `contribute_with_attestation`
    /// for the attestation semantics).
    public fun contribute_timed_with_attestation<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        attestation: &ComplianceAttestation,
        config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_attestation_valid(
            attestation, config, sender, escrow.compliance_config_id, clock
        );
        contribute_internal<T>(escrow, payment, ctx);
        record_contribution_time(escrow, sender, clock::timestamp_ms(clock));
    }

    fun record_contribution_time<T>(
        escrow: &mut CycleEscrow<T>,
        member: address,
        ts_ms: u64
    ) {
        let key = ContributionTimeKey { member };
        // contribute_internal's E_ALREADY_CONTRIBUTED makes a double-write
        // unreachable through the public paths; the exists_ guard is
        // defence in depth so a future caller cannot abort on a duplicate.
        if (df::exists_(&escrow.id, key)) {
            *df::borrow_mut<ContributionTimeKey, u64>(&mut escrow.id, key) = ts_ms;
        } else {
            df::add(&mut escrow.id, key, ts_ms);
        }
    }

    /// When this member's contribution landed, if it went through a
    /// *_timed path. `none` means NOT RECORDED — the `contributed` table,
    /// not this, answers whether they paid at all.
    public fun get_contribution_time<T>(
        escrow: &CycleEscrow<T>,
        member: address
    ): Option<u64> {
        let key = ContributionTimeKey { member };
        if (df::exists_(&escrow.id, key)) {
            option::some(*df::borrow<ContributionTimeKey, u64>(&escrow.id, key))
        } else {
            option::none()
        }
    }

    fun open_cycle_internal<T>(
        circle: &Circle,
        contribution_amount: u64,
        clock: &Clock,
        opener_gate_config_id: Option<ID>,
        ctx: &mut TxContext
    ): ID {
        // Authoritative compliance gate (June 2026 audit fix): the
        // circle-level on-chain flag is OR'd into whatever the caller
        // asked for. Opening a cycle is permissionless, so without this a
        // member could hand-roll the ungated `open_cycle` path and mint
        // an escrow that skips the KYC check the circle promised. Callers
        // can still request a gated escrow for an ungated circle (opt-in
        // tightening, `opener_gate_config_id` set by the *_with_gate
        // wrappers), but never the reverse.
        let circle_requires = circles::requires_attestation(circle);
        let gate_requested = option::is_some(&opener_gate_config_id);
        let requires_attestation = gate_requested || circle_requires;

        // Pin the exact ComplianceConfig object the gated paths will
        // accept (June 2026 adversarial-review repair). For a circle
        // whose admin enabled the requirement on-chain, the pin is the
        // admin's — never the permissionless opener's, who could
        // otherwise pin a config they control. The opener-presented
        // config only applies to opt-in gates on ungated circles.
        let compliance_config_id = if (circle_requires) {
            let pin = circles::pinned_compliance_config_id(circle);
            // set_requires_attestation keeps flag and pin in lockstep,
            // so a required circle always carries a pin; never open a
            // gated escrow that cannot name its config.
            assert!(option::is_some(&pin), E_COMPLIANCE_CONFIG_NOT_PINNED);
            pin
        } else if (gate_requested) {
            opener_gate_config_id
        } else {
            option::none()
        };

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
            compliance_config_id,
            refunded: false,
            claim_expires_at_ms: 0,
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
            requires_attestation,
            compliance_config_id,
        });

        transfer::share_object(escrow);
        escrow_id
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
    /// prevent a cheap "borrow someone else's pass" attack. The supplied
    /// `ComplianceConfig` must be the EXACT object this escrow pinned at
    /// open time (June 2026 adversarial-review repair — the gate must
    /// not trust whatever config the caller's PTB supplies); it pins the
    /// accepted issuer and carries the revocation registry, so a rogue
    /// cap's attestations and revoked passes both fail here.
    public fun contribute_with_attestation<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        attestation: &ComplianceAttestation,
        config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_attestation_valid(
            attestation, config, sender, escrow.compliance_config_id, clock
        );
        contribute_internal<T>(escrow, payment, ctx);
    }

    fun contribute_internal<T>(
        escrow: &mut CycleEscrow<T>,
        payment: Coin<T>,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.finalized, E_ALREADY_FINALIZED);
        assert!(!escrow.refunded, E_ESCROW_REFUNDED);

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

    /// Full attestation check for gated money paths, in order:
    ///   0. the supplied config IS the config object pinned on the
    ///      escrow at open time — checked before trusting anything the
    ///      config says, so a caller-supplied stale or fabricated config
    ///      can never vouch for an attestation (June 2026
    ///      adversarial-review repair);
    ///   1. the pass belongs to the sender (no borrowing someone else's);
    ///   2. it was signed by the issuer pinned in the shared config —
    ///      NOT just any AttestorCap holder;
    ///   3. it has not been revoked (registry in the shared config);
    ///   4. it has not expired.
    /// Each failure gets its own abort code for frontend mapping.
    /// `pinned_config_id` is `some` on every gated escrow; `none` only
    /// when a caller voluntarily presents a pass to an ungated escrow,
    /// where the gate carries no authority anyway (the ungated
    /// `contribute` path is open).
    fun assert_attestation_valid(
        attestation: &ComplianceAttestation,
        config: &ComplianceConfig,
        expected_subject: address,
        pinned_config_id: Option<ID>,
        clock: &Clock,
    ) {
        if (option::is_some(&pinned_config_id)) {
            assert!(
                object::id(config) == *option::borrow(&pinned_config_id),
                E_COMPLIANCE_CONFIG_MISMATCH,
            );
        };
        assert!(
            compliance::subject(attestation) == expected_subject,
            E_COMPLIANCE_ATTESTATION_INVALID,
        );
        assert!(
            compliance::issuer(attestation) == compliance::expected_issuer(config),
            E_ATTESTATION_WRONG_ISSUER,
        );
        assert!(
            !compliance::is_revoked_id(config, compliance::attestation_id(attestation)),
            E_ATTESTATION_REVOKED,
        );
        assert!(
            clock::timestamp_ms(clock) <= compliance::expires_at_ms(attestation),
            E_ATTESTATION_EXPIRED,
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
    /// caller's PTB instead of transferring it — for atomically finalizing
    /// and redeeming in one tx.
    ///
    /// RECIPIENT-ONLY, unlike `finalize_to_recipient`. `Claim` has `store`,
    /// so a caller who receives one can `public_transfer` it anywhere. While
    /// this was permissionless, any passer-by could finalize a funded cycle
    /// and send the Claim to an address nobody controls: funds not stealable
    /// (`redeem_claim` still checks `sender == recipient`), but the payout
    /// stranded until `refund_expired_claim` returns it to contributors 30
    /// days later — a denial-of-payout for the price of gas.
    ///
    /// This costs nothing in permissionlessness: `finalize_to_recipient` is
    /// still callable by anyone and always delivers to the frozen snapshot
    /// recipient, so a third party can still pay the gas to settle a cycle.
    /// They simply cannot take custody of the claim while doing it.
    public fun finalize<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ): Claim<T> {
        assert!(!escrow.requires_attestation, E_COMPLIANCE_ATTESTATION_REQUIRED);
        assert!(tx_context::sender(ctx) == escrow.snapshot.recipient, E_NOT_RECIPIENT);
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
        // Authoritative redeem-after-refund guard: once any refund path
        // has started, the pot belongs to the contributors again and the
        // claim is void. Checked before the expiry assert so the abort
        // code is unambiguous.
        assert!(!escrow.refunded, E_ESCROW_REFUNDED);
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
    /// own valid ComplianceAttestation (issuer-pinned + revocation-checked
    /// against the exact config object this escrow pinned at open time).
    /// Combined with the contribute-side gate, this means nobody can pay
    /// into or collect from a compliance-enforced escrow without a
    /// current partner-led KYC check on file.
    public fun finalize_and_redeem_with_attestation<T>(
        escrow: &mut CycleEscrow<T>,
        attestation: &ComplianceAttestation,
        config: &ComplianceConfig,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert_attestation_valid(
            attestation, config, sender, escrow.compliance_config_id, clock
        );
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
    // Refund paths (audit fix: escrow funds must never be stranded)
    //
    // Both paths are permissionless and deterministic: anyone may pay
    // the gas, and every coin can only ever go back to the exact
    // address that contributed it (recorded in the `contributed`
    // table, all entries equal to the snapshot's contribution amount).
    // Neither path takes a `&Circle`, so a paused, stopped, or
    // recovering circle can never block an escrow refund.
    // ----------------------------------------------------------

    /// Cancels an escrow that never finalized and returns each recorded
    /// contributor their exact recorded contribution. Permissionless,
    /// callable once the cycle's snapshot due date plus a 7-day grace
    /// period has elapsed. Safe to call repeatedly: each call refunds
    /// whatever recorded contributors remain and aborts cleanly with
    /// `E_NOTHING_TO_REFUND` when there is nothing left to process.
    public fun cancel_unfinalized_escrow<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(!escrow.finalized, E_ALREADY_FINALIZED);
        let now = clock::timestamp_ms(clock);
        assert!(now >= escrow.snapshot.due_at_ms + CANCEL_GRACE_MS, E_CANCEL_TOO_EARLY);
        cancel_internal(escrow, now, ctx);
    }

    /// Recovery wire-in: once the circle's member-voted recovery has
    /// executed (recovery state STOPPED or REFUNDED), an unfinalized
    /// escrow may be cancelled immediately — no need to wait for the
    /// snapshot due date plus grace. Still permissionless and still
    /// only able to send funds back to the recorded contributors; the
    /// recovery vote itself is the member-initiated authorization.
    public fun cancel_unfinalized_escrow_for_recovery<T>(
        escrow: &mut CycleEscrow<T>,
        circle: &Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(escrow.circle_id == circles::get_id(circle), E_CYCLE_MISMATCH);
        let state = circles::get_recovery_state(circle);
        assert!(
            state == config::recovery_state_stopped()
                || state == config::recovery_state_refunded(),
            E_CIRCLE_NOT_IN_RECOVERY
        );
        assert!(!escrow.finalized, E_ALREADY_FINALIZED);
        cancel_internal(escrow, clock::timestamp_ms(clock), ctx);
    }

    fun cancel_internal<T>(
        escrow: &mut CycleEscrow<T>,
        now: u64,
        ctx: &mut TxContext
    ) {
        if (!escrow.refunded) {
            escrow.refunded = true;
            event::emit(EscrowCancelled {
                escrow_id: object::uid_to_inner(&escrow.id),
                circle_id: escrow.circle_id,
                cycle_no: escrow.snapshot.cycle_no,
                contributors: escrow.contributors_count,
                total_refund: balance::value(&escrow.balance),
                cancelled_at_ms: now,
            });
        };
        let refunded_count = refund_recorded_contributors(escrow, ctx);
        assert!(refunded_count > 0, E_NOTHING_TO_REFUND);
    }

    /// Refunds a finalized escrow whose `Claim` expired unredeemed (the
    /// recipient never showed up within the 30-day window). Splits the
    /// escrow balance back to the recorded contributors — contributions
    /// are equal amounts, so the division is exact; any defensive
    /// rounding remainder is swept to the last refunded contributor.
    /// Permissionless. Double-spend safety:
    ///   - refund-after-redeem is impossible: `claimed` is asserted false
    ///     here, and redeem sets it true while draining the balance;
    ///   - redeem-after-refund is impossible: this only runs strictly
    ///     after the claim's expiry (redeem aborts `E_CLAIM_EXPIRED`)
    ///     AND it sets `refunded`, which redeem checks explicitly.
    public fun refund_expired_claim<T>(
        escrow: &mut CycleEscrow<T>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(escrow.finalized, E_NOT_FINALIZED);
        assert!(!escrow.claimed, E_ALREADY_CLAIMED);
        let now = clock::timestamp_ms(clock);
        // Strictly after expiry: redeem allows `now <= expires`, refund
        // requires `now > expires` — no timestamp satisfies both.
        assert!(now > escrow.claim_expires_at_ms, E_CLAIM_NOT_EXPIRED);

        if (!escrow.refunded) {
            escrow.refunded = true;
            event::emit(ExpiredClaimRefunded {
                escrow_id: object::uid_to_inner(&escrow.id),
                circle_id: escrow.circle_id,
                cycle_no: escrow.snapshot.cycle_no,
                recipient: escrow.snapshot.recipient,
                contributors: escrow.contributors_count,
                total_refund: balance::value(&escrow.balance),
                refunded_at_ms: now,
            });
        };
        let refunded_count = refund_recorded_contributors(escrow, ctx);
        assert!(refunded_count > 0, E_NOTHING_TO_REFUND);
    }

    /// Returns each remaining recorded contributor their exact recorded
    /// contribution and removes them from the `contributed` table, so
    /// repeated calls are idempotent (already-refunded members are gone
    /// from the table and can never be paid twice). Returns the number
    /// of contributors refunded in this call.
    fun refund_recorded_contributors<T>(
        escrow: &mut CycleEscrow<T>,
        ctx: &mut TxContext
    ): u64 {
        let members = escrow.snapshot.members;
        let per_member = escrow.snapshot.contribution_amount;
        let escrow_id = object::uid_to_inner(&escrow.id);
        let cycle_no = escrow.snapshot.cycle_no;
        let len = vector::length(&members);
        let mut i = 0;
        let mut refunded_count = 0u64;
        let mut last_refunded = @0x0;
        while (i < len) {
            let addr = *vector::borrow(&members, i);
            if (table::contains(&escrow.contributed, addr)) {
                table::remove(&mut escrow.contributed, addr);
                escrow.contributors_count = escrow.contributors_count - 1;
                // Defensive clamp: contributions are recorded at exactly
                // `per_member`, so the balance always covers the refund;
                // never abort mid-drain if an invariant ever broke.
                let available = balance::value(&escrow.balance);
                let refund_amount = if (per_member <= available) { per_member } else { available };
                if (refund_amount > 0) {
                    let refund_balance = balance::split(&mut escrow.balance, refund_amount);
                    transfer::public_transfer(coin::from_balance(refund_balance, ctx), addr);
                };
                event::emit(ContributionRefunded {
                    escrow_id,
                    cycle_no,
                    contributor: addr,
                    amount: refund_amount,
                });
                refunded_count = refunded_count + 1;
                last_refunded = addr;
            };
            i = i + 1;
        };
        // Once no recorded contributor remains, sweep any rounding
        // remainder (none expected: equal contributions divide exactly)
        // to the last refunded contributor so the escrow drains to zero.
        if (refunded_count > 0 && escrow.contributors_count == 0) {
            let remainder = balance::value(&escrow.balance);
            if (remainder > 0) {
                let rem_balance = balance::split(&mut escrow.balance, remainder);
                transfer::public_transfer(coin::from_balance(rem_balance, ctx), last_refunded);
                event::emit(ContributionRefunded {
                    escrow_id,
                    cycle_no,
                    contributor: last_refunded,
                    amount: remainder,
                });
            };
        };
        refunded_count
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
    public fun is_refunded<T>(escrow: &CycleEscrow<T>): bool { escrow.refunded }
    public fun claim_expires_at_ms<T>(escrow: &CycleEscrow<T>): u64 { escrow.claim_expires_at_ms }
    public fun due_at_ms<T>(escrow: &CycleEscrow<T>): u64 { escrow.snapshot.due_at_ms }
    public fun cancel_grace_ms(): u64 { CANCEL_GRACE_MS }
    public fun claim_window_ms(): u64 { CLAIM_WINDOW_MS }
    public fun requires_attestation<T>(escrow: &CycleEscrow<T>): bool { escrow.requires_attestation }
    public fun pinned_compliance_config_id<T>(escrow: &CycleEscrow<T>): Option<ID> {
        escrow.compliance_config_id
    }
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
        assert!(!escrow.refunded, E_ESCROW_REFUNDED);
        assert!(escrow.contributors_count >= escrow.snapshot.required_contributors, E_NOT_FULLY_FUNDED);
        escrow.finalized = true;

        let amount = balance::value(&escrow.balance);
        let escrow_id = object::uid_to_inner(&escrow.id);
        let cycle_no = escrow.snapshot.cycle_no;
        let recipient = escrow.snapshot.recipient;
        let expires_at_ms = clock::timestamp_ms(clock) + CLAIM_WINDOW_MS;
        // Mirror the claim expiry on the escrow so the expired-claim
        // refund path can run without access to the owned Claim object.
        escrow.claim_expires_at_ms = expires_at_ms;

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
            // Guard every step: 10^20 would silently wrap u64 otherwise.
            assert!(result <= MAX_U64 / 10, E_AMOUNT_OVERFLOW);
            result = result * 10;
            i = i + 1;
        };
        result
    }

    /// Converts the circle's stored USD contribution (in cents) into the
    /// base units of a USD-pegged stablecoin with `stable_decimals`
    /// decimals. e.g. 30 cents at 6 decimals (USDC) → 300000 base units.
    /// Both the decimals range and the final multiplication are guarded
    /// so a hostile caller-supplied `stable_decimals` aborts instead of
    /// wrapping into a tiny (or huge) contribution target.
    fun stable_contribution_amount(circle: &Circle, stable_decimals: u8): u64 {
        assert!(
            stable_decimals >= 2 && stable_decimals <= MAX_STABLE_DECIMALS,
            E_INVALID_DECIMALS
        );
        let cents = circles::get_contribution_amount_usd(circle);
        let scale = pow10(stable_decimals - 2);
        assert!(cents <= MAX_U64 / scale, E_AMOUNT_OVERFLOW);
        cents * scale
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
    public fun filter_active_members_for_testing(
        rotation: vector<address>
    ): vector<address> {
        filter_active_members(&rotation)
    }

    #[test]
    fun test_filter_active_members_drops_zero_and_dedupes() {
        let v = vector[@0x1, @0x0, @0x2, @0x1, @0x3];
        let out = filter_active_members_for_testing(v);
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

    // ----------------------------------------------------------
    // Lifecycle tests: contribute / cancel / finalize / expire /
    // refund / redeem / advance. These run the REAL entrypoints
    // against a shared test circle (see njangi_circles test factory).
    // ----------------------------------------------------------

    #[test_only] use sui::test_scenario as ts;
    #[test_only] use sui::sui::SUI;
    #[test_only] use njangi::njangi_compliance::AttestorCap;

    #[test_only] const TEST_ADMIN: address = @0xA11CE;
    #[test_only] const TEST_BOB: address = @0xB0B;
    #[test_only] const TEST_CAROL: address = @0xCA801;
    #[test_only] const TEST_ISSUER: address = @0x155;
    #[test_only] const TEST_MULTISIG: address = @0x156;
    #[test_only] const TEST_ROGUE: address = @0x157;
    #[test_only] const TEST_CONTRIBUTION: u64 = 1_000_000_000; // 1 SUI
    #[test_only] const TEST_USD_CENTS: u64 = 250;
    #[test_only] const TEST_START_MS: u64 = 1_000_000;
    #[test_only] const TEST_SEVEN_DAYS_MS: u64 = 604_800_000;
    #[test_only] const TEST_TTL_MS: u64 = 86_400_000; // 24h

    /// tx1 (admin): share a 3-member active circle; tx2 (admin): open
    /// the ungated SUI escrow for the current cycle. Recipient is the
    /// admin (rotation position 0), so BOB + CAROL are the 2 required
    /// contributors. Returns the test clock (set to TEST_START_MS).
    #[test_only]
    fun setup_circle_and_escrow(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(scenario)
        );

        ts::next_tx(scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(scenario);
        open_cycle<SUI>(&circle, &clock, ts::ctx(scenario));
        ts::return_shared(circle);
        clock
    }

    #[test_only]
    fun contribute_as(scenario: &mut ts::Scenario, who: address) {
        ts::next_tx(scenario, who);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(scenario));
        contribute(&mut escrow, payment, ts::ctx(scenario));
        ts::return_shared(escrow);
    }

    #[test_only]
    fun setup_circle_and_indexed_escrow(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(scenario)
        );

        ts::next_tx(scenario, TEST_ADMIN);
        let mut circle = ts::take_shared<Circle>(scenario);
        open_cycle_indexed<SUI>(&mut circle, &clock, ts::ctx(scenario));
        ts::return_shared(circle);
        clock
    }

    #[test_only]
    fun contribute_timed_as(scenario: &mut ts::Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(scenario));
        contribute_timed(&mut escrow, payment, clock, ts::ctx(scenario));
        ts::return_shared(escrow);
    }

    // ----------------------------------------------------------
    // Circle Record v1.1: escrow history + contribution timestamps
    // ----------------------------------------------------------

    #[test]
    fun test_indexed_open_records_escrow_history() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_indexed_escrow(&mut scenario);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(&mut scenario);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&mut scenario);

        let history = circles::get_escrow_history(&circle);
        assert!(vector::length(&history) == 1, 9300);
        assert!(*vector::borrow(&history, 0) == object::id(&escrow), 9301);

        ts::return_shared(escrow);
        ts::return_shared(circle);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_plain_open_leaves_history_empty() {
        // Circles that only ever used the original opens must read as
        // "no data", not "no cycles" — this pins the empty baseline.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(&mut scenario);
        assert!(vector::length(&circles::get_escrow_history(&circle)) == 0, 9310);
        ts::return_shared(circle);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_contribute_timed_records_timestamp() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_indexed_escrow(&mut scenario);
        let paid_at = TEST_START_MS + 86_400_000; // one day in
        clock::set_for_testing(&mut clock, paid_at);

        contribute_timed_as(&mut scenario, TEST_BOB, &clock);

        ts::next_tx(&mut scenario, TEST_BOB);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&mut scenario);
        let recorded = get_contribution_time(&escrow, TEST_BOB);
        assert!(option::is_some(&recorded), 9320);
        assert!(*option::borrow(&recorded) == paid_at, 9321);
        // The contributed table stays the authority on WHO paid.
        assert!(has_member_contributed(&escrow, TEST_BOB), 9322);
        ts::return_shared(escrow);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_plain_contribute_records_no_timestamp() {
        // A legacy-path contribution must read as "not recorded", never
        // as "not contributed" — the split the UI depends on.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_indexed_escrow(&mut scenario);

        contribute_as(&mut scenario, TEST_BOB);

        ts::next_tx(&mut scenario, TEST_BOB);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&mut scenario);
        assert!(option::is_none(&get_contribution_time(&escrow, TEST_BOB)), 9330);
        assert!(has_member_contributed(&escrow, TEST_BOB), 9331);
        ts::return_shared(escrow);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_CONTRIBUTED)]
    fun test_contribute_timed_still_rejects_double_pay() {
        // The timed path must inherit every assert of the original — a
        // second payment aborts before any timestamp write.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_indexed_escrow(&mut scenario);
        contribute_timed_as(&mut scenario, TEST_BOB, &clock);
        contribute_timed_as(&mut scenario, TEST_BOB, &clock);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_indexed_open_appends() {
        // Two indexed opens -> two history entries, append-only.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_indexed_escrow(&mut scenario);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut circle = ts::take_shared<Circle>(&mut scenario);
        open_cycle_indexed<SUI>(&mut circle, &clock, ts::ctx(&mut scenario));
        let history = circles::get_escrow_history(&circle);
        assert!(vector::length(&history) == 2, 9340);
        ts::return_shared(circle);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test_only]
    fun assert_received_refund(scenario: &mut ts::Scenario, who: address, amount: u64) {
        ts::next_tx(scenario, who);
        let refund = ts::take_from_sender<Coin<SUI>>(scenario);
        assert!(coin::value(&refund) == amount, 9201);
        coin::burn_for_testing(refund);
    }

    // --- cancel path -------------------------------------------------

    #[test]
    fun test_contribute_then_cancel_refunds_exact_amounts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);

        // Underfunded cycle: only BOB pays in; CAROL drops out.
        contribute_as(&mut scenario, TEST_BOB);

        // Anyone may cancel once due date + grace has elapsed.
        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_SEVEN_DAYS_MS + CANCEL_GRACE_MS);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        cancel_unfinalized_escrow(&mut escrow, &clock, ts::ctx(&mut scenario));
        assert!(is_refunded(&escrow), 9202);
        assert!(contributor_count(&escrow) == 0, 9203);
        assert!(total_contributed(&escrow) == 0, 9204);
        ts::return_shared(escrow);

        // BOB got back exactly what he recorded.
        assert_received_refund(&mut scenario, TEST_BOB, TEST_CONTRIBUTION);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_CANCEL_TOO_EARLY)]
    fun test_cancel_before_deadline_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);

        // One millisecond before due + grace: must abort.
        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_SEVEN_DAYS_MS + CANCEL_GRACE_MS - 1);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        cancel_unfinalized_escrow(&mut escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_NOTHING_TO_REFUND)]
    fun test_double_cancel_aborts_cleanly() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);

        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_SEVEN_DAYS_MS + CANCEL_GRACE_MS);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        cancel_unfinalized_escrow(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // Second cancel: everything already refunded — abort cleanly.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        cancel_unfinalized_escrow(&mut escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_FINALIZED)]
    fun test_cancel_after_finalize_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_SEVEN_DAYS_MS + CANCEL_GRACE_MS);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        cancel_unfinalized_escrow(&mut escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ESCROW_REFUNDED)]
    fun test_contribute_after_cancel_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);

        clock::set_for_testing(&mut clock, TEST_START_MS + TEST_SEVEN_DAYS_MS + CANCEL_GRACE_MS);
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        cancel_unfinalized_escrow(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // The escrow is dead; late contributions must bounce.
        contribute_as(&mut scenario, TEST_CAROL);
        abort 0
    }

    // --- expired-claim refund path -----------------------------------

    #[test]
    fun test_finalize_then_expire_then_refund_returns_contributions() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        // Fully funded: anyone finalizes; Claim goes to the recipient.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        assert!(claim_expires_at_ms(&escrow) == TEST_START_MS + CLAIM_WINDOW_MS, 9210);
        ts::return_shared(escrow);

        // Recipient never redeems; window expires.
        clock::set_for_testing(&mut clock, TEST_START_MS + CLAIM_WINDOW_MS + 1);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        refund_expired_claim(&mut escrow, &clock, ts::ctx(&mut scenario));
        assert!(is_refunded(&escrow), 9211);
        assert!(!is_claimed(&escrow), 9212);
        assert!(total_contributed(&escrow) == 0, 9213);
        ts::return_shared(escrow);

        // Both contributors get back exactly their recorded amounts.
        assert_received_refund(&mut scenario, TEST_BOB, TEST_CONTRIBUTION);
        assert_received_refund(&mut scenario, TEST_CAROL, TEST_CONTRIBUTION);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_RECIPIENT)]
    fun test_finalize_by_non_recipient_aborts() {
        // Regression for the payout-denial grief. `finalize` hands back a
        // Claim, and Claim has `store`, so a non-recipient caller could
        // public_transfer it somewhere unreachable and strand the payout for
        // 30 days. Only the recipient may take custody of their own claim.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let claim = finalize(&mut escrow, &clock, ts::ctx(&mut scenario));
        transfer::public_transfer(claim, @0xDEAD);
        abort 0
    }

    #[test]
    fun test_finalize_to_recipient_stays_permissionless() {
        // The counterpart guarantee: locking `finalize` must NOT make cycle
        // settlement require the recipient to be online. A third party can
        // still pay the gas — they just cannot hold the claim.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        // Carol (not the recipient) settles the cycle.
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // It landed with the snapshot recipient, not the caller.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let claim = ts::take_from_sender<Claim<SUI>>(&scenario);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let payout = redeem_claim(&mut escrow, claim, &clock, ts::ctx(&mut scenario));
        assert!(coin::value(&payout) == TEST_CONTRIBUTION * 2, 0);
        transfer::public_transfer(payout, TEST_ADMIN);
        ts::return_shared(escrow);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // ------------------------------------------------------------------
    // Contribution-rule enforcement.
    //
    // The escrow's compliance argument rests on the snapshot being binding:
    // fixed amount, fixed member set, one contribution each, recipient
    // excluded. Refunds were already well covered; these are the rules half,
    // which had no tests at all.
    // ------------------------------------------------------------------

    #[test]
    #[expected_failure(abort_code = E_BAD_AMOUNT)]
    fun test_contribute_with_wrong_amount_aborts() {
        // Exact equality, not >=. An over-payment is as invalid as an
        // under-payment: the snapshot fixes the amount, and accepting a
        // different one would make the payout total unpredictable.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION + 1, ts::ctx(&mut scenario));
        contribute(&mut escrow, payment, ts::ctx(&mut scenario));
        ts::return_shared(escrow);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_BAD_AMOUNT)]
    fun test_contribute_with_short_amount_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION - 1, ts::ctx(&mut scenario));
        contribute(&mut escrow, payment, ts::ctx(&mut scenario));
        ts::return_shared(escrow);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_CONTRIBUTED)]
    fun test_double_contribution_aborts() {
        // Without this a single member could fund the whole pot and the
        // refund table would owe them more than one share.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_BOB);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_MEMBER)]
    fun test_non_member_contribution_aborts() {
        // The member set is frozen at open. An outsider paying in would be
        // owed a refund the snapshot has no record of.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, @0xDEAD);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_RECIPIENT_CANNOT_CONTRIBUTE)]
    fun test_recipient_contribution_aborts() {
        // required_contributors is member_count - 1 precisely because the
        // recipient does not pay into their own payout. Letting them
        // contribute would inflate the count and finalize the cycle a
        // contributor short.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_ADMIN);
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_RECIPIENT)]
    fun test_redeem_by_non_recipient_aborts() {
        // The single most important assert in the module: the payout is
        // redeemable only by the address frozen into the snapshot at open.
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // Bob gets hold of the recipient's Claim and tries to cash it.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let claim = ts::take_from_address<Claim<SUI>>(&scenario, TEST_ADMIN);
        let payout = redeem_claim(&mut escrow, claim, &clock, ts::ctx(&mut scenario));
        transfer::public_transfer(payout, TEST_BOB);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ESCROW_REFUNDED)]
    fun test_redeem_after_refund_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        clock::set_for_testing(&mut clock, TEST_START_MS + CLAIM_WINDOW_MS + 1);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        refund_expired_claim(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // The recipient surfaces with the stale Claim: must abort.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let claim = ts::take_from_sender<Claim<SUI>>(&scenario);
        let payout = redeem_claim(&mut escrow, claim, &clock, ts::ctx(&mut scenario));
        transfer::public_transfer(payout, TEST_ADMIN);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_CLAIMED)]
    fun test_refund_after_redeem_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        // Recipient collects the pot inside the window.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_and_redeem(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // Even after expiry, a redeemed escrow can never be refunded.
        clock::set_for_testing(&mut clock, TEST_START_MS + CLAIM_WINDOW_MS + 1);
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        refund_expired_claim(&mut escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_CLAIM_NOT_EXPIRED)]
    fun test_refund_before_expiry_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        // Exactly at expiry the claim is still redeemable: refund must wait.
        clock::set_for_testing(&mut clock, TEST_START_MS + CLAIM_WINDOW_MS);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        refund_expired_claim(&mut escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // --- recovery wire-in --------------------------------------------

    #[test]
    fun test_cancel_for_recovery_skips_grace_period() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);

        // Circle recovery executes well before the cycle due date.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::mark_recovery_stopped_for_testing(&mut circle, &clock);
        ts::return_shared(circle);

        // Escrow refund is immediately available, permissionlessly.
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let circle = ts::take_shared<Circle>(&scenario);
        cancel_unfinalized_escrow_for_recovery(&mut escrow, &circle, &clock, ts::ctx(&mut scenario));
        assert!(is_refunded(&escrow), 9220);
        assert!(total_contributed(&escrow) == 0, 9221);
        ts::return_shared(circle);
        ts::return_shared(escrow);

        assert_received_refund(&mut scenario, TEST_BOB, TEST_CONTRIBUTION);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_CIRCLE_NOT_IN_RECOVERY)]
    fun test_cancel_for_recovery_requires_recovery_state() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);

        // Healthy circle: the no-wait recovery path must refuse.
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let circle = ts::take_shared<Circle>(&scenario);
        cancel_unfinalized_escrow_for_recovery(&mut escrow, &circle, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // --- advance_circle_after_claim ----------------------------------

    #[test]
    fun test_advance_circle_after_claim_happy_path() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        // Recipient collects the pot.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_and_redeem(&mut escrow, &clock, ts::ctx(&mut scenario));
        assert!(is_claimed(&escrow), 9230);
        ts::return_shared(escrow);
        // The pot was 2 contributions (recipient does not pay in).
        assert_received_refund(&mut scenario, TEST_ADMIN, 2 * TEST_CONTRIBUTION);

        // Anyone rotates the circle forward off the claimed escrow.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        advance_circle_after_claim(&mut circle, &escrow, &clock, ts::ctx(&mut scenario));
        assert!(circles::get_current_position(&circle) == 1, 9231);
        let next_recipient = circles::get_next_payout_recipient(&circle);
        assert!(option::is_some(&next_recipient), 9232);
        assert!(*option::borrow(&next_recipient) == TEST_BOB, 9233);
        ts::return_shared(escrow);
        ts::return_shared(circle);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_ADVANCED)]
    fun test_advance_circle_after_claim_rejects_replay() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_and_redeem(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        advance_circle_after_claim(&mut circle, &escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);
        ts::return_shared(circle);

        // Replay: the circle has moved on to BOB's round — must abort.
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        advance_circle_after_claim(&mut circle, &escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_CLAIMED)]
    fun test_advance_circle_after_claim_requires_claimed_escrow() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_escrow(&mut scenario);
        contribute_as(&mut scenario, TEST_BOB);
        contribute_as(&mut scenario, TEST_CAROL);

        // Finalized but never redeemed: rotation must not advance.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        ts::return_shared(escrow);

        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        advance_circle_after_claim(&mut circle, &escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // --- compliance gate ----------------------------------------------

    #[test_only]
    fun hash32(): vector<u8> {
        x"0202020202020202020202020202020202020202020202020202020202020202"
    }

    /// tx1 (admin): share a 3-member circle; tx2 (issuer): real
    /// compliance bootstrap (cap + singleton config to TEST_ISSUER);
    /// tx3 (admin): pin the canonical config + flip the circle's
    /// on-chain requires_attestation flag ON, then open the escrow via
    /// the UNGATED entrypoint — the circle flag must force the gate
    /// (and carry the admin's pin) anyway. Returns the test clock
    /// (set to TEST_START_MS).
    #[test_only]
    fun setup_gated_circle_and_escrow(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(scenario)
        );

        ts::next_tx(scenario, TEST_ISSUER);
        compliance::init_for_testing(ts::ctx(scenario));

        ts::next_tx(scenario, TEST_ADMIN);
        let mut circle = ts::take_shared<Circle>(scenario);
        let config = ts::take_shared<ComplianceConfig>(scenario);
        circles::set_requires_attestation(
            &mut circle, &config, true, &clock, ts::ctx(scenario)
        );
        // Deliberately the UNGATED open: a permissionless caller must not
        // be able to mint an ungated escrow for a gated circle.
        open_cycle<SUI>(&circle, &clock, ts::ctx(scenario));
        ts::return_shared(config);
        ts::return_shared(circle);
        clock
    }

    #[test_only]
    fun issue_attestation_to(
        scenario: &mut ts::Scenario,
        subject: address,
        ttl_ms: u64,
        clock: &Clock
    ) {
        ts::next_tx(scenario, TEST_ISSUER);
        let cap = ts::take_from_sender<AttestorCap>(scenario);
        compliance::issue(&cap, subject, hash32(), hash32(), ttl_ms, clock, ts::ctx(scenario));
        ts::return_to_sender(scenario, cap);
    }

    #[test_only]
    fun contribute_with_attestation_as(
        scenario: &mut ts::Scenario,
        who: address,
        clock: &Clock
    ) {
        ts::next_tx(scenario, who);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(scenario);
        let config = ts::take_shared<ComplianceConfig>(scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(scenario));
        contribute_with_attestation(
            &mut escrow, payment, &attestation, &config, clock, ts::ctx(scenario)
        );
        ts::return_to_sender(scenario, attestation);
        ts::return_shared(config);
        ts::return_shared(escrow);
    }

    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_ATTESTATION_REQUIRED)]
    fun test_gated_circle_rejects_unattested_contributor() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let _clock = setup_gated_circle_and_escrow(&mut scenario);
        // BOB hand-rolls the ungated contribute on a gated circle's escrow.
        contribute_as(&mut scenario, TEST_BOB);
        abort 0
    }

    #[test]
    fun test_gated_circle_full_lifecycle_with_attestations() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_gated_circle_and_escrow(&mut scenario);

        // The UNGATED open inherited the circle's on-chain gate AND the
        // admin-pinned config id.
        ts::next_tx(&mut scenario, TEST_BOB);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        assert!(requires_attestation(&escrow), 9260);
        let pin = pinned_compliance_config_id(&escrow);
        assert!(option::is_some(&pin), 9262);
        assert!(*option::borrow(&pin) == object::id(&config), 9263);
        ts::return_shared(config);
        ts::return_shared(escrow);

        issue_attestation_to(&mut scenario, TEST_BOB, TEST_TTL_MS, &clock);
        issue_attestation_to(&mut scenario, TEST_CAROL, TEST_TTL_MS, &clock);
        issue_attestation_to(&mut scenario, TEST_ADMIN, TEST_TTL_MS, &clock);

        // Attested members pass the gate.
        contribute_with_attestation_as(&mut scenario, TEST_BOB, &clock);
        contribute_with_attestation_as(&mut scenario, TEST_CAROL, &clock);

        // The recipient collects with their own attestation.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        finalize_and_redeem_with_attestation(
            &mut escrow, &attestation, &config, &clock, ts::ctx(&mut scenario)
        );
        assert!(is_claimed(&escrow), 9261);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);
        ts::return_shared(escrow);

        assert_received_refund(&mut scenario, TEST_ADMIN, 2 * TEST_CONTRIBUTION);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_ATTESTATION_EXPIRED)]
    fun test_gated_contribute_rejects_expired_attestation() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = setup_gated_circle_and_escrow(&mut scenario);
        issue_attestation_to(&mut scenario, TEST_BOB, 1_000, &clock);

        // One millisecond past expiry: the pass is dead.
        clock::set_for_testing(&mut clock, TEST_START_MS + 1_001);
        contribute_with_attestation_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ATTESTATION_WRONG_ISSUER)]
    fun test_gated_contribute_rejects_wrong_issuer() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_gated_circle_and_escrow(&mut scenario);

        // A rogue cap issues BOB a pass from a non-pinned address; the
        // gate must reject it even though the attestation itself is real.
        ts::next_tx(&mut scenario, TEST_ROGUE);
        let rogue_cap = compliance::new_attestor_cap_for_testing(ts::ctx(&mut scenario));
        compliance::issue(
            &rogue_cap, TEST_BOB, hash32(), hash32(), TEST_TTL_MS, &clock,
            ts::ctx(&mut scenario)
        );
        compliance::destroy_attestor_cap_for_testing(rogue_cap);

        contribute_with_attestation_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_ATTESTATION_REVOKED)]
    fun test_gated_contribute_rejects_attestation_revoked_after_cap_transfer() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_gated_circle_and_escrow(&mut scenario);
        issue_attestation_to(&mut scenario, TEST_BOB, TEST_TTL_MS, &clock);

        // The issuance cap moves to the operations multisig...
        ts::next_tx(&mut scenario, TEST_ISSUER);
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        compliance::transfer_attestor_cap(cap, TEST_MULTISIG, ts::ctx(&mut scenario));

        // ...whose holder revokes BOB's pass by id, even though it was
        // issued by the OLD address and lives in BOB's account.
        ts::next_tx(&mut scenario, TEST_BOB);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        let id = compliance::attestation_id(&attestation);
        ts::return_to_sender(&mut scenario, attestation);

        ts::next_tx(&mut scenario, TEST_MULTISIG);
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        compliance::revoke(&cap, &mut config, id, &clock, ts::ctx(&mut scenario));
        ts::return_shared(config);
        ts::return_to_sender(&mut scenario, cap);

        contribute_with_attestation_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_ATTESTATION_INVALID)]
    fun test_gated_contribute_rejects_borrowed_attestation() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_gated_circle_and_escrow(&mut scenario);
        issue_attestation_to(&mut scenario, TEST_CAROL, TEST_TTL_MS, &clock);

        // BOB presents CAROL's pass: subject != sender must abort.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_address<ComplianceAttestation>(&scenario, TEST_CAROL);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(&mut scenario));
        contribute_with_attestation(
            &mut escrow, payment, &attestation, &config, &clock, ts::ctx(&mut scenario)
        );
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_ATTESTATION_REQUIRED)]
    fun test_gated_escrow_rejects_ungated_finalize() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_gated_circle_and_escrow(&mut scenario);
        issue_attestation_to(&mut scenario, TEST_BOB, TEST_TTL_MS, &clock);
        issue_attestation_to(&mut scenario, TEST_CAROL, TEST_TTL_MS, &clock);
        contribute_with_attestation_as(&mut scenario, TEST_BOB, &clock);
        contribute_with_attestation_as(&mut scenario, TEST_CAROL, &clock);

        // Fully funded, but the ungated finalize path must stay closed.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        finalize_to_recipient(&mut escrow, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    /// Regression test for the June 2026 adversarial-review exploit:
    /// a member of a gated circle manufactures a parallel compliance
    /// universe — their own ComplianceConfig (admin + expected_issuer =
    /// themselves) and their own AttestorCap — then self-issues a
    /// "valid" pass and supplies BOTH objects in their own PTB. Every
    /// pre-existing check passes against the rogue config (subject ==
    /// sender, issuer == that config's expected_issuer, not revoked,
    /// not expired); only the escrow's pinned config id stops it.
    /// (On-chain, creating the rogue config at all now also requires
    /// this lineage's UpgradeCap — see the njangi_compliance tests; this
    /// test reaches past that first wall via the test-only init to prove
    /// the second wall holds independently.)
    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_CONFIG_MISMATCH)]
    fun test_gated_contribute_rejects_fabricated_config() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_gated_circle_and_escrow(&mut scenario);

        // TEST_ROGUE bootstraps their own config + cap...
        ts::next_tx(&mut scenario, TEST_ROGUE);
        compliance::init_for_testing(ts::ctx(&mut scenario));

        // ...and self-issues TEST_BOB (a real circle member) a pass that
        // is perfectly valid against the rogue config.
        ts::next_tx(&mut scenario, TEST_ROGUE);
        let rogue_config_id = option::destroy_some(
            ts::most_recent_id_shared<ComplianceConfig>()
        );
        let rogue_cap = ts::take_from_sender<AttestorCap>(&scenario);
        compliance::issue(
            &rogue_cap, TEST_BOB, hash32(), hash32(), TEST_TTL_MS, &clock,
            ts::ctx(&mut scenario)
        );
        ts::return_to_sender(&mut scenario, rogue_cap);

        // BOB presents the rogue pass + rogue config: the pinned config
        // id must kill it.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        let rogue_config = ts::take_shared_by_id<ComplianceConfig>(
            &scenario, rogue_config_id
        );
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION, ts::ctx(&mut scenario));
        contribute_with_attestation(
            &mut escrow, payment, &attestation, &rogue_config, &clock,
            ts::ctx(&mut scenario)
        );
        abort 0
    }

    /// Opt-in gate on an UNGATED circle: the opener's presented config
    /// becomes the escrow's pin.
    #[test]
    fun test_open_cycle_with_gate_pins_opener_config() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, TEST_ISSUER);
        compliance::init_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        open_cycle_with_gate<SUI>(&circle, &config, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        assert!(requires_attestation(&escrow), 9270);
        let pin = pinned_compliance_config_id(&escrow);
        assert!(option::is_some(&pin), 9271);
        assert!(*option::borrow(&pin) == object::id(&config), 9272);
        ts::return_shared(escrow);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // --- arithmetic guards -------------------------------------------

    #[test_only]
    public fun pow10_for_testing(exp: u8): u64 { pow10(exp) }

    #[test]
    fun test_pow10_in_range() {
        assert!(pow10_for_testing(0) == 1, 9240);
        assert!(pow10_for_testing(4) == 10_000, 9241);
        assert!(pow10_for_testing(19) == 10_000_000_000_000_000_000, 9242);
    }

    #[test]
    #[expected_failure(abort_code = E_AMOUNT_OVERFLOW)]
    fun test_pow10_overflow_aborts() {
        pow10_for_testing(20);
    }

    #[test]
    fun test_open_cycle_stable_derives_target_from_usd() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS, // $2.50
            &clock,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        open_cycle_stable<SUI>(&circle, 6, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);

        // 250 cents at 6 decimals => 250 * 10^4 = 2_500_000 base units.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let escrow = ts::take_shared<CycleEscrow<SUI>>(&scenario);
        assert!(contribution_amount(&escrow) == 2_500_000, 9250);
        ts::return_shared(escrow);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_INVALID_DECIMALS)]
    fun test_open_cycle_stable_rejects_oversized_decimals() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        open_cycle_stable<SUI>(&circle, 19, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_AMOUNT_OVERFLOW)]
    fun test_open_cycle_stable_overflow_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        // $20.00 at 18 decimals would need 2000 * 10^16 > u64::MAX.
        circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION,
            2_000,
            &clock,
            ts::ctx(&mut scenario)
        );

        ts::next_tx(&mut scenario, TEST_ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        open_cycle_stable<SUI>(&circle, 18, &clock, ts::ctx(&mut scenario));
        abort 0
    }
}
