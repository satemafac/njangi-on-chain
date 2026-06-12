module njangi::njangi_compliance {
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::package::{Self, UpgradeCap};
    use sui::table::{Self, Table};

    // ----------------------------------------------------------
    // Phase 3 compliance attestation anchors.
    //
    // Njangi coordinates non-custodial rotations; KYC, sanctions screening,
    // and jurisdiction gating are performed off-chain by regulated ramp
    // partners (Coinbase / MoonPay / Transak) or by the operator's own
    // compliance vendor. When a member passes those checks we want a
    // tamper-evident, machine-readable anchor on chain that downstream
    // flows can gate on, without leaking any personal data.
    //
    // This module stores non-transferable attestation objects owned by the
    // subject. Each attestation carries:
    //   * `policy_hash` — hash of the off-chain policy version the issuer
    //     followed (e.g., "2026-04 / FATF travel rule v2 / jurisdiction
    //     blocklist v7"). Opaque on chain.
    //   * `external_ref_hash` — HMAC-hashed pointer to the issuer's case
    //     record. Opaque on chain; only the issuer can invert it.
    //   * `issuer` — address that signed the issuance (must hold the
    //     `AttestorCap`). Downstream gates pin this against the
    //     `ComplianceConfig.expected_issuer` so a rogue or stale cap
    //     cannot mint passes the protocol accepts.
    //   * `issued_at_ms` / `expires_at_ms` — freshness window.
    //
    // Revocation (June 2026 audit fix): revocations are recorded in the
    // shared `ComplianceConfig`'s registry, keyed by attestation ID, and
    // are authorized by the `AttestorCap` alone. The previous design
    // bound `revoke` to the original issuing ADDRESS and required the
    // subject-owned attestation object as a transaction input — which
    // made revocation uncallable in practice (the subject would have to
    // co-sign their own revocation) and broke entirely after moving the
    // cap to a multisig. The registry fixes both: any current cap holder
    // can revoke any attestation by ID, unilaterally.
    //
    // No phone numbers, names, document scans, case IDs, or country codes
    // are stored anywhere in this module. Every identifier is either a
    // Sui address (already public) or an opaque hash.
    // ----------------------------------------------------------

    // Error code 300 (E_NOT_ISSUER) is retired-reserved: revocation is no
    // longer bound to the issuing address.
    const E_ALREADY_REVOKED: u64 = 301;
    const E_INVALID_POLICY_HASH: u64 = 302;
    const E_INVALID_REF_HASH: u64 = 303;
    const E_ZERO_TTL: u64 = 304;
    const E_NOT_CONFIG_ADMIN: u64 = 305;
    // The presented UpgradeCap does not govern this package lineage.
    const E_FOREIGN_UPGRADE_CAP: u64 = 306;

    const POLICY_HASH_BYTES: u64 = 32;
    const REF_HASH_BYTES: u64 = 32;

    // AttestorCapMinted.source / ComplianceConfigCreated.source values.
    const CAP_SOURCE_PACKAGE_INIT: u8 = 0;
    const CAP_SOURCE_UPGRADE_CAP: u8 = 1;

    /// Capability that authorizes an address to mint attestations and
    /// record revocations. Issued once at module install and moved to the
    /// operator's compliance signer (typically a multisig).
    ///
    /// Deliberately `key`-only (no `store`): every custody change must go
    /// through `transfer_attestor_cap`, which emits an audit event, so
    /// the chain carries a complete history of who held issuance power.
    public struct AttestorCap has key {
        id: UID,
    }

    /// Singleton shared configuration for the compliance gate. Created
    /// only by the package publisher — in this module's `init` on a fresh
    /// publish, or via `create_config` when the module ships to an
    /// existing lineage through a package upgrade, where `init` never
    /// runs. `create_config` verifies the presented UpgradeCap actually
    /// governs THIS lineage (see `assert_canonical_upgrade_cap`), so
    /// every `ComplianceConfig` that can exist is publisher-rooted.
    /// The canonical instance is additionally pinned ON-CHAIN by each
    /// gated circle (`njangi_circles::set_requires_attestation` records
    /// the config's object id, and njangi_cycle_escrow only accepts that
    /// exact object on its gated paths), so even a second publisher-
    /// created config cannot be substituted at the gate. Every creation
    /// emits `ComplianceConfigCreated` so any duplicate is immediately
    /// auditable on chain.
    ///
    ///   * `expected_issuer` — the only issuer address whose attestations
    ///     the protocol gates accept. Rotated by the config admin when
    ///     issuance moves (e.g. hot wallet -> multisig).
    ///   * `revoked` — registry of revoked attestation IDs, keyed by the
    ///     attestation object ID, value = revocation timestamp (ms).
    public struct ComplianceConfig has key {
        id: UID,
        admin: address,
        expected_issuer: address,
        revoked: Table<ID, u64>,
    }

    /// Non-transferable attestation anchor. The subject (the member) is
    /// `transferred` this object at mint time; the object has `key` but
    /// deliberately no `store`, which prevents it from being put inside a
    /// shared container or sold. Revocation state lives in the shared
    /// `ComplianceConfig` registry (not on this object) so the issuer can
    /// revoke without the subject's cooperation.
    public struct ComplianceAttestation has key {
        id: UID,
        subject: address,
        issuer: address,
        policy_hash: vector<u8>,
        external_ref_hash: vector<u8>,
        issued_at_ms: u64,
        expires_at_ms: u64,
    }

    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------

    public struct AttestationIssued has copy, drop {
        attestation_id: ID,
        subject: address,
        issuer: address,
        policy_hash: vector<u8>,
        external_ref_hash: vector<u8>,
        issued_at_ms: u64,
        expires_at_ms: u64,
    }

    public struct AttestationRevoked has copy, drop {
        attestation_id: ID,
        revoked_by: address,
        revoked_at_ms: u64,
    }

    /// Audit trail: every AttestorCap that ever comes into existence.
    public struct AttestorCapMinted has copy, drop {
        cap_id: ID,
        minted_to: address,
        /// CAP_SOURCE_PACKAGE_INIT or CAP_SOURCE_UPGRADE_CAP.
        source: u8,
    }

    /// Audit trail: every custody change of an AttestorCap.
    public struct AttestorCapTransferred has copy, drop {
        cap_id: ID,
        from: address,
        to: address,
    }

    /// Audit trail: every ComplianceConfig that ever comes into
    /// existence. Exactly one creation event is expected per lineage; a
    /// second event is an operational red flag (see `create_config`).
    public struct ComplianceConfigCreated has copy, drop {
        config_id: ID,
        admin: address,
        expected_issuer: address,
        /// CAP_SOURCE_PACKAGE_INIT or CAP_SOURCE_UPGRADE_CAP.
        source: u8,
    }

    public struct ExpectedIssuerUpdated has copy, drop {
        config_id: ID,
        previous_issuer: address,
        new_issuer: address,
        updated_by: address,
    }

    public struct ConfigAdminUpdated has copy, drop {
        config_id: ID,
        previous_admin: address,
        new_admin: address,
    }

    // ----------------------------------------------------------
    // Initialization
    // ----------------------------------------------------------

    /// Module init — mints the initial AttestorCap to the deployer and
    /// shares the singleton ComplianceConfig (admin and expected issuer
    /// both start as the deployer; rotate them via `set_config_admin` /
    /// `set_expected_issuer` once the multisig is ready). The deployer is
    /// expected to immediately move the cap into a multisig or hand it to
    /// the designated compliance signer; holding it in a hot wallet
    /// defeats the purpose.
    ///
    /// NOTE: on Sui, `init` runs ONLY on a fresh publish — never on a
    /// package upgrade. Lineages that gain this module through an upgrade
    /// (both live deployments do: testnet is a v6 upgrade lineage and
    /// mainnet has a v1 publish, so every future release is an upgrade)
    /// must bootstrap via the UpgradeCap-gated fallbacks instead:
    /// `mint_attestor_cap` + `create_config`.
    fun init(ctx: &mut TxContext) {
        let deployer = tx_context::sender(ctx);

        let cap = AttestorCap { id: object::new(ctx) };
        event::emit(AttestorCapMinted {
            cap_id: object::uid_to_inner(&cap.id),
            minted_to: deployer,
            source: CAP_SOURCE_PACKAGE_INIT,
        });
        transfer::transfer(cap, deployer);

        create_and_share_config(deployer, CAP_SOURCE_PACKAGE_INIT, ctx);
    }

    /// Shared creation path for the ComplianceConfig: both `init` (fresh
    /// publish) and `create_config` (upgrade bootstrap) funnel through
    /// here, so every config that ever exists starts with the publisher
    /// as admin + expected issuer and is announced by the same event.
    fun create_and_share_config(creator: address, source: u8, ctx: &mut TxContext) {
        let config = ComplianceConfig {
            id: object::new(ctx),
            admin: creator,
            expected_issuer: creator,
            revoked: table::new<ID, u64>(ctx),
        };
        event::emit(ComplianceConfigCreated {
            config_id: object::uid_to_inner(&config.id),
            admin: creator,
            expected_issuer: creator,
            source,
        });
        transfer::share_object(config);
    }

    // ----------------------------------------------------------
    // Publisher-lineage binding for UpgradeCap-gated entrypoints
    // (June 2026 adversarial-review repair).
    //
    // `0x2::package::UpgradeCap` is ONE concrete framework type: a cap
    // from ANY package satisfies `&UpgradeCap`, so taking the cap alone
    // proves nothing — an attacker can publish a throwaway package,
    // receive a perfectly real UpgradeCap for it, and present that here.
    // Every UpgradeCap-gated entrypoint in this module therefore asserts
    // the cap actually governs THIS package lineage, accepting exactly:
    //
    //   1. `package::upgrade_package(cap) == @njangi` — the cap points
    //      at this package's runtime id. Caps are born pointing at their
    //      own package id and `commit_upgrade` only ever re-points them
    //      at fresh storage ids of their own lineage, so no foreign cap
    //      can ever carry this package's id. This arm covers a
    //      never-upgraded lineage (a fresh publish, where the runtime id
    //      and the cap's package field coincide). After the first
    //      upgrade the genuine cap points at the latest STORAGE id —
    //      never the runtime id again — which is why arm 2 exists.
    //
    //   2. `object::id(cap) == @njangi_upgrade_cap` — the cap IS the
    //      known UpgradeCap object of this lineage. An object id is
    //      assigned once and never changes across upgrades or transfers,
    //      so this pin stays valid for the life of the lineage. The id
    //      is pinned per network in move/config/{testnet,mainnet}.toml
    //      (sourced from move/Published.toml / the original publish tx)
    //      and is compiled into the bytecode.
    //
    // If the lineage's UpgradeCap is ever destroyed (`make_immutable`),
    // these bootstrap/recovery fallbacks die with it and governance
    // rests solely on `set_config_admin` / `set_expected_issuer` of the
    // already-existing config.
    // ----------------------------------------------------------
    fun assert_canonical_upgrade_cap(cap: &UpgradeCap) {
        let fresh_publish_cap =
            package::upgrade_package(cap) == object::id_from_address(@njangi);
        let pinned_lineage_cap =
            object::id(cap) == object::id_from_address(@njangi_upgrade_cap);
        assert!(fresh_publish_cap || pinned_lineage_cap, E_FOREIGN_UPGRADE_CAP);
    }

    /// Post-upgrade bootstrap for the ComplianceConfig (June 2026 audit
    /// repair). `init` never runs on a package upgrade, so a lineage that
    /// gains this module via `sui client upgrade` would otherwise have NO
    /// ComplianceConfig and no way to create one — leaving every gated
    /// path (`contribute_with_attestation`,
    /// `finalize_and_redeem_with_attestation`, `revoke`) permanently
    /// uncallable, and bricking the escrow rail of any circle whose admin
    /// enables `requires_attestation`. Mirrors the `mint_attestor_cap`
    /// fallback and the post-publish bootstrap-initializer pattern of
    /// `njangi_price_validator::init_registry` /
    /// `whatsapp_integration::init_registry` (wired into
    /// scripts/bootstrap-package.mjs).
    ///
    /// Authority: holding THIS lineage's UpgradeCap, verified by
    /// `assert_canonical_upgrade_cap` — an arbitrary package's cap is
    /// rejected with `E_FOREIGN_UPGRADE_CAP`. That makes the caller the
    /// package publisher: the exact party that runs `init` on a fresh
    /// publish, so this function grants no authority the publisher does
    /// not already hold. Members and third parties can never create a
    /// config.
    ///
    /// Once-only discipline: a strict on-chain "exactly one config per
    /// lineage" guard is not expressible here — it would need shared
    /// state that predates this call, which an upgraded lineage by
    /// definition lacks (the same reason `init` can't help). The guard is
    /// therefore layered: (a) creation is bound to this lineage's
    /// UpgradeCap, (b) every creation emits `ComplianceConfigCreated`, so
    /// a duplicate is a loud, auditable anomaly rather than a silent one,
    /// (c) the ops bootstrap is idempotent — it skips creation when the
    /// config id is already recorded, and the app pins exactly that id —
    /// and (d) gated circles pin the canonical config's object id
    /// on-chain (`njangi_circles::set_requires_attestation`), so a
    /// duplicate could not be substituted at the escrow gate even if one
    /// were minted.
    public entry fun create_config(
        upgrade_cap: &UpgradeCap,
        ctx: &mut TxContext,
    ) {
        assert_canonical_upgrade_cap(upgrade_cap);
        create_and_share_config(tx_context::sender(ctx), CAP_SOURCE_UPGRADE_CAP, ctx);
    }

    /// Post-upgrade fallback: if the original cap was lost, the holder
    /// of THIS lineage's UpgradeCap (verified — a foreign package's cap
    /// aborts with `E_FOREIGN_UPGRADE_CAP`) can mint a fresh AttestorCap.
    /// Taking the cap by reference proves authority without consuming
    /// it. The mint is audit-evented like every other cap movement.
    /// The lineage check also closes a revocation-griefing hole: without
    /// it, anyone could mint themselves an AttestorCap with a throwaway
    /// package's cap and `revoke` legitimate members' attestations.
    public entry fun mint_attestor_cap(
        upgrade_cap: &UpgradeCap,
        ctx: &mut TxContext,
    ) {
        assert_canonical_upgrade_cap(upgrade_cap);
        let recipient = tx_context::sender(ctx);
        let cap = AttestorCap { id: object::new(ctx) };
        event::emit(AttestorCapMinted {
            cap_id: object::uid_to_inner(&cap.id),
            minted_to: recipient,
            source: CAP_SOURCE_UPGRADE_CAP,
        });
        transfer::transfer(cap, recipient);
    }

    /// Audited custody transfer for the AttestorCap. Because the cap has
    /// no `store`, this is the ONLY way it can change hands, so the event
    /// stream is a complete custody history.
    public fun transfer_attestor_cap(
        cap: AttestorCap,
        recipient: address,
        ctx: &TxContext,
    ) {
        event::emit(AttestorCapTransferred {
            cap_id: object::uid_to_inner(&cap.id),
            from: tx_context::sender(ctx),
            to: recipient,
        });
        transfer::transfer(cap, recipient);
    }

    // ----------------------------------------------------------
    // Config governance
    // ----------------------------------------------------------

    /// Pins the issuer address that downstream gates accept. Call this
    /// whenever issuance signing moves (e.g. deployer hot wallet to the
    /// operations multisig). Attestations issued by any other address
    /// fail the gate even if they were minted with a genuine cap.
    public fun set_expected_issuer(
        config: &mut ComplianceConfig,
        new_issuer: address,
        ctx: &TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == config.admin, E_NOT_CONFIG_ADMIN);
        event::emit(ExpectedIssuerUpdated {
            config_id: object::uid_to_inner(&config.id),
            previous_issuer: config.expected_issuer,
            new_issuer,
            updated_by: sender,
        });
        config.expected_issuer = new_issuer;
    }

    /// Rotates the config admin (the address allowed to re-pin the
    /// expected issuer).
    public fun set_config_admin(
        config: &mut ComplianceConfig,
        new_admin: address,
        ctx: &TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == config.admin, E_NOT_CONFIG_ADMIN);
        event::emit(ConfigAdminUpdated {
            config_id: object::uid_to_inner(&config.id),
            previous_admin: config.admin,
            new_admin,
        });
        config.admin = new_admin;
    }

    /// Disaster recovery: the holder of THIS lineage's UpgradeCap
    /// (package publisher — the highest existing authority; a foreign
    /// package's cap aborts with `E_FOREIGN_UPGRADE_CAP`) can re-seat
    /// the config admin if the admin key is lost. Mirrors the
    /// `mint_attestor_cap` fallback. The lineage check is what stops an
    /// attacker from seizing the canonical (shared!) config with a
    /// throwaway package's cap and re-pinning `expected_issuer` to
    /// themselves.
    public entry fun reset_config_admin(
        upgrade_cap: &UpgradeCap,
        config: &mut ComplianceConfig,
        new_admin: address,
    ) {
        assert_canonical_upgrade_cap(upgrade_cap);
        event::emit(ConfigAdminUpdated {
            config_id: object::uid_to_inner(&config.id),
            previous_admin: config.admin,
            new_admin,
        });
        config.admin = new_admin;
    }

    // ----------------------------------------------------------
    // Issuance / revocation
    // ----------------------------------------------------------

    /// Issues a new attestation anchor for `subject`. Any address holding
    /// the AttestorCap may call, but only attestations signed by the
    /// `ComplianceConfig.expected_issuer` pass downstream gates. `ttl_ms`
    /// caps how long the anchor stays valid; ramps and circle
    /// contributions should check `is_attestation_valid` before accepting
    /// a member.
    public fun issue(
        cap: &AttestorCap,
        subject: address,
        policy_hash: vector<u8>,
        external_ref_hash: vector<u8>,
        ttl_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let _ = cap; // reserved for future per-cap policy binding
        assert!(vector::length(&policy_hash) == POLICY_HASH_BYTES, E_INVALID_POLICY_HASH);
        assert!(vector::length(&external_ref_hash) == REF_HASH_BYTES, E_INVALID_REF_HASH);
        assert!(ttl_ms > 0, E_ZERO_TTL);

        let issuer = tx_context::sender(ctx);
        let issued_at_ms = clock::timestamp_ms(clock);
        let expires_at_ms = issued_at_ms + ttl_ms;

        let attestation = ComplianceAttestation {
            id: object::new(ctx),
            subject,
            issuer,
            policy_hash,
            external_ref_hash,
            issued_at_ms,
            expires_at_ms,
        };
        let attestation_id = object::uid_to_inner(&attestation.id);

        event::emit(AttestationIssued {
            attestation_id,
            subject,
            issuer,
            policy_hash: attestation.policy_hash,
            external_ref_hash: attestation.external_ref_hash,
            issued_at_ms,
            expires_at_ms,
        });

        transfer::transfer(attestation, subject);
    }

    /// Revokes an attestation by ID. Authority is the AttestorCap itself:
    /// any current cap holder may revoke any attestation, regardless of
    /// which address originally issued it (June 2026 audit fix — the old
    /// issuer-address binding silently disabled revocation after a cap
    /// move to a multisig). The attestation object — owned by the subject
    /// — is NOT required, so revocation never needs the subject's
    /// cooperation. Revocations are permanent and live forever in the
    /// registry plus the event stream.
    public fun revoke(
        cap: &AttestorCap,
        config: &mut ComplianceConfig,
        attestation_id: ID,
        clock: &Clock,
        ctx: &TxContext
    ) {
        let _ = cap; // holding the cap IS the revocation authority
        assert!(!table::contains(&config.revoked, attestation_id), E_ALREADY_REVOKED);
        let revoked_at_ms = clock::timestamp_ms(clock);
        table::add(&mut config.revoked, attestation_id, revoked_at_ms);

        event::emit(AttestationRevoked {
            attestation_id,
            revoked_by: tx_context::sender(ctx),
            revoked_at_ms,
        });
    }

    // ----------------------------------------------------------
    // Validity checks
    // ----------------------------------------------------------

    /// Authoritative validity check: not revoked (registry), not expired,
    /// and issued by the pinned expected issuer. This is what protocol
    /// gates (njangi_cycle_escrow) build on.
    public fun is_attestation_valid(
        config: &ComplianceConfig,
        attestation: &ComplianceAttestation,
        clock: &Clock
    ): bool {
        attestation.issuer == config.expected_issuer
            && !table::contains(&config.revoked, object::uid_to_inner(&attestation.id))
            && clock::timestamp_ms(clock) <= attestation.expires_at_ms
    }

    public fun is_revoked_id(config: &ComplianceConfig, attestation_id: ID): bool {
        table::contains(&config.revoked, attestation_id)
    }

    // ----------------------------------------------------------
    // Read accessors
    // ----------------------------------------------------------
    public fun attestation_id(attestation: &ComplianceAttestation): ID {
        object::uid_to_inner(&attestation.id)
    }
    public fun subject(attestation: &ComplianceAttestation): address { attestation.subject }
    public fun issuer(attestation: &ComplianceAttestation): address { attestation.issuer }
    public fun policy_hash(attestation: &ComplianceAttestation): vector<u8> { attestation.policy_hash }
    public fun external_ref_hash(attestation: &ComplianceAttestation): vector<u8> { attestation.external_ref_hash }
    public fun issued_at_ms(attestation: &ComplianceAttestation): u64 { attestation.issued_at_ms }
    public fun expires_at_ms(attestation: &ComplianceAttestation): u64 { attestation.expires_at_ms }
    public fun expected_issuer(config: &ComplianceConfig): address { config.expected_issuer }
    public fun config_admin(config: &ComplianceConfig): address { config.admin }

    // ----------------------------------------------------------
    // Test helpers
    // ----------------------------------------------------------

    #[test_only]
    public fun new_attestor_cap_for_testing(ctx: &mut TxContext): AttestorCap {
        AttestorCap { id: object::new(ctx) }
    }

    /// Runs the real `init` so tests exercise the genuine bootstrap:
    /// cap minted to the tx sender, singleton config shared with the
    /// sender as admin + expected issuer.
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx)
    }

    #[test_only]
    public fun destroy_attestor_cap_for_testing(cap: AttestorCap) {
        let AttestorCap { id } = cap;
        object::delete(id);
    }

    // ----------------------------------------------------------
    // Tests
    // ----------------------------------------------------------

    #[test_only] use sui::test_scenario as ts;

    #[test_only] const T_ISSUER: address = @0x150;
    #[test_only] const T_MULTISIG: address = @0x151;
    #[test_only] const T_SUBJECT: address = @0x152;
    #[test_only] const T_ROGUE: address = @0x153;
    #[test_only] const T_START_MS: u64 = 1_000_000;
    #[test_only] const T_TTL_MS: u64 = 86_400_000; // 24h

    #[test_only]
    fun hash32(): vector<u8> {
        x"0101010101010101010101010101010101010101010101010101010101010101"
    }

    /// tx1 (issuer): real init; tx2 (issuer): issue an attestation for
    /// T_SUBJECT with the canonical cap. Returns the test clock.
    #[test_only]
    fun setup_issued_attestation(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, T_START_MS);
        init_for_testing(ts::ctx(scenario));

        ts::next_tx(scenario, T_ISSUER);
        let cap = ts::take_from_sender<AttestorCap>(scenario);
        issue(&cap, T_SUBJECT, hash32(), hash32(), T_TTL_MS, &clock, ts::ctx(scenario));
        ts::return_to_sender(scenario, cap);
        clock
    }

    #[test]
    fun test_issue_and_validate_happy_path() {
        let mut scenario = ts::begin(T_ISSUER);
        let clock = setup_issued_attestation(&mut scenario);

        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(subject(&attestation) == T_SUBJECT, 9301);
        assert!(issuer(&attestation) == T_ISSUER, 9302);
        assert!(expires_at_ms(&attestation) == T_START_MS + T_TTL_MS, 9303);
        assert!(is_attestation_valid(&config, &attestation, &clock), 9304);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_expired_attestation_is_invalid() {
        let mut scenario = ts::begin(T_ISSUER);
        let mut clock = setup_issued_attestation(&mut scenario);

        clock::set_for_testing(&mut clock, T_START_MS + T_TTL_MS + 1);
        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(!is_attestation_valid(&config, &attestation, &clock), 9310);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_wrong_issuer_is_invalid() {
        let mut scenario = ts::begin(T_ISSUER);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, T_START_MS);
        init_for_testing(ts::ctx(&mut scenario));

        // A rogue cap (e.g. minted via a stale UpgradeCap path) issues an
        // attestation from an address that is NOT the pinned issuer.
        ts::next_tx(&mut scenario, T_ROGUE);
        let rogue_cap = new_attestor_cap_for_testing(ts::ctx(&mut scenario));
        issue(&rogue_cap, T_SUBJECT, hash32(), hash32(), T_TTL_MS, &clock, ts::ctx(&mut scenario));
        destroy_attestor_cap_for_testing(rogue_cap);

        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(issuer(&attestation) == T_ROGUE, 9320);
        assert!(!is_attestation_valid(&config, &attestation, &clock), 9321);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_revocation_works_after_cap_transfer() {
        let mut scenario = ts::begin(T_ISSUER);
        let clock = setup_issued_attestation(&mut scenario);

        // The original issuer hands the cap to the operations multisig.
        ts::next_tx(&mut scenario, T_ISSUER);
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        transfer_attestor_cap(cap, T_MULTISIG, ts::ctx(&mut scenario));

        // Capture the attestation id from the subject's owned object.
        ts::next_tx(&mut scenario, T_SUBJECT);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        let id = attestation_id(&attestation);
        ts::return_to_sender(&mut scenario, attestation);

        // The NEW cap holder revokes an attestation issued by the OLD
        // address — without needing the subject's cooperation.
        ts::next_tx(&mut scenario, T_MULTISIG);
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        revoke(&cap, &mut config, id, &clock, ts::ctx(&mut scenario));
        assert!(is_revoked_id(&config, id), 9330);
        ts::return_shared(config);
        ts::return_to_sender(&mut scenario, cap);

        // The revoked attestation no longer validates.
        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(!is_attestation_valid(&config, &attestation, &clock), 9331);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_REVOKED)]
    fun test_double_revoke_aborts() {
        let mut scenario = ts::begin(T_ISSUER);
        let clock = setup_issued_attestation(&mut scenario);

        ts::next_tx(&mut scenario, T_SUBJECT);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        let id = attestation_id(&attestation);
        ts::return_to_sender(&mut scenario, attestation);

        ts::next_tx(&mut scenario, T_ISSUER);
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        revoke(&cap, &mut config, id, &clock, ts::ctx(&mut scenario));
        revoke(&cap, &mut config, id, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_expected_issuer_rotation_invalidates_old_attestations() {
        let mut scenario = ts::begin(T_ISSUER);
        let clock = setup_issued_attestation(&mut scenario);

        // Admin re-pins issuance to the multisig.
        ts::next_tx(&mut scenario, T_ISSUER);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        set_expected_issuer(&mut config, T_MULTISIG, ts::ctx(&mut scenario));
        assert!(expected_issuer(&config) == T_MULTISIG, 9340);
        ts::return_shared(config);

        // Attestations from the old issuer stop validating.
        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(!is_attestation_valid(&config, &attestation, &clock), 9341);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_CONFIG_ADMIN)]
    fun test_set_expected_issuer_requires_admin() {
        let mut scenario = ts::begin(T_ISSUER);
        let clock = setup_issued_attestation(&mut scenario);
        clock::destroy_for_testing(clock);

        ts::next_tx(&mut scenario, T_ROGUE);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        set_expected_issuer(&mut config, T_ROGUE, ts::ctx(&mut scenario));
        abort 0
    }

    /// Simulates the live-lineage path where this module arrives in a
    /// package UPGRADE: `init` never runs, so the publisher bootstraps
    /// the cap and config with the UpgradeCap fallbacks. The resulting
    /// config must behave exactly like an init-created one: publisher is
    /// admin + expected issuer, issuance validates, revocation works.
    /// The cap is minted against @njangi — THIS package — exercising the
    /// fresh-publish arm of `assert_canonical_upgrade_cap` (the pinned
    /// object-id arm is compile-time network config and is covered by
    /// the foreign-cap rejection tests below).
    #[test]
    fun test_create_config_via_upgrade_cap_bootstraps_full_gate() {
        let mut scenario = ts::begin(T_ISSUER);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, T_START_MS);

        // No init: bootstrap purely from the UpgradeCap, as on the real
        // testnet/mainnet lineages.
        let upgrade_cap = sui::package::test_publish(
            object::id_from_address(@njangi),
            ts::ctx(&mut scenario),
        );
        mint_attestor_cap(&upgrade_cap, ts::ctx(&mut scenario));
        create_config(&upgrade_cap, ts::ctx(&mut scenario));
        transfer::public_transfer(upgrade_cap, T_ISSUER);

        // Config starts publisher-rooted, like init's.
        ts::next_tx(&mut scenario, T_ISSUER);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        assert!(config_admin(&config) == T_ISSUER, 9350);
        assert!(expected_issuer(&config) == T_ISSUER, 9351);

        // Issue with the fallback-minted cap; the attestation validates
        // against the upgrade-created config.
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        issue(&cap, T_SUBJECT, hash32(), hash32(), T_TTL_MS, &clock, ts::ctx(&mut scenario));
        ts::return_to_sender(&mut scenario, cap);
        ts::return_shared(config);

        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(is_attestation_valid(&config, &attestation, &clock), 9352);
        let id = attestation_id(&attestation);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        // Revocation — the audit's launch-blocking fix — must be live on
        // the upgrade-created config too.
        ts::next_tx(&mut scenario, T_ISSUER);
        let cap = ts::take_from_sender<AttestorCap>(&scenario);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        revoke(&cap, &mut config, id, &clock, ts::ctx(&mut scenario));
        assert!(is_revoked_id(&config, id), 9353);
        ts::return_to_sender(&mut scenario, cap);
        ts::return_shared(config);

        ts::next_tx(&mut scenario, T_SUBJECT);
        let config = ts::take_shared<ComplianceConfig>(&scenario);
        let attestation = ts::take_from_sender<ComplianceAttestation>(&scenario);
        assert!(!is_attestation_valid(&config, &attestation, &clock), 9354);
        ts::return_to_sender(&mut scenario, attestation);
        ts::return_shared(config);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // --- foreign-UpgradeCap rejection (June 2026 adversarial-review
    // repair). The exploit: publish ANY throwaway package, receive a
    // perfectly real `0x2::package::UpgradeCap` for it, and present it
    // to the cap-gated entrypoints. Every one of them must abort. -----

    #[test_only]
    fun foreign_upgrade_cap(scenario: &mut ts::Scenario): UpgradeCap {
        // A real UpgradeCap — for somebody else's package (@0x42).
        sui::package::test_publish(
            object::id_from_address(@0x42),
            ts::ctx(scenario),
        )
    }

    #[test]
    #[expected_failure(abort_code = E_FOREIGN_UPGRADE_CAP)]
    fun test_create_config_rejects_foreign_upgrade_cap() {
        let mut scenario = ts::begin(T_ROGUE);
        let foreign_cap = foreign_upgrade_cap(&mut scenario);
        create_config(&foreign_cap, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_FOREIGN_UPGRADE_CAP)]
    fun test_mint_attestor_cap_rejects_foreign_upgrade_cap() {
        let mut scenario = ts::begin(T_ROGUE);
        let foreign_cap = foreign_upgrade_cap(&mut scenario);
        mint_attestor_cap(&foreign_cap, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_FOREIGN_UPGRADE_CAP)]
    fun test_reset_config_admin_rejects_foreign_upgrade_cap() {
        let mut scenario = ts::begin(T_ISSUER);
        init_for_testing(ts::ctx(&mut scenario));

        // The attacker tries to seize the CANONICAL shared config with a
        // throwaway package's cap.
        ts::next_tx(&mut scenario, T_ROGUE);
        let foreign_cap = foreign_upgrade_cap(&mut scenario);
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        reset_config_admin(&foreign_cap, &mut config, T_ROGUE);
        abort 0
    }

    #[test]
    fun test_reset_config_admin_works_with_lineage_cap() {
        let mut scenario = ts::begin(T_ISSUER);
        init_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, T_ISSUER);
        let upgrade_cap = sui::package::test_publish(
            object::id_from_address(@njangi),
            ts::ctx(&mut scenario),
        );
        let mut config = ts::take_shared<ComplianceConfig>(&scenario);
        assert!(config_admin(&config) == T_ISSUER, 9360);
        reset_config_admin(&upgrade_cap, &mut config, T_MULTISIG);
        assert!(config_admin(&config) == T_MULTISIG, 9361);
        ts::return_shared(config);
        transfer::public_transfer(upgrade_cap, T_ISSUER);

        ts::end(scenario);
    }
}
