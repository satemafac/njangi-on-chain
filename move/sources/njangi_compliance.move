module njangi::njangi_compliance {
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::package::UpgradeCap;

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
    //   * `issuer` — address of the `AttestorCap` holder that signed off.
    //   * `issued_at_ms` / `expires_at_ms` — freshness window.
    //   * `revoked` — flag flipped by the issuer when a case reopens.
    //
    // No phone numbers, names, document scans, case IDs, or country codes
    // are stored anywhere in this module. Every identifier is either a
    // Sui address (already public) or an opaque hash.
    // ----------------------------------------------------------

    const E_NOT_ISSUER: u64 = 300;
    const E_ALREADY_REVOKED: u64 = 301;
    const E_INVALID_POLICY_HASH: u64 = 302;
    const E_INVALID_REF_HASH: u64 = 303;
    const E_ZERO_TTL: u64 = 304;

    const POLICY_HASH_BYTES: u64 = 32;
    const REF_HASH_BYTES: u64 = 32;

    /// Capability that authorizes an address to mint attestations. Issued
    /// once at module install and transferred to the operator's compliance
    /// signer (typically a multisig). Revocations also require the cap.
    public struct AttestorCap has key, store {
        id: UID,
    }

    /// Non-transferable attestation anchor. The subject (the member) is
    /// `transferred` this object at mint time; the object has `key` but
    /// deliberately no `store`, which prevents it from being put inside a
    /// shared container or sold.
    public struct ComplianceAttestation has key {
        id: UID,
        subject: address,
        issuer: address,
        policy_hash: vector<u8>,
        external_ref_hash: vector<u8>,
        issued_at_ms: u64,
        expires_at_ms: u64,
        revoked: bool,
    }

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
        subject: address,
        issuer: address,
        revoked_at_ms: u64,
    }

    /// Module init — mints the initial AttestorCap and transfers it to
    /// the deployer. The deployer is expected to immediately move the
    /// cap into a multisig or hand it to the designated compliance
    /// signer; holding it in a hot wallet defeats the purpose.
    fun init(ctx: &mut TxContext) {
        let cap = AttestorCap { id: object::new(ctx) };
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    /// Post-upgrade fallback: if the compliance module is added in an
    /// upgrade (so `init` doesn't re-run) or the original cap was lost,
    /// the UpgradeCap holder can mint a fresh AttestorCap. Taking the
    /// cap by reference proves authority without consuming it.
    public entry fun mint_attestor_cap(
        _upgrade_cap: &UpgradeCap,
        ctx: &mut TxContext,
    ) {
        let cap = AttestorCap { id: object::new(ctx) };
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    /// Issues a new attestation anchor for `subject`. Any address holding
    /// the AttestorCap may call. `ttl_ms` caps how long the anchor stays
    /// valid; ramps and circle contributions should check
    /// `is_attestation_valid` before accepting a member.
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
            revoked: false,
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

    /// Revokes an attestation the caller originally issued. Revocations
    /// live forever on chain as an event; the attestation object itself
    /// is flagged but not deleted so downstream consumers observe the
    /// change through validity checks rather than object disappearance.
    public fun revoke(
        cap: &AttestorCap,
        attestation: &mut ComplianceAttestation,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let _ = cap;
        let sender = tx_context::sender(ctx);
        assert!(sender == attestation.issuer, E_NOT_ISSUER);
        assert!(!attestation.revoked, E_ALREADY_REVOKED);
        attestation.revoked = true;

        event::emit(AttestationRevoked {
            attestation_id: object::uid_to_inner(&attestation.id),
            subject: attestation.subject,
            issuer: attestation.issuer,
            revoked_at_ms: clock::timestamp_ms(clock),
        });
    }

    public fun is_attestation_valid(
        attestation: &ComplianceAttestation,
        clock: &Clock
    ): bool {
        !attestation.revoked && clock::timestamp_ms(clock) <= attestation.expires_at_ms
    }

    public fun subject(attestation: &ComplianceAttestation): address { attestation.subject }
    public fun issuer(attestation: &ComplianceAttestation): address { attestation.issuer }
    public fun policy_hash(attestation: &ComplianceAttestation): vector<u8> { attestation.policy_hash }
    public fun external_ref_hash(attestation: &ComplianceAttestation): vector<u8> { attestation.external_ref_hash }
    public fun issued_at_ms(attestation: &ComplianceAttestation): u64 { attestation.issued_at_ms }
    public fun expires_at_ms(attestation: &ComplianceAttestation): u64 { attestation.expires_at_ms }
    public fun is_revoked(attestation: &ComplianceAttestation): bool { attestation.revoked }

    #[test_only]
    public fun new_attestor_cap_for_testing(ctx: &mut TxContext): AttestorCap {
        AttestorCap { id: object::new(ctx) }
    }
}
