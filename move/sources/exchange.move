/// Exchange Chamber Module
/// Implements AI-facilitated P2P escrow exchange for heterogeneous assets
/// Supports on-chain tokens and off-chain files with Walrus storage
module njangi::exchange {
    use std::string::{Self, String};
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::balance::{Self, Balance};
    use sui::dynamic_field as df;
    use sui::dynamic_object_field as dof;
    use std::type_name;
    use sui::ecdsa_k1;
    use sui::hash;

    // ======== Constants ========
    
    /// Exchange chamber phases
    const PHASE_OFFER_CREATED: u8 = 0;
    const PHASE_OFFER_JOINED: u8 = 1;
    const PHASE_DEPOSITS_COMMITTED: u8 = 2;
    const PHASE_VERIFICATION_STARTED: u8 = 3;
    const PHASE_FINALIZED: u8 = 4;
    const PHASE_DISPUTED: u8 = 5;
    const PHASE_TIMEOUT_REFUNDED: u8 = 6;

    /// Asset types
    const ASSET_TYPE_SUI: u8 = 0;
    const ASSET_TYPE_COIN: u8 = 1;
    // const ASSET_TYPE_NFT: u8 = 2; // Reserved for future use
    const ASSET_TYPE_FILE: u8 = 3;

    // ======== Error Codes ========
    
    const E_INVALID_PHASE: u64 = 1;
    const E_UNAUTHORIZED: u64 = 2;
    const E_CHAMBER_FULL: u64 = 3;
    const E_INVALID_ASSET_AMOUNT: u64 = 4;
    const E_TIMEOUT_NOT_REACHED: u64 = 5;
    const E_ALREADY_COMMITTED: u64 = 6;
    const E_ASSET_MISMATCH: u64 = 7;
    const E_INSUFFICIENT_ANTI_GRIEFING_FEE: u64 = 8;
    const E_INVALID_ATTESTOR: u64 = 9;
    const E_INSUFFICIENT_ATTESTATIONS: u64 = 10;
    const E_INVALID_SIGNATURE: u64 = 11;

    // ======== NJEX Agent Constants ========
    
    /// NJEX Agent package ID on SuiAIFun
    const NJEX_PACKAGE_ID: address = @0x19dce611d7b2022c90b64fec1d8728cf72f9c712c48a996a2942937ead5e8974;

    // ======== Structs ========

    /// Off-chain file commitment stored on-chain
    public struct FileCommitment has copy, drop, store {
        hash: vector<u8>,           // blake2b/sha3 hash of content
        size: u64,                  // file size in bytes
        mime_type: String,          // MIME type
        walrus_blob_id: String,     // Walrus blob ID/pointer
        thumbnail_hash: option::Option<vector<u8>>, // Optional thumbnail hash
        metadata_digest: option::Option<vector<u8>>, // Optional derived metadata digest
    }

    /// Asset commitment for escrow
    public struct AssetCommitment has copy, drop, store {
        asset_type: u8,             // Asset type constant
        amount: u64,                // For coins/SUI, 0 for NFTs/files
        coin_type: option::Option<String>, // Type name for coins
        object_id: option::Option<ID>,     // For NFTs
        file_commitment: option::Option<FileCommitment>, // For off-chain files
        description: String,        // Human-readable description
    }

    /// Participant role in exchange
    public struct Participant has copy, drop, store {
        address: address,
        commitment: AssetCommitment,
        deposited: bool,
        anti_griefing_fee_paid: u64,
    }

    /// AI Agent attestation
    public struct AgentAttestation has copy, drop, store {
        agent_address: address,
        chamber_id: ID,
        participant_address: address,
        attestation_hash: vector<u8>, // Hash of attestation content
        signature: vector<u8>,        // Agent signature
        timestamp: u64,
        verified_properties: vector<String>, // List of verified properties
    }

    /// Main exchange chamber shared object
    public struct ExchangeChamber has key, store {
        id: UID,
        creator: address,           // Address that created the chamber
        phase: u8,                  // Current phase
        participants: vector<Participant>, // Max 2 participants
        timeout_ms: u64,           // Timeout in milliseconds
        created_at: u64,           // Creation timestamp
        phase_updated_at: u64,     // Last phase update timestamp
        anti_griefing_fee: u64,    // Required anti-griefing fee in MIST
        attestations: vector<AgentAttestation>, // AI agent attestations
        dispute_reason: option::Option<String>, // Reason for dispute if any
        finalized_at: option::Option<u64>,      // Finalization timestamp
    }

    /// Registry for authorized AI agents/attestors
    public struct AttestorRegistry has key, store {
        id: UID,
        admin: address,
        authorized_agents: vector<address>,
        min_attestations_required: u64,
    }

    /// Capability for chamber operations
    public struct ChamberCap has key, store {
        id: UID,
        chamber_id: ID,
        participant_address: address,
    }

    // ======== Events ========

    /// Emitted when a new exchange chamber is created
    public struct OfferCreatedEvent has copy, drop {
        chamber_id: ID,
        creator: address,
        commitment: AssetCommitment,
        timeout_ms: u64,
        anti_griefing_fee: u64,
        timestamp: u64,
    }

    /// Emitted when someone joins an exchange chamber
    public struct OfferJoinedEvent has copy, drop {
        chamber_id: ID,
        joiner: address,
        commitment: AssetCommitment,
        timestamp: u64,
    }

    /// Emitted when assets are deposited/committed
    public struct DepositsCommittedEvent has copy, drop {
        chamber_id: ID,
        participant: address,
        asset_type: u8,
        amount: u64,
        walrus_blob_id: option::Option<String>,
        commitment_hash: option::Option<vector<u8>>,
        timestamp: u64,
    }

    /// Emitted when verification phase starts
    public struct VerificationStartedEvent has copy, drop {
        chamber_id: ID,
        timestamp: u64,
    }

    /// Emitted when an agent provides attestation
    public struct AttestationProvidedEvent has copy, drop {
        chamber_id: ID,
        agent: address,
        participant: address,
        attestation_hash: vector<u8>,
        verified_properties: vector<String>,
        timestamp: u64,
    }

    /// Emitted when exchange is finalized
    public struct ExchangeFinalizedEvent has copy, drop {
        chamber_id: ID,
        participant_a: address,
        participant_b: address,
        timestamp: u64,
    }

    /// Emitted when exchange is disputed
    public struct ExchangeDisputedEvent has copy, drop {
        chamber_id: ID,
        disputer: address,
        reason: String,
        timestamp: u64,
    }

    /// Emitted when timeout refund occurs
    public struct TimeoutRefundEvent has copy, drop {
        chamber_id: ID,
        participant: address,
        refunded_amount: u64,
        timestamp: u64,
    }

    // ======== Public Functions ========

    /// Create a new exchange chamber with an initial offer
    public fun create_offer(
        commitment: AssetCommitment,
        timeout_ms: u64,
        anti_griefing_fee: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let chamber_id = object::new(ctx);
        let chamber_id_copy = object::uid_to_inner(&chamber_id);
        let current_time = clock::timestamp_ms(clock);

        // Validate anti-griefing fee (minimum 1 SUI)
        let fee_amount = coin::value(&anti_griefing_fee);
        assert!(fee_amount >= 1_000_000_000, E_INSUFFICIENT_ANTI_GRIEFING_FEE); // 1 SUI in MIST

        // Create initial participant
        let creator_participant = Participant {
            address: sender,
            commitment,
            deposited: false,
            anti_griefing_fee_paid: fee_amount,
        };

        let mut chamber = ExchangeChamber {
            id: chamber_id,
            creator: sender,
            phase: PHASE_OFFER_CREATED,
            participants: vector::singleton(creator_participant),
            timeout_ms,
            created_at: current_time,
            phase_updated_at: current_time,
            anti_griefing_fee: fee_amount,
            attestations: vector::empty(),
            dispute_reason: option::none(),
            finalized_at: option::none(),
        };

        // Store anti-griefing fee in chamber's dynamic fields
        df::add(&mut chamber.id, b"anti_griefing_fees", coin::into_balance(anti_griefing_fee));

        // Create capability for creator
        let cap = ChamberCap {
            id: object::new(ctx),
            chamber_id: chamber_id_copy,
            participant_address: sender,
        };

        // Emit event
        event::emit(OfferCreatedEvent {
            chamber_id: chamber_id_copy,
            creator: sender,
            commitment,
            timeout_ms,
            anti_griefing_fee: fee_amount,
            timestamp: current_time,
        });

        // Transfer objects
        transfer::share_object(chamber);
        transfer::transfer(cap, sender);
    }

    /// Join an existing exchange chamber
    public fun join_offer(
        chamber: &mut ExchangeChamber,
        commitment: AssetCommitment,
        anti_griefing_fee: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Validate phase and capacity
        assert!(chamber.phase == PHASE_OFFER_CREATED, E_INVALID_PHASE);
        assert!(vector::length(&chamber.participants) == 1, E_CHAMBER_FULL);

        // Validate anti-griefing fee matches chamber requirement
        let fee_amount = coin::value(&anti_griefing_fee);
        assert!(fee_amount >= chamber.anti_griefing_fee, E_INSUFFICIENT_ANTI_GRIEFING_FEE);

        // Create joiner participant
        let joiner_participant = Participant {
            address: sender,
            commitment,
            deposited: false,
            anti_griefing_fee_paid: fee_amount,
        };

        // Add participant and update phase
        vector::push_back(&mut chamber.participants, joiner_participant);
        chamber.phase = PHASE_OFFER_JOINED;
        chamber.phase_updated_at = current_time;

        // Add anti-griefing fee to chamber balance
        let existing_balance = df::borrow_mut<vector<u8>, Balance<SUI>>(&mut chamber.id, b"anti_griefing_fees");
        balance::join(existing_balance, coin::into_balance(anti_griefing_fee));

        // Create capability for joiner
        let cap = ChamberCap {
            id: object::new(ctx),
            chamber_id: object::uid_to_inner(&chamber.id),
            participant_address: sender,
        };

        // Emit event
        event::emit(OfferJoinedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            joiner: sender,
            commitment,
            timestamp: current_time,
        });

        // Transfer capability
        transfer::transfer(cap, sender);
    }

    /// Deposit SUI coins for the exchange
    entry fun deposit_sui(
        chamber: &mut ExchangeChamber,
        cap: &ChamberCap,
        payment: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        let amount = coin::value(&payment);

        // Validate phase and authorization
        assert!(chamber.phase == PHASE_OFFER_JOINED, E_INVALID_PHASE);
        assert!(cap.chamber_id == object::uid_to_inner(&chamber.id), E_UNAUTHORIZED);
        assert!(cap.participant_address == sender, E_UNAUTHORIZED);

        // Find participant and validate commitment
        let participants = &mut chamber.participants;
        let len = vector::length(participants);
        let mut i = 0;
        let mut found = false;
        let mut _commitment_copy = AssetCommitment {
            asset_type: ASSET_TYPE_SUI,
            amount: 0,
            coin_type: option::none(),
            object_id: option::none(),
            file_commitment: option::none(),
            description: string::utf8(b""),
        };
        
        while (i < len) {
            let participant = vector::borrow_mut(participants, i);
            if (participant.address == sender) {
                assert!(!participant.deposited, E_ALREADY_COMMITTED);
                assert!(participant.commitment.asset_type == ASSET_TYPE_SUI, E_ASSET_MISMATCH);
                assert!(participant.commitment.amount == amount, E_INVALID_ASSET_AMOUNT);
                
                participant.deposited = true;
                _commitment_copy = participant.commitment;
                found = true;
                break
            };
            i = i + 1;
        };
        
        assert!(found, E_UNAUTHORIZED);

        // Store SUI in chamber's dynamic fields
        let sui_key = get_participant_sui_key(sender);
        dof::add(&mut chamber.id, sui_key, payment);

        // Check if both participants have deposited
        let all_deposited = check_all_deposited(participants);
        if (all_deposited) {
            chamber.phase = PHASE_DEPOSITS_COMMITTED;
            chamber.phase_updated_at = current_time;
        };

        // Emit event
        event::emit(DepositsCommittedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            participant: sender,
            asset_type: ASSET_TYPE_SUI,
            amount,
            walrus_blob_id: option::none(),
            commitment_hash: option::none(),
            timestamp: current_time,
        });
    }

    /// Deposit generic coin for the exchange
    public fun deposit_coin<CoinType>(
        chamber: &mut ExchangeChamber,
        cap: &ChamberCap,
        payment: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        let amount = coin::value(&payment);
        let coin_type_ascii = type_name::into_string(type_name::get<CoinType>());
        let coin_type_string = string::from_ascii(coin_type_ascii);

        // Validate phase and authorization
        assert!(chamber.phase == PHASE_OFFER_JOINED, E_INVALID_PHASE);
        assert!(cap.chamber_id == object::uid_to_inner(&chamber.id), E_UNAUTHORIZED);
        assert!(cap.participant_address == sender, E_UNAUTHORIZED);

        // Find participant and validate commitment
        let participants = &mut chamber.participants;
        let len = vector::length(participants);
        let mut i = 0;
        let mut found = false;
        
        while (i < len) {
            let participant = vector::borrow_mut(participants, i);
            if (participant.address == sender) {
                assert!(!participant.deposited, E_ALREADY_COMMITTED);
                assert!(participant.commitment.asset_type == ASSET_TYPE_COIN, E_ASSET_MISMATCH);
                assert!(participant.commitment.amount == amount, E_INVALID_ASSET_AMOUNT);
                
                // Validate coin type matches commitment
                if (option::is_some(&participant.commitment.coin_type)) {
                    let expected_type = option::borrow(&participant.commitment.coin_type);
                    assert!(string::bytes(expected_type) == string::bytes(&coin_type_string), E_ASSET_MISMATCH);
                };
                
                participant.deposited = true;
                found = true;
                break
            };
            i = i + 1;
        };
        
        assert!(found, E_UNAUTHORIZED);

        // Store coin in chamber's dynamic fields
        let coin_key = get_participant_coin_key<CoinType>(sender);
        dof::add(&mut chamber.id, coin_key, payment);

        // Check if both participants have deposited
        let all_deposited = check_all_deposited(participants);
        if (all_deposited) {
            chamber.phase = PHASE_DEPOSITS_COMMITTED;
            chamber.phase_updated_at = current_time;
        };

        // Emit event
        event::emit(DepositsCommittedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            participant: sender,
            asset_type: ASSET_TYPE_COIN,
            amount,
            walrus_blob_id: option::none(),
            commitment_hash: option::none(),
            timestamp: current_time,
        });
    }

    /// Commit file with Walrus storage
    entry fun commit_file(
        chamber: &mut ExchangeChamber,
        cap: &ChamberCap,
        file_hash: vector<u8>,
        file_size: u64,
        mime_type: String,
        walrus_blob_id: String,
        thumbnail_hash: vector<u8>, // Can be empty if no thumbnail
        metadata_digest: vector<u8>, // Can be empty if no metadata
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Validate phase and authorization
        assert!(chamber.phase == PHASE_OFFER_JOINED, E_INVALID_PHASE);
        assert!(cap.chamber_id == object::uid_to_inner(&chamber.id), E_UNAUTHORIZED);
        assert!(cap.participant_address == sender, E_UNAUTHORIZED);

        // Create file commitment
        let file_commitment = FileCommitment {
            hash: file_hash,
            size: file_size,
            mime_type,
            walrus_blob_id: walrus_blob_id,
            thumbnail_hash: if (vector::is_empty(&thumbnail_hash)) { 
                option::none() 
            } else { 
                option::some(thumbnail_hash) 
            },
            metadata_digest: if (vector::is_empty(&metadata_digest)) { 
                option::none() 
            } else { 
                option::some(metadata_digest) 
            },
        };

        // Find participant and validate commitment
        let participants = &mut chamber.participants;
        let len = vector::length(participants);
        let mut i = 0;
        let mut found = false;
        
        while (i < len) {
            let participant = vector::borrow_mut(participants, i);
            if (participant.address == sender) {
                assert!(!participant.deposited, E_ALREADY_COMMITTED);
                assert!(participant.commitment.asset_type == ASSET_TYPE_FILE, E_ASSET_MISMATCH);
                
                participant.deposited = true;
                found = true;
                break
            };
            i = i + 1;
        };
        
        assert!(found, E_UNAUTHORIZED);

        // Store file commitment in chamber's dynamic fields
        let file_key = get_participant_file_key(sender);
        df::add(&mut chamber.id, file_key, file_commitment);

        // Check if both participants have deposited
        let all_deposited = check_all_deposited(participants);
        if (all_deposited) {
            chamber.phase = PHASE_DEPOSITS_COMMITTED;
            chamber.phase_updated_at = current_time;
        };

        // Emit event
        event::emit(DepositsCommittedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            participant: sender,
            asset_type: ASSET_TYPE_FILE,
            amount: 0,
            walrus_blob_id: option::some(walrus_blob_id),
            commitment_hash: option::some(file_hash),
            timestamp: current_time,
        });
    }

    /// Start verification phase with AI agents
    entry fun start_verification(
        chamber: &mut ExchangeChamber,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        let current_time = clock::timestamp_ms(clock);

        // Validate phase
        assert!(chamber.phase == PHASE_DEPOSITS_COMMITTED, E_INVALID_PHASE);

        // Update phase
        chamber.phase = PHASE_VERIFICATION_STARTED;
        chamber.phase_updated_at = current_time;

        // Emit event
        event::emit(VerificationStartedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            timestamp: current_time,
        });
    }

    /// Submit AI agent attestation for a participant's asset
    entry fun submit_agent_attestation(
        chamber: &mut ExchangeChamber,
        registry: &AttestorRegistry,
        participant_address: address,
        verified_properties: vector<String>,
        attestation_content: vector<u8>, // The actual attestation message
        signature: vector<u8>,           // Agent's signature over attestation
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let agent = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        let chamber_id = object::uid_to_inner(&chamber.id);

        // Validate phase and agent authorization
        assert!(chamber.phase == PHASE_VERIFICATION_STARTED, E_INVALID_PHASE);
        assert!(is_authorized_agent(registry, agent), E_INVALID_ATTESTOR);

        // Validate participant exists in chamber
        let participants = &chamber.participants;
        let mut participant_found = false;
        let mut i = 0;
        while (i < vector::length(participants)) {
            let participant = vector::borrow(participants, i);
            if (participant.address == participant_address) {
                participant_found = true;
                break
            };
            i = i + 1;
        };
        assert!(participant_found, E_UNAUTHORIZED);

        // Create attestation hash for verification
        let attestation_hash = hash::keccak256(&attestation_content);

        // Create and store attestation
        let attestation = AgentAttestation {
            agent_address: agent,
            chamber_id,
            participant_address,
            attestation_hash,
            signature,
            timestamp: current_time,
            verified_properties,
        };

        // Add attestation to chamber
        vector::push_back(&mut chamber.attestations, attestation);

        // Emit event
        event::emit(AttestationProvidedEvent {
            chamber_id,
            agent,
            participant: participant_address,
            attestation_hash,
            verified_properties,
            timestamp: current_time,
        });
    }

    /// Verify agent signature for attestation (view function)
    public fun verify_agent_attestation(
        registry: &AttestorRegistry,
        agent_address: address,
        attestation_content: &vector<u8>,
        signature: &vector<u8>,
        public_key: &vector<u8>
    ): bool {
        // Validate agent is authorized
        if (!is_authorized_agent(registry, agent_address)) {
            return false
        };

        // Verify signature using ECDSA
        let message_hash = hash::keccak256(attestation_content);
        ecdsa_k1::secp256k1_verify(signature, public_key, &message_hash, 1)
    }

    /// Get attestations for a specific participant
    public fun get_participant_attestations(
        chamber: &ExchangeChamber,
        participant_address: address
    ): vector<AgentAttestation> {
        let mut participant_attestations = vector::empty<AgentAttestation>();
        let mut i = 0;
        
        while (i < vector::length(&chamber.attestations)) {
            let attestation = vector::borrow(&chamber.attestations, i);
            if (attestation.participant_address == participant_address) {
                vector::push_back(&mut participant_attestations, *attestation);
            };
            i = i + 1;
        };
        
        participant_attestations
    }

    /// Check if chamber has sufficient attestations for finalization
    public fun has_sufficient_attestations(
        chamber: &ExchangeChamber,
        registry: &AttestorRegistry
    ): bool {
        let required_attestations = registry.min_attestations_required;
        let participants = &chamber.participants;
        
        // Check each participant has minimum required attestations
        let mut i = 0;
        while (i < vector::length(participants)) {
            let participant = vector::borrow(participants, i);
            let participant_attestations = get_participant_attestations(chamber, participant.address);
            
            if (vector::length(&participant_attestations) < required_attestations) {
                return false
            };
            i = i + 1;
        };
        
        true
    }

    /// Finalize the exchange - execute cross-participant asset transfers
    entry fun finalize(
        chamber: &mut ExchangeChamber,
        registry: &AttestorRegistry,
        cap: &ChamberCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Validate phase and authorization
        assert!(chamber.phase == PHASE_VERIFICATION_STARTED, E_INVALID_PHASE);
        assert!(cap.chamber_id == object::uid_to_inner(&chamber.id), E_UNAUTHORIZED);
        assert!(cap.participant_address == sender, E_UNAUTHORIZED);

        // Validate sufficient attestations from authorized agents
        assert!(has_sufficient_attestations(chamber, registry), E_INSUFFICIENT_ATTESTATIONS);
        
        // Update phase and timestamp
        chamber.phase = PHASE_FINALIZED;
        chamber.phase_updated_at = current_time;
        chamber.finalized_at = option::some(current_time);

        // Get participant data for transfers
        let participant_a_addr = vector::borrow(&chamber.participants, 0).address;
        let participant_b_addr = vector::borrow(&chamber.participants, 1).address;
        let participant_a_commitment = vector::borrow(&chamber.participants, 0).commitment;
        let participant_b_commitment = vector::borrow(&chamber.participants, 1).commitment;
        
        // Execute cross-transfers based on asset types
        execute_asset_transfer(chamber, participant_a_addr, participant_b_addr, &participant_a_commitment, ctx);
        execute_asset_transfer(chamber, participant_b_addr, participant_a_addr, &participant_b_commitment, ctx);

        // Return anti-griefing fees to participants
        let mut anti_griefing_balance = df::remove<vector<u8>, Balance<SUI>>(&mut chamber.id, b"anti_griefing_fees");
        let total_fees = balance::value(&anti_griefing_balance);
        let fee_per_participant = total_fees / 2;
        
        if (fee_per_participant > 0) {
            let fee_a = coin::take(&mut anti_griefing_balance, fee_per_participant, ctx);
            let fee_b = coin::take(&mut anti_griefing_balance, fee_per_participant, ctx);
            
            transfer::public_transfer(fee_a, participant_a_addr);
            transfer::public_transfer(fee_b, participant_b_addr);
        };
        
        // Destroy remaining balance (should be zero or dust)
        balance::destroy_zero(anti_griefing_balance);

        // Emit event
        event::emit(ExchangeFinalizedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            participant_a: participant_a_addr,
            participant_b: participant_b_addr,
            timestamp: current_time,
        });
    }

    /// Dispute the exchange
    entry fun dispute(
        chamber: &mut ExchangeChamber,
        cap: &ChamberCap,
        reason: String,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Validate authorization
        assert!(cap.chamber_id == object::uid_to_inner(&chamber.id), E_UNAUTHORIZED);
        assert!(cap.participant_address == sender, E_UNAUTHORIZED);

        // Can dispute during verification or if not finalized
        assert!(
            chamber.phase == PHASE_VERIFICATION_STARTED || 
            chamber.phase == PHASE_DEPOSITS_COMMITTED,
            E_INVALID_PHASE
        );

        // Update phase and dispute reason
        chamber.phase = PHASE_DISPUTED;
        chamber.phase_updated_at = current_time;
        chamber.dispute_reason = option::some(reason);

        // Emit event
        event::emit(ExchangeDisputedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            disputer: sender,
            reason,
            timestamp: current_time,
        });
    }

    /// Timeout refund - return assets to original owners
    entry fun timeout_refund(
        chamber: &mut ExchangeChamber,
        cap: &ChamberCap,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Validate timeout has been reached
        assert!(current_time >= chamber.created_at + chamber.timeout_ms, E_TIMEOUT_NOT_REACHED);
        
        // Validate authorization
        assert!(cap.chamber_id == object::uid_to_inner(&chamber.id), E_UNAUTHORIZED);
        assert!(cap.participant_address == sender, E_UNAUTHORIZED);

        // Can only refund if not finalized
        assert!(chamber.phase != PHASE_FINALIZED, E_INVALID_PHASE);

        // Update phase
        chamber.phase = PHASE_TIMEOUT_REFUNDED;
        chamber.phase_updated_at = current_time;

        // Refund assets to original owners
        let participant_count = vector::length(&chamber.participants);
        let mut i = 0;
        let mut total_refunded = 0;
        
        while (i < participant_count) {
            let participant_addr = vector::borrow(&chamber.participants, i).address;
            let participant_deposited = vector::borrow(&chamber.participants, i).deposited;
            let participant_commitment = vector::borrow(&chamber.participants, i).commitment;
            
            if (participant_deposited) {
                let refunded_amount = refund_participant_assets_by_data(chamber, participant_addr, &participant_commitment, ctx);
                total_refunded = total_refunded + refunded_amount;
            };
            i = i + 1;
        };

        // Refund anti-griefing fees
        let mut anti_griefing_balance = df::remove<vector<u8>, Balance<SUI>>(&mut chamber.id, b"anti_griefing_fees");
        let total_fees = balance::value(&anti_griefing_balance);
        
        if (total_fees > 0 && participant_count >= 2) {
            let participant_a_fee = vector::borrow(&chamber.participants, 0).anti_griefing_fee_paid;
            let _participant_b_fee = vector::borrow(&chamber.participants, 1).anti_griefing_fee_paid;
            let participant_a_addr = vector::borrow(&chamber.participants, 0).address;
            let participant_b_addr = vector::borrow(&chamber.participants, 1).address;
            
            let fee_a = coin::take(&mut anti_griefing_balance, participant_a_fee, ctx);
            let remaining_balance = balance::value(&anti_griefing_balance);
            
            if (remaining_balance > 0) {
                let fee_b = coin::take(&mut anti_griefing_balance, remaining_balance, ctx);
                transfer::public_transfer(fee_b, participant_b_addr);
            };
            
            transfer::public_transfer(fee_a, participant_a_addr);
        };
        
        // Destroy remaining balance (should be zero)
        balance::destroy_zero(anti_griefing_balance);

        // Emit event
        event::emit(TimeoutRefundEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            participant: sender,
            refunded_amount: total_refunded,
            timestamp: current_time,
        });
    }

    // ======== View Functions ========

    /// Get chamber information
    public fun get_chamber_info(chamber: &ExchangeChamber): (u8, u64, u64, u64) {
        (chamber.phase, chamber.timeout_ms, chamber.created_at, chamber.phase_updated_at)
    }

    /// Get participant count
    public fun get_participant_count(chamber: &ExchangeChamber): u64 {
        vector::length(&chamber.participants)
    }

    /// Check if chamber is ready for finalization
    public fun is_ready_for_finalization(chamber: &ExchangeChamber): bool {
        chamber.phase == PHASE_VERIFICATION_STARTED &&
        vector::length(&chamber.participants) == 2 && {
            let mut all_deposited = true;
            let mut i = 0;
            while (i < vector::length(&chamber.participants)) {
                let participant = vector::borrow(&chamber.participants, i);
                if (!participant.deposited) {
                    all_deposited = false;
                    break
                };
                i = i + 1;
            };
            all_deposited
        }
    }

    /// Get chamber phase
    public fun get_phase(chamber: &ExchangeChamber): u8 {
        chamber.phase
    }

    /// Get total number of attestations in chamber
    public fun get_attestation_count(chamber: &ExchangeChamber): u64 {
        vector::length(&chamber.attestations)
    }

    /// Get attestation by index
    public fun get_attestation(chamber: &ExchangeChamber, index: u64): option::Option<AgentAttestation> {
        if (index < vector::length(&chamber.attestations)) {
            option::some(*vector::borrow(&chamber.attestations, index))
        } else {
            option::none()
        }
    }

    /// Get all attestations in chamber
    public fun get_all_attestations(chamber: &ExchangeChamber): vector<AgentAttestation> {
        chamber.attestations
    }

    /// Check if specific agent has provided attestation for participant
    public fun has_agent_attestation(
        chamber: &ExchangeChamber,
        agent_address: address,
        participant_address: address
    ): bool {
        let mut i = 0;
        while (i < vector::length(&chamber.attestations)) {
            let attestation = vector::borrow(&chamber.attestations, i);
            if (attestation.agent_address == agent_address && 
                attestation.participant_address == participant_address) {
                return true
            };
            i = i + 1;
        };
        false
    }

    /// Get chamber verification summary
    public fun get_verification_summary(
        chamber: &ExchangeChamber,
        registry: &AttestorRegistry
    ): (u64, u64, bool) {
        let total_attestations = vector::length(&chamber.attestations);
        let required_attestations = registry.min_attestations_required;
        let is_ready = has_sufficient_attestations(chamber, registry);
        
        (total_attestations, required_attestations, is_ready)
    }

    // ======== Admin Functions (for AttestorRegistry) ========

    /// Create attestor registry (admin function)
    entry fun create_attestor_registry(ctx: &mut TxContext) {
        let registry = AttestorRegistry {
            id: object::new(ctx),
            admin: tx_context::sender(ctx),
            authorized_agents: vector::empty(),
            min_attestations_required: 1,
        };

        transfer::share_object(registry);
    }

    /// Add authorized agent to registry
    entry fun add_authorized_agent(
        registry: &mut AttestorRegistry,
        agent_address: address,
        ctx: &mut TxContext
    ) {
        assert!(registry.admin == tx_context::sender(ctx), E_UNAUTHORIZED);
        
        if (!vector::contains(&registry.authorized_agents, &agent_address)) {
            vector::push_back(&mut registry.authorized_agents, agent_address);
        };
    }

    /// Remove authorized agent from registry
    entry fun remove_authorized_agent(
        registry: &mut AttestorRegistry,
        agent_address: address,
        ctx: &mut TxContext
    ) {
        assert!(registry.admin == tx_context::sender(ctx), E_UNAUTHORIZED);
        
        let (found, index) = vector::index_of(&registry.authorized_agents, &agent_address);
        if (found) {
            vector::remove(&mut registry.authorized_agents, index);
        };
    }

    /// Check if agent is authorized
    public fun is_authorized_agent(registry: &AttestorRegistry, agent_address: address): bool {
        vector::contains(&registry.authorized_agents, &agent_address)
    }

    /// Register NJEX agent as authorized attestor
    entry fun register_njex_agent(
        registry: &mut AttestorRegistry,
        njex_agent_address: address,
        ctx: &mut TxContext
    ) {
        assert!(registry.admin == tx_context::sender(ctx), E_UNAUTHORIZED);
        
        // Add NJEX agent if not already registered
        if (!vector::contains(&registry.authorized_agents, &njex_agent_address)) {
            vector::push_back(&mut registry.authorized_agents, njex_agent_address);
        };
    }

    /// Submit privacy-preserving Q&A response from agent
    entry fun submit_qa_response(
        chamber: &mut ExchangeChamber,
        registry: &AttestorRegistry,
        participant_address: address,
        question_hash: vector<u8>,      // Hash of the question asked
        response_content: vector<u8>,   // Agent's response
        confidence_score: u8,           // 0-100 confidence in response
        signature: vector<u8>,          // Agent signature
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let agent = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Validate phase and agent authorization
        assert!(chamber.phase == PHASE_VERIFICATION_STARTED, E_INVALID_PHASE);
        assert!(is_authorized_agent(registry, agent), E_INVALID_ATTESTOR);

        // Create Q&A response properties
        let mut qa_properties = vector::empty<String>();
        vector::push_back(&mut qa_properties, string::utf8(b"qa_response"));
        vector::push_back(&mut qa_properties, string::utf8(b"confidence_"));
        
        // Convert confidence score to string and append
        let confidence_str = u8_to_string(confidence_score);
        vector::push_back(&mut qa_properties, confidence_str);

        // Create attestation content combining question and response
        let mut combined_content = vector::empty<u8>();
        vector::append(&mut combined_content, question_hash);
        vector::append(&mut combined_content, response_content);
        
        let attestation_hash = hash::keccak256(&combined_content);

        // Create and store Q&A attestation
        let qa_attestation = AgentAttestation {
            agent_address: agent,
            chamber_id: object::uid_to_inner(&chamber.id),
            participant_address,
            attestation_hash,
            signature,
            timestamp: current_time,
            verified_properties: qa_properties,
        };

        // Add to chamber attestations
        vector::push_back(&mut chamber.attestations, qa_attestation);

        // Emit event
        event::emit(AttestationProvidedEvent {
            chamber_id: object::uid_to_inner(&chamber.id),
            agent,
            participant: participant_address,
            attestation_hash,
            verified_properties: qa_properties,
            timestamp: current_time,
        });
    }

    // ======== Helper Functions ========

    /// Check if all participants have deposited their assets
    fun check_all_deposited(participants: &vector<Participant>): bool {
        let mut all_deposited = true;
        let mut i = 0;
        while (i < vector::length(participants)) {
            let participant = vector::borrow(participants, i);
            if (!participant.deposited) {
                all_deposited = false;
                break
            };
            i = i + 1;
        };
        all_deposited
    }

    /// Get dynamic field key for participant's SUI deposit
    fun get_participant_sui_key(_participant: address): String {
        let mut key = string::utf8(b"sui_");
        string::append(&mut key, address_to_string(_participant));
        key
    }

    /// Get dynamic field key for participant's coin deposit
    fun get_participant_coin_key<CoinType>(_participant: address): String {
        let mut key = string::utf8(b"coin_");
        string::append(&mut key, address_to_string(_participant));
        string::append(&mut key, string::utf8(b"_"));
        let type_ascii = type_name::into_string(type_name::get<CoinType>());
        let type_string = string::from_ascii(type_ascii);
        string::append(&mut key, type_string);
        key
    }

    /// Get dynamic field key for participant's file commitment
    fun get_participant_file_key(_participant: address): String {
        let mut key = string::utf8(b"file_");
        string::append(&mut key, address_to_string(_participant));
        key
    }

    /// Convert address to string (simplified - in production use proper encoding)
    fun address_to_string(addr: address): String {
        // Convert address to hex string representation
        // This is a simplified implementation
        let addr_bytes = std::bcs::to_bytes(&addr);
        let mut result = string::utf8(b"");
        let mut i = 0;
        while (i < vector::length(&addr_bytes) && i < 8) { // Take first 8 bytes for brevity
            let byte = *vector::borrow(&addr_bytes, i);
            let _hex = byte_to_hex(byte);
            string::append(&mut result, _hex);
            i = i + 1;
        };
        result
    }

    /// Convert byte to hex string
    fun byte_to_hex(byte: u8): String {
        let hex_chars = b"0123456789abcdef";
        let high = byte / 16;
        let low = byte % 16;
        let mut result = vector::empty<u8>();
        vector::push_back(&mut result, *vector::borrow(&hex_chars, (high as u64)));
        vector::push_back(&mut result, *vector::borrow(&hex_chars, (low as u64)));
        string::utf8(result)
    }

    /// Convert u8 to string (simplified implementation)
    fun u8_to_string(value: u8): String {
        if (value == 0) return string::utf8(b"0");
        
        let mut digits = vector::empty<u8>();
        let mut num = value;
        
        while (num > 0) {
            let digit = num % 10;
            vector::push_back(&mut digits, (48 + digit)); // ASCII '0' = 48
            num = num / 10;
        };
        
        // Reverse digits
        vector::reverse(&mut digits);
        string::utf8(digits)
    }

    /// Execute asset transfer from one participant to another
    fun execute_asset_transfer(
        chamber: &mut ExchangeChamber,
        from: address,
        to: address,
        commitment: &AssetCommitment,
        _ctx: &mut TxContext
    ) {
        if (commitment.asset_type == ASSET_TYPE_SUI) {
            // Transfer SUI
            let sui_key = get_participant_sui_key(from);
            if (dof::exists_(&chamber.id, sui_key)) {
                let sui_coin = dof::remove<String, Coin<SUI>>(&mut chamber.id, sui_key);
                transfer::public_transfer(sui_coin, to);
            };
        } else if (commitment.asset_type == ASSET_TYPE_FILE) {
            // For files, we don't transfer the actual file, just the commitment
            // The recipient can access the file using the Walrus blob ID
            // File commitments remain in the chamber for record keeping
        };
        // Note: Generic coin transfers would need to be handled with type parameters
        // This is a limitation of Move's type system - we'd need separate functions
        // or use a different approach for generic coin types
    }


    /// Refund participant's assets using address and commitment data
    fun refund_participant_assets_by_data(
        chamber: &mut ExchangeChamber,
        participant_addr: address,
        commitment: &AssetCommitment,
        _ctx: &mut TxContext
    ): u64 {
        let mut refunded_amount = 0;
        
        if (commitment.asset_type == ASSET_TYPE_SUI) {
            let sui_key = get_participant_sui_key(participant_addr);
            if (dof::exists_(&chamber.id, sui_key)) {
                let sui_coin = dof::remove<String, Coin<SUI>>(&mut chamber.id, sui_key);
                refunded_amount = coin::value(&sui_coin);
                transfer::public_transfer(sui_coin, participant_addr);
            };
        } else if (commitment.asset_type == ASSET_TYPE_FILE) {
            // For files, remove the commitment but don't transfer anything
            let file_key = get_participant_file_key(participant_addr);
            if (df::exists_(&chamber.id, file_key)) {
                let _file_commitment = df::remove<String, FileCommitment>(&mut chamber.id, file_key);
                // File remains accessible via Walrus blob ID
            };
        };
        // Note: Generic coin refunds would need type-specific handling
        
        refunded_amount
    }

    /// Get file commitment for a participant
    public fun get_file_commitment(chamber: &ExchangeChamber, participant: address): option::Option<FileCommitment> {
        let file_key = get_participant_file_key(participant);
        if (df::exists_(&chamber.id, file_key)) {
            option::some(*df::borrow<String, FileCommitment>(&chamber.id, file_key))
        } else {
            option::none()
        }
    }

    /// Check if participant has deposited SUI
    public fun has_sui_deposit(chamber: &ExchangeChamber, participant: address): bool {
        let sui_key = get_participant_sui_key(participant);
        dof::exists_(&chamber.id, sui_key)
    }

    /// Get SUI deposit amount for participant
    public fun get_sui_deposit_amount(chamber: &ExchangeChamber, participant: address): u64 {
        let sui_key = get_participant_sui_key(participant);
        if (dof::exists_(&chamber.id, sui_key)) {
            let sui_coin = dof::borrow<String, Coin<SUI>>(&chamber.id, sui_key);
            coin::value(sui_coin)
        } else {
            0
        }
    }
}
