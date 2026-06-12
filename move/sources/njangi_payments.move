module njangi::njangi_payments {
    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::sui::SUI;
    use std::string::{Self, String};
    use std::type_name;
    use std::ascii;
    
    use njangi::njangi_core as core;
    use njangi::njangi_circles::{Self as circles, Circle};
    use njangi::njangi_members as members;
    use njangi::njangi_custody::{Self as custody, CustodyWallet};
    use njangi::njangi_milestones::{Self as milestones, MilestoneData};
    
    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    const EInvalidPayoutAmount: u64 = 22;
    // Codes 23 (EPayoutAlreadyProcessed) and 24 (EInvalidPayoutSchedule)
    // were retired with the admin-discretionary process_scheduled_payout;
    // do not reuse them.
    const EInsufficientTreasuryBalance: u64 = 25;
    const EInvalidBidAmount: u64 = 26;
    const EAuctionNotActive: u64 = 27;
    const EInvalidMilestone: u64 = 28;
    const EMilestoneTargetInvalid: u64 = 32;
    const EAmountOverflow: u64 = 38;
    const ENotScheduledRecipient: u64 = 39;
    // Mirrors njangi_cycle_escrow::E_COMPLIANCE_ATTESTATION_REQUIRED (216)
    // so the frontend maps a single abort code for "this circle requires a
    // compliance attestation" across both money rails.
    const E_COMPLIANCE_ATTESTATION_REQUIRED: u64 = 216;
    const MAX_U64: u64 = 0xFFFF_FFFF_FFFF_FFFF;
    
    // ----------------------------------------------------------
    // Events
    // ----------------------------------------------------------
    
    /// Event emitted when a contribution is made to a circle
    /// * `circle_id` - ID of the circle receiving the contribution
    /// * `member` - Address of the contributing member
    /// * `amount` - Actual raw contribution amount in SUI (with 9 decimal places)
    /// * `cycle` - Current cycle number of the circle
    public struct ContributionMade has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        cycle: u64,
    }
    
    public struct PayoutProcessed has copy, drop {
        circle_id: ID,
        recipient: address,
        amount: u64,
        cycle: u64,
        payout_type: u8,
    }
    
    // Debug event to track wallet balance and payout calculations
    public struct PayoutDebugInfo has copy, drop {
        wallet_balance: u64,
        contribution_amount: u64,
        member_count: u64,
        payout_amount: u64,
        payout_reason: String,
    }

    // Audit event for payout currency routing decisions.
    public struct PayoutCurrencySelected has copy, drop {
        circle_id: ID,
        recipient: address,
        selected_currency: String,
        required_amount: u64,
        available_amount: u64,
        timestamp: u64,
    }
    
    public struct AuctionStarted has copy, drop {
        circle_id: ID,
        position: u64,
        minimum_bid: u64,
        end_time: u64,
    }
    
    public struct BidPlaced has copy, drop {
        circle_id: ID,
        bidder: address,
        amount: u64,
        position: u64,
    }
    
    public struct AuctionCompleted has copy, drop {
        circle_id: ID,
        winner: address,
        position: u64,
        winning_bid: u64,
    }
    
    public struct MilestoneCompleted has copy, drop {
        circle_id: ID,
        milestone_number: u64,
        verified_by: address,
        amount_achieved: u64,
    }
    
    public struct MilestoneVerificationSubmitted has copy, drop {
        circle_id: ID,
        milestone_number: u64,
        submitted_by: address,
        proof_type: u8,
        timestamp: u64,
    }
    
    // ----------------------------------------------------------
    // PayoutWindow struct definition
    // ----------------------------------------------------------
    #[allow(unused_field)]
    public struct PayoutWindow has store, drop {
        start_time: u64,
        end_time: u64,
        recipient: address,
        amount: u64
    }

    // Multiply two u64 values with explicit overflow protection.
    fun safe_mul(a: u64, b: u64): u64 {
        if (a == 0 || b == 0) {
            return 0
        };
        assert!(a <= MAX_U64 / b, EAmountOverflow);
        a * b
    }

    fun coin_type_label<CoinType>(): String {
        string::utf8(ascii::into_bytes(type_name::into_string(type_name::get<CoinType>())))
    }

    fun allocate_recovery_debit_amounts(
        outstandings: vector<u64>,
        total_amount: u64
    ): vector<u64> {
        let len = vector::length(&outstandings);
        let mut debits = vector::empty<u64>();
        let mut i = 0;

        while (i < len) {
            vector::push_back(&mut debits, 0);
            i = i + 1;
        };

        let mut remaining = total_amount;
        while (remaining > 0) {
            let mut eligible_member_count = 0;
            let mut j = 0;

            while (j < len) {
                let outstanding = *vector::borrow(&outstandings, j);
                let debited_so_far = *vector::borrow(&debits, j);
                if (outstanding > debited_so_far) {
                    eligible_member_count = eligible_member_count + 1;
                };
                j = j + 1;
            };

            if (eligible_member_count == 0) {
                break
            };

            let base_allocation = remaining / eligible_member_count;
            let mut remainder = remaining % eligible_member_count;
            let mut allocated_this_round = 0;
            let mut k = 0;

            while (k < len) {
                let outstanding = *vector::borrow(&outstandings, k);
                let debited_so_far = *vector::borrow(&debits, k);
                let available = outstanding - debited_so_far;

                if (available > 0) {
                    let mut desired = base_allocation;
                    if (remainder > 0) {
                        desired = desired + 1;
                        remainder = remainder - 1;
                    };

                    let debit_amount = if (desired > available) { available } else { desired };
                    if (debit_amount > 0) {
                        *vector::borrow_mut(&mut debits, k) = debited_so_far + debit_amount;
                        remaining = remaining - debit_amount;
                        allocated_this_round = allocated_this_round + debit_amount;
                    };
                };
                k = k + 1;
            };

            if (allocated_this_round == 0) {
                break
            };
        };

        debits
    }
    
    // ----------------------------------------------------------
    // Contribute SUI to the circle
    // ----------------------------------------------------------
    public fun contribute(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        payment: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);

        // Compliance-gated circles must use the per-cycle escrow rail
        // (njangi_cycle_escrow::contribute_with_attestation). The legacy
        // custody rail performs no attestation checks, so allowing it here
        // would let members bypass the KYC gate with a hand-rolled PTB
        // (June 2026 audit). Security deposits and all refund/recovery
        // paths stay ungated — they only return a member's own funds.
        assert!(!circles::requires_attestation(circle), E_COMPLIANCE_ATTESTATION_REQUIRED);
        // Must be a circle member
        assert!(circles::is_member(circle, sender), 8);
        // Circle must be active to accept contributions
        assert!(circles::is_circle_active(circle), 54);

        let contribution_amount_raw = circles::get_contribution_amount_raw(circle);
        let contribution_amount_usd_cents = circles::get_contribution_amount_usd(circle);
        let payment_amount = coin::value(&payment);
        
        // Must be at least the required SUI contribution (raw 9dp amount).
        assert!(payment_amount >= contribution_amount_raw, 1);
        // Verify custody wallet belongs to this circle
        assert!(custody::get_circle_id(wallet) == circles::get_id(circle), 46);

        let member = circles::get_member(circle, sender);
        assert!(members::get_status(member) == 0, 14); // MEMBER_STATUS_ACTIVE
        assert!(option::is_none(&members::get_suspension_end_time(member)), 13); // EMemberSuspended

        // One contribution per member per payout round (shared across the
        // SUI and stablecoin rails). Aborts with
        // njangi_circles::E_ALREADY_CONTRIBUTED_THIS_CYCLE on a duplicate,
        // so a single member can no longer satisfy
        // has_all_members_contributed by paying multiple times.
        circles::record_cycle_contributor(circle, sender);

        // IMPORTANT: First deposit the payment into the wallet BEFORE updating counters.
        // The package-internal contribution path verifies wallet activity but no longer
        // grants admin discretion over the deposited funds.
        custody::deposit_contribution_coin<SUI>(wallet, payment, sender, clock, ctx);

        // Update stats AFTER the funds are deposited
        let member_mut = circles::get_member_mut(circle, sender);
        members::record_contribution(member_mut, contribution_amount_raw, clock::timestamp_ms(clock));
        members::add_recovery_sui_contributions(member_mut, payment_amount);

        // Track cycle progress in USD cents, independent from payment rail.
        circles::add_to_contributions_this_cycle(circle, contribution_amount_usd_cents);

        event::emit(ContributionMade {
            circle_id: circles::get_id(circle),
            member: sender,
            amount: payment_amount,
            cycle: circles::get_current_cycle(circle),
        });

        // Payouts are NOT auto-triggered here to avoid contribute/payout race
        // conditions. Anyone may call `trigger_payout` once all members have
        // contributed; the scheduled recipient may also call `claim_payout<T>`
        // directly to pull their funds.
    }

    fun debit_active_member_recovery_sui_contributions(
        circle: &mut Circle,
        total_amount: u64
    ) {
        if (total_amount == 0) {
            return
        };

        let rotation_order = circles::get_rotation_order(circle);
        let len = vector::length(&rotation_order);
        let mut member_addresses = vector::empty<address>();
        let mut outstandings = vector::empty<u64>();
        let mut i = 0;

        while (i < len) {
            let member_addr = *vector::borrow(&rotation_order, i);
            if (
                member_addr != @0x0
                    && circles::is_member(circle, member_addr)
                    && !vector::contains(&member_addresses, &member_addr)
            ) {
                let member = circles::get_member(circle, member_addr);
                let is_active_member = members::get_status(member) == members::member_status_active();
                let outstanding = members::get_recovery_sui_contributions(member);
                if (is_active_member && outstanding > 0) {
                    vector::push_back(&mut member_addresses, member_addr);
                    vector::push_back(&mut outstandings, outstanding);
                };
            };
            i = i + 1;
        };

        let debits = allocate_recovery_debit_amounts(outstandings, total_amount);
        let member_count = vector::length(&member_addresses);
        let mut j = 0;

        while (j < member_count) {
            let debit_amount = *vector::borrow(&debits, j);
            if (debit_amount > 0) {
                let member_addr = *vector::borrow(&member_addresses, j);
                let member_mut = circles::get_member_mut(circle, member_addr);
                members::subtract_recovery_sui_contributions(member_mut, debit_amount);
            };
            j = j + 1;
        };
    }

    fun debit_active_member_recovery_stablecoin_contributions(
        circle: &mut Circle,
        total_amount: u64
    ) {
        if (total_amount == 0) {
            return
        };

        let rotation_order = circles::get_rotation_order(circle);
        let len = vector::length(&rotation_order);
        let mut member_addresses = vector::empty<address>();
        let mut outstandings = vector::empty<u64>();
        let mut i = 0;

        while (i < len) {
            let member_addr = *vector::borrow(&rotation_order, i);
            if (
                member_addr != @0x0
                    && circles::is_member(circle, member_addr)
                    && !vector::contains(&member_addresses, &member_addr)
            ) {
                let member = circles::get_member(circle, member_addr);
                let is_active_member = members::get_status(member) == members::member_status_active();
                let outstanding = members::get_recovery_stablecoin_contributions(member);
                if (is_active_member && outstanding > 0) {
                    vector::push_back(&mut member_addresses, member_addr);
                    vector::push_back(&mut outstandings, outstanding);
                };
            };
            i = i + 1;
        };

        let debits = allocate_recovery_debit_amounts(outstandings, total_amount);
        let member_count = vector::length(&member_addresses);
        let mut j = 0;

        while (j < member_count) {
            let debit_amount = *vector::borrow(&debits, j);
            if (debit_amount > 0) {
                let member_addr = *vector::borrow(&member_addresses, j);
                let member_mut = circles::get_member_mut(circle, member_addr);
                members::subtract_recovery_stablecoin_contributions(member_mut, debit_amount);
            };
            j = j + 1;
        };
    }
    
    // ----------------------------------------------------------
    // Internal function to trigger automatic payout when all members have contributed
    // ----------------------------------------------------------
    fun trigger_automatic_payout<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Get the next recipient in the rotation
        let recipient_opt = circles::get_next_payout_recipient(circle);
        
        // Ensure there is a valid recipient
        if (option::is_none(&recipient_opt)) {
            return
        };
        
        let recipient = *option::borrow(&recipient_opt);
        
        // Ensure recipient is a member
        if (!circles::is_member(circle, recipient)) {
            return
        };
        
        // Get member and check they haven't already been paid
        let member = circles::get_member(circle, recipient);
        if (members::has_received_payout(member)) {
            return
        };
        
        // ------- WALLET ANALYSIS AND PAYOUT CALCULATION -------
        let circle_id = circles::get_id(circle);
        let member_count = circles::get_member_count(circle);
        let contribution_amount_raw = circles::get_contribution_amount_raw(circle);
        let contribution_amount_readable = circles::get_contribution_amount(circle);
        let contribution_amount_usd = circles::get_contribution_amount_usd(circle);

        // The payout must equal exactly what the cycle collects. The funding
        // gate (has_all_members_contributed) only requires contribution x
        // contributing_members, where the scheduled recipient is excluded —
        // the same economics as the per-cycle escrow (required_contributors
        // = member_count - 1). Paying contribution x member_count (the old
        // behavior) over-paid by one contribution per cycle, silently
        // draining commingled security deposits.
        let contributing_members = circles::current_cycle_contributing_members(circle);

        // ------- SAFEGUARDS & ASSERTIONS -------
        assert!(contribution_amount_raw > 0, 59); // Raw contribution amount must be positive
        assert!(member_count > 0, 62); // Must have at least one member
        assert!(contributing_members > 0, EInvalidPayoutAmount);

        // The stablecoin-first branch prices the payout in USDC micro-units
        // (6dp); that unit math is meaningless when CoinType is SUI, so SUI
        // payouts must always take the SUI branch below.
        let is_sui_coin_type = type_name::get<CoinType>() == type_name::get<SUI>();

        // USDC-first: required payout amount in stablecoin micro-units (6dp).
        let stablecoin_per_member = custody::usd_cents_to_usdc_amount(contribution_amount_usd);
        let stablecoin_payout_amount = safe_mul(stablecoin_per_member, contributing_members);
        let stablecoin_balance = custody::get_stablecoin_balance<CoinType>(wallet);

        if (!is_sui_coin_type && stablecoin_payout_amount > 0 && stablecoin_balance >= stablecoin_payout_amount) {
            event::emit(PayoutCurrencySelected {
                circle_id,
                recipient,
                selected_currency: coin_type_label<CoinType>(),
                required_amount: stablecoin_payout_amount,
                available_amount: stablecoin_balance,
                timestamp: clock::timestamp_ms(clock),
            });

            event::emit(PayoutDebugInfo {
                wallet_balance: stablecoin_balance,
                contribution_amount: stablecoin_per_member,
                member_count: contributing_members,
                payout_amount: stablecoin_payout_amount,
                payout_reason: string::utf8(b"Using USDC-first payout path"),
            });

            let member_mut = circles::get_member_mut(circle, recipient);
            members::set_received_payout(member_mut, true);

            let stablecoin = custody::release_stablecoin_to_member<CoinType>(
                wallet,
                stablecoin_payout_amount,
                recipient,
                clock,
                ctx
            );
            transfer::public_transfer(stablecoin, recipient);

            debit_active_member_recovery_stablecoin_contributions(circle, stablecoin_payout_amount);
            circles::reset_contributions_this_cycle(circle);
            circles::advance_rotation_position_and_cycle(circle, recipient, clock);

            let human_readable_payout = contribution_amount_readable * contributing_members;
            event::emit(PayoutProcessed {
                circle_id,
                recipient,
                amount: human_readable_payout,
                cycle: circles::get_current_cycle(circle),
                payout_type: circles::get_goal_type(circle),
            });
            return
        };

        // Fallback to SUI when USDC is insufficient (or CoinType is SUI).
        let payout_amount = safe_mul(contribution_amount_raw, contributing_members);
        assert!(payout_amount > 0, EInvalidPayoutAmount);
        // Count every SUI store the wallet can actually release from:
        // release_sui_to_member draws from the main balance AND the dynamic
        // Balance<SUI> field that deposit_contribution_coin fills, so the
        // sufficiency check must look at the same total.
        let sui_balance = custody::get_total_wallet_balance(wallet);

        if (sui_balance < payout_amount) {
            event::emit(PayoutCurrencySelected {
                circle_id,
                recipient,
                selected_currency: string::utf8(b"both_insufficient"),
                required_amount: payout_amount,
                available_amount: sui_balance,
                timestamp: clock::timestamp_ms(clock),
            });
            abort EInsufficientTreasuryBalance
        };

        event::emit(PayoutCurrencySelected {
            circle_id,
            recipient,
            selected_currency: string::utf8(b"sui"),
            required_amount: payout_amount,
            available_amount: sui_balance,
            timestamp: clock::timestamp_ms(clock),
        });

        event::emit(PayoutDebugInfo {
            wallet_balance: sui_balance,
            contribution_amount: contribution_amount_raw,
            member_count: contributing_members,
            payout_amount,
            payout_reason: string::utf8(b"USDC shortfall, using SUI fallback")
        });

        // ------- EXECUTE THE SUI FALLBACK PAYOUT -------
        let member_mut = circles::get_member_mut(circle, recipient);
        members::set_received_payout(member_mut, true);

        let payout_coin = custody::release_sui_to_member(wallet, payout_amount, recipient, clock, ctx);
        transfer::public_transfer(payout_coin, recipient);

        debit_active_member_recovery_sui_contributions(circle, payout_amount);
        circles::reset_contributions_this_cycle(circle);
        circles::advance_rotation_position_and_cycle(circle, recipient, clock);

        let human_readable_payout = contribution_amount_readable * contributing_members;
        event::emit(PayoutProcessed {
            circle_id,
            recipient,
            amount: human_readable_payout,
            cycle: circles::get_current_cycle(circle),
            payout_type: circles::get_goal_type(circle),
        });
    }
    
    // ----------------------------------------------------------
    // NOTE: `process_scheduled_payout` was removed in the June 2026 GTM
    // audit cleanup. It was admin-gated and paid an ARBITRARY admin-chosen
    // recipient — a direct violation of the no-admin-discretionary-fund-
    // movement invariant. The only payout paths are the permissionless
    // `trigger_payout` and the recipient-pull `claim_payout`, both of which
    // derive the recipient deterministically from the rotation order.
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // Auction management
    // ----------------------------------------------------------
    
    // Start position auction
    public fun start_position_auction(
        circle: &mut Circle,
        position: u64,
        minimum_bid: u64,
        duration_days: u64,
        discount_rate: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), 7);
        // Circle must be active to run auctions
        assert!(circles::is_circle_active(circle), 54);
        // Check if auction is already active
        assert!(!circles::has_active_auction(circle), EAuctionNotActive);
        
        circles::start_auction(
            circle, 
            position, 
            minimum_bid, 
            duration_days, 
            discount_rate, 
            clock::timestamp_ms(clock)
        );
        
        event::emit(AuctionStarted {
            circle_id: circles::get_id(circle),
            position,
            minimum_bid: core::to_decimals(minimum_bid),
            end_time: clock::timestamp_ms(clock) + (duration_days * core::ms_per_day()),
        });
    }
    
    // Place bid in auction
    public fun place_bid(
        circle: &mut Circle,
        bid: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Circle must be active to place bids
        assert!(circles::is_circle_active(circle), 54);
        assert!(circles::has_active_auction(circle), EAuctionNotActive);
        
        let sender = tx_context::sender(ctx);
        let (position, current_highest_bid, highest_bidder, end_time) = circles::get_auction_info(circle);
        
        // Check if auction is still active
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time <= end_time, EAuctionNotActive);
        
        // Verify bid amount
        let bid_amount = coin::value(&bid);
        assert!(bid_amount > current_highest_bid, EInvalidBidAmount);
        
        // If there's a previous highest bidder, refund them
        if (option::is_some(&highest_bidder)) {
            let prev_bidder = *option::borrow(&highest_bidder);
            let refund_coin: Coin<SUI> = coin::from_balance(
                circles::split_from_contributions(circle, current_highest_bid),
                ctx
            );
            transfer::public_transfer(refund_coin, prev_bidder);
        };
        
        // Update auction state
        circles::update_auction_bid(circle, bid_amount, sender);
        
        // Auction proceeds are placed in the circle's contributions
        circles::add_to_contributions(circle, coin::into_balance(bid));
        
        event::emit(BidPlaced {
            circle_id: circles::get_id(circle),
            bidder: sender,
            amount: bid_amount,
            position,
        });
    }
    
    // Complete auction
    public fun complete_auction(
        circle: &mut Circle,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), 7);
        // Circle must be active to complete auctions
        assert!(circles::is_circle_active(circle), 54);
        assert!(circles::has_active_auction(circle), EAuctionNotActive);
        
        let (position, winning_bid, winner_opt, end_time) = circles::get_auction_info(circle);
        assert!(clock::timestamp_ms(clock) > end_time, EAuctionNotActive);
        
        if (option::is_some(&winner_opt)) {
            let winner = *option::borrow(&winner_opt);
            circles::set_rotation_position_internal(circle, winner, position);
            
            event::emit(AuctionCompleted {
                circle_id: circles::get_id(circle),
                winner,
                position,
                winning_bid,
            });
        };
        
        circles::end_auction(circle);
    }
    
    // ----------------------------------------------------------
    // Milestone management 
    // ----------------------------------------------------------
    
    // Add monetary milestone
    public fun add_monetary_milestone(
        circle: &mut Circle,
        milestone_data: &mut MilestoneData,
        target_amount: u64,
        deadline: u64,
        description: vector<u8>,
        prerequisites: vector<u64>,
        verification_requirements: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), 7);
        // Circle must be active to add milestones
        assert!(circles::is_circle_active(circle), 54);
        assert!(circles::has_goal_type(circle), EInvalidMilestone);
        assert!(target_amount > 0, EMilestoneTargetInvalid);
        
        milestones::add_monetary_milestone(
            milestone_data,
            target_amount,
            deadline,
            description,
            prerequisites,
            verification_requirements,
            clock::timestamp_ms(clock)
        );
    }
    
    // Add time milestone
    public fun add_time_milestone(
        circle: &mut Circle,
        milestone_data: &mut MilestoneData,
        duration_days: u64,
        deadline: u64,
        description: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), 7);
        // Circle must be active to add milestones
        assert!(circles::is_circle_active(circle), 54);
        assert!(circles::has_goal_type(circle), EInvalidMilestone);
        assert!(duration_days > 0, EMilestoneTargetInvalid);
        
        milestones::add_time_milestone(
            milestone_data,
            duration_days,
            deadline,
            description,
            clock::timestamp_ms(clock)
        );
    }
    
    // Verify milestone
    public fun verify_milestone(
        circle: &mut Circle,
        milestone_data: &mut MilestoneData,
        milestone_number: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        // Only admin can verify milestones
        assert!(sender == circles::get_admin(circle), 7);
        // Circle must be active to verify milestones
        assert!(circles::is_circle_active(circle), 54);
        
        // Call the verification function in the milestones module
        milestones::verify_milestone(
            milestone_data, 
            circle,
            milestone_number, 
            clock::timestamp_ms(clock), 
            sender
        );
        
        // Emit completion event
        event::emit(MilestoneCompleted {
            circle_id: circles::get_id(circle),
            milestone_number,
            verified_by: sender,
            amount_achieved: 0, // Placeholder until we can properly calculate it
        });
    }
    
    // Submit milestone verification
    public fun submit_milestone_verification(
        circle: &mut Circle,
        milestone_data: &mut MilestoneData,
        milestone_number: u64,
        proof: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Circle must be active to submit milestone verifications
        assert!(circles::is_circle_active(circle), 54);
        
        let timestamp = clock::timestamp_ms(clock);
        let sender = tx_context::sender(ctx);
        
        milestones::submit_milestone_verification(
            milestone_data, 
            milestone_number, 
            proof, 
            timestamp, 
            sender
        );
        
        // Just use index 0 as a simplification since we can't get the length easily
        // In a real implementation, we would track the proper index
        let proof_type = milestones::get_milestone_verification_type(milestone_data, milestone_number, 0);
        
        event::emit(MilestoneVerificationSubmitted {
            circle_id: circles::get_id(circle),
            milestone_number,
            submitted_by: sender,
            proof_type,
            timestamp,
        });
    }
    
    // ----------------------------------------------------------
    // Security deposit handling
    //
    // NOTE: `process_security_deposit_return` was removed in the June 2026
    // GTM audit cleanup. It was admin-pushed (the admin chose when and for
    // whom to release funds — violating the no-admin-discretionary-fund-
    // movement invariant) and it drew from `circle.deposits`, a Balance the
    // live deposit flow never funds: security deposits are stored in the
    // CustodyWallet via `member_deposit_security_deposit` and are returned
    // through the member-initiated recovery flow
    // (`njangi_circles::execute_recovery` / `trigger_auto_release`), which
    // refunds each member's recorded deposit deterministically.
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // Permissionless payout trigger. Anyone may call this once the cycle has
    // been fully funded; the recipient address is derived deterministically
    // from the circle's rotation order, so no admin discretion is involved.
    // CoinType selects the routing currency (USDC-first when sufficient
    // stablecoin balance exists; SUI fallback otherwise).
    // ----------------------------------------------------------
    public fun trigger_payout<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Compliance-gated circles must collect through the per-cycle
        // escrow rail, whose finalize/redeem paths verify attestations.
        // Without this, a gated circle's pot could be run end-to-end on
        // the legacy rail with zero KYC checks (June 2026 audit).
        assert!(!circles::requires_attestation(circle), E_COMPLIANCE_ATTESTATION_REQUIRED);

        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);

        // Cycle must be fully funded before a payout can be released
        assert!(circles::has_all_members_contributed(circle), 56);

        trigger_automatic_payout<CoinType>(circle, wallet, clock, ctx);
    }

    // ----------------------------------------------------------
    // Recipient-pull claim. Only the scheduled rotation recipient may call
    // this, and only after every member has contributed for the current
    // cycle. CoinType controls payout currency routing (USDC-first, SUI
    // fallback) just like trigger_payout. The function deletes any admin
    // discretion over which member is paid.
    // ----------------------------------------------------------
    public fun claim_payout<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);

        // Compliance-gated circles must collect through the per-cycle
        // escrow rail (redeem_claim / finalize_and_redeem_with_attestation).
        assert!(!circles::requires_attestation(circle), E_COMPLIANCE_ATTESTATION_REQUIRED);

        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);

        // Cycle must be fully funded
        assert!(circles::has_all_members_contributed(circle), 56);

        // The scheduled recipient is derived deterministically from the
        // rotation order; only that address may claim.
        let recipient_opt = circles::get_next_payout_recipient(circle);
        assert!(option::is_some(&recipient_opt), 29);
        let scheduled = *option::borrow(&recipient_opt);
        assert!(sender == scheduled, ENotScheduledRecipient);

        trigger_automatic_payout<CoinType>(circle, wallet, clock, ctx);
    }

    #[test]
    fun test_allocate_recovery_debit_amounts_even_split() {
        let debits = allocate_recovery_debit_amounts(vector[100, 100, 100], 300);
        assert!(*vector::borrow(&debits, 0) == 100, 9001);
        assert!(*vector::borrow(&debits, 1) == 100, 9002);
        assert!(*vector::borrow(&debits, 2) == 100, 9003);
    }

    #[test]
    fun test_allocate_recovery_debit_amounts_partial_split_with_remainder() {
        let debits = allocate_recovery_debit_amounts(vector[100, 100, 100], 100);
        assert!(*vector::borrow(&debits, 0) == 34, 9004);
        assert!(*vector::borrow(&debits, 1) == 33, 9005);
        assert!(*vector::borrow(&debits, 2) == 33, 9006);
    }

    #[test]
    fun test_allocate_recovery_debit_amounts_caps_and_redistributes() {
        let debits = allocate_recovery_debit_amounts(vector[100, 10], 100);
        assert!(*vector::borrow(&debits, 0) == 90, 9007);
        assert!(*vector::borrow(&debits, 1) == 10, 9008);
    }

    // ===========================================================
    // Lifecycle tests (test_scenario): legacy custody money path.
    // These run the REAL entrypoints (contribute, contribute_stablecoin,
    // member_deposit_security_deposit, trigger_payout) against a shared
    // test circle + custody wallet, covering the June 2026 audit fixes:
    //   - payout amount = contribution x contributing_members
    //     (member_count - 1), never drawing from security deposits;
    //   - per-member per-round contribution de-duplication;
    //   - security deposit flow unaffected by either fix.
    // ===========================================================

    #[test_only] use sui::test_scenario as ts;
    #[test_only] use njangi::njangi_compliance::{Self as compliance, ComplianceConfig};

    // A non-SUI coin type for the stablecoin rail. coin::mint_for_testing
    // works for any type parameter, no one-time witness needed.
    #[test_only] public struct TESTUSDC has drop {}

    #[test_only] const TEST_ADMIN: address = @0xA11CE;
    #[test_only] const TEST_BOB: address = @0xB0B;
    #[test_only] const TEST_CAROL: address = @0xCA801;
    #[test_only] const TEST_CONTRIBUTION_RAW: u64 = 1_000_000_000; // 1 SUI (9dp)
    #[test_only] const TEST_USD_CENTS: u64 = 250;                  // $2.50
    // $2.50 in USDC micro-units (6dp) = usd_cents_to_usdc_amount(250).
    #[test_only] const TEST_USDC_CONTRIBUTION: u64 = 2_500_000;
    // Security deposit = contribution / 2 in the test circle factory:
    // 125 USD cents = 1_250_000 micro-USDC, or 0.5 SUI on the SUI rail.
    #[test_only] const TEST_USDC_DEPOSIT: u64 = 1_250_000;
    #[test_only] const TEST_SUI_DEPOSIT: u64 = 500_000_000;
    #[test_only] const TEST_START_MS: u64 = 1_000_000;

    /// tx1 (admin): share a 3-member ACTIVE circle (recipient = admin at
    /// rotation position 0, so BOB + CAROL are the 2 expected contributors)
    /// plus its custody wallet. Returns the test clock.
    #[test_only]
    fun setup_circle_and_wallet(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clock, TEST_START_MS);
        let circle_id = circles::share_circle_for_testing(
            vector[TEST_ADMIN, TEST_BOB, TEST_CAROL],
            TEST_CONTRIBUTION_RAW,
            TEST_USD_CENTS,
            &clock,
            ts::ctx(scenario)
        );
        custody::create_custody_wallet(circle_id, TEST_START_MS, ts::ctx(scenario));
        clock
    }

    #[test_only]
    fun contribute_sui_as(scenario: &mut ts::Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(scenario);
        let payment = coin::mint_for_testing<SUI>(TEST_CONTRIBUTION_RAW, ts::ctx(scenario));
        contribute(&mut circle, &mut wallet, payment, clock, ts::ctx(scenario));
        ts::return_shared(circle);
        ts::return_shared(wallet);
    }

    #[test_only]
    fun contribute_usdc_as(scenario: &mut ts::Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(scenario);
        let payment = coin::mint_for_testing<TESTUSDC>(TEST_USDC_CONTRIBUTION, ts::ctx(scenario));
        circles::contribute_stablecoin<TESTUSDC>(&mut circle, &mut wallet, payment, clock, ts::ctx(scenario));
        ts::return_shared(circle);
        ts::return_shared(wallet);
    }

    #[test_only]
    fun deposit_security_usdc_as(scenario: &mut ts::Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(scenario);
        let deposit = coin::mint_for_testing<TESTUSDC>(TEST_USDC_DEPOSIT, ts::ctx(scenario));
        circles::member_deposit_security_deposit<TESTUSDC>(&mut circle, &mut wallet, deposit, clock, ts::ctx(scenario));
        ts::return_shared(circle);
        ts::return_shared(wallet);
    }

    #[test_only]
    fun assert_received_coin<CoinType>(scenario: &mut ts::Scenario, who: address, amount: u64) {
        ts::next_tx(scenario, who);
        let received = ts::take_from_sender<Coin<CoinType>>(scenario);
        assert!(coin::value(&received) == amount, 9101);
        coin::burn_for_testing(received);
    }

    // --- payout amount: contribution x (member_count - 1) --------------

    #[test]
    fun test_stablecoin_payout_pays_contributions_only_and_spares_deposits() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        // All three members post security deposits (commingled in the
        // same wallet balance the payout draws from).
        deposit_security_usdc_as(&mut scenario, TEST_ADMIN, &clock);
        deposit_security_usdc_as(&mut scenario, TEST_BOB, &clock);
        deposit_security_usdc_as(&mut scenario, TEST_CAROL, &clock);

        // Recipient (ADMIN) does not pay in; the 2 others contribute.
        contribute_usdc_as(&mut scenario, TEST_BOB, &clock);
        contribute_usdc_as(&mut scenario, TEST_CAROL, &clock);

        // Anyone may trigger once the cycle is fully funded.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::has_all_members_contributed(&circle), 9102);
        trigger_payout<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));

        // Exactly the 3 security deposits must remain: the payout took
        // contribution x 2 (what was collected), not contribution x 3.
        assert!(
            custody::get_stablecoin_balance<TESTUSDC>(&wallet) == 3 * TEST_USDC_DEPOSIT,
            9103
        );
        // Rotation advanced to position 1.
        assert!(circles::get_current_position(&circle) == 1, 9104);
        ts::return_shared(circle);
        ts::return_shared(wallet);

        // Recipient got exactly 2 contributions' worth.
        assert_received_coin<TESTUSDC>(&mut scenario, TEST_ADMIN, 2 * TEST_USDC_CONTRIBUTION);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    fun test_sui_payout_pays_contributions_only() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        contribute_sui_as(&mut scenario, TEST_CAROL, &clock);

        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::has_all_members_contributed(&circle), 9110);
        // CoinType = SUI must route through the SUI branch (the USDC unit
        // math is meaningless for SUI) and pay contribution x 2.
        trigger_payout<SUI>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        assert!(custody::get_total_wallet_balance(&wallet) == 0, 9111);
        assert!(circles::get_current_position(&circle) == 1, 9112);
        ts::return_shared(circle);
        ts::return_shared(wallet);

        assert_received_coin<SUI>(&mut scenario, TEST_ADMIN, 2 * TEST_CONTRIBUTION_RAW);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 56, location = Self)]
    fun test_trigger_payout_requires_full_funding() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        // Only one of the two expected contributors pays.
        contribute_sui_as(&mut scenario, TEST_BOB, &clock);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        trigger_payout<SUI>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // --- per-round contribution de-duplication --------------------------

    #[test]
    #[expected_failure(
        abort_code = njangi::njangi_circles::E_ALREADY_CONTRIBUTED_THIS_CYCLE,
        location = njangi::njangi_circles
    )]
    fun test_duplicate_sui_contribution_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        // BOB cannot satisfy the funding gate by paying twice.
        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(
        abort_code = njangi::njangi_circles::E_ALREADY_CONTRIBUTED_THIS_CYCLE,
        location = njangi::njangi_circles
    )]
    fun test_duplicate_stablecoin_contribution_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        contribute_usdc_as(&mut scenario, TEST_BOB, &clock);
        contribute_usdc_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(
        abort_code = njangi::njangi_circles::E_ALREADY_CONTRIBUTED_THIS_CYCLE,
        location = njangi::njangi_circles
    )]
    fun test_cross_rail_duplicate_contribution_aborts() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        // One contribution per member per round, regardless of currency:
        // paying SUI then stablecoin in the same round must abort.
        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        contribute_usdc_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    fun test_contributor_record_clears_after_payout() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        // Round 1: recipient ADMIN; BOB + CAROL contribute, payout fires.
        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        contribute_sui_as(&mut scenario, TEST_CAROL, &clock);
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        trigger_payout<SUI>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        assert!(!circles::has_contributed_this_cycle(&circle, TEST_BOB), 9120);
        assert!(!circles::has_contributed_this_cycle(&circle, TEST_CAROL), 9121);
        ts::return_shared(circle);
        ts::return_shared(wallet);
        assert_received_coin<SUI>(&mut scenario, TEST_ADMIN, 2 * TEST_CONTRIBUTION_RAW);

        // Round 2: recipient BOB; ADMIN + CAROL contribute again — the
        // de-dup record must have been cleared by the payout reset.
        contribute_sui_as(&mut scenario, TEST_ADMIN, &clock);
        contribute_sui_as(&mut scenario, TEST_CAROL, &clock);
        ts::next_tx(&mut scenario, TEST_CAROL);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        trigger_payout<SUI>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        assert!(circles::get_current_position(&circle) == 2, 9122);
        ts::return_shared(circle);
        ts::return_shared(wallet);
        assert_received_coin<SUI>(&mut scenario, TEST_BOB, 2 * TEST_CONTRIBUTION_RAW);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // --- security deposit lifecycle stays intact -------------------------

    #[test]
    fun test_security_deposit_lifecycle_unaffected_by_dedup() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        // BOB posts a SUI security deposit through the live legacy path.
        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        let deposit = coin::mint_for_testing<SUI>(TEST_SUI_DEPOSIT, ts::ctx(&mut scenario));
        circles::member_deposit_security_deposit<SUI>(
            &mut circle, &mut wallet, deposit, &clock, ts::ctx(&mut scenario)
        );
        let member = circles::get_member(&circle, TEST_BOB);
        assert!(members::get_deposit_balance(member) == TEST_SUI_DEPOSIT, 9130);
        assert!(members::get_recovery_sui_deposit(member) == TEST_SUI_DEPOSIT, 9131);
        assert!(custody::get_total_wallet_balance(&wallet) == TEST_SUI_DEPOSIT, 9132);
        // A security deposit is NOT a cycle contribution: the de-dup
        // record must not be tripped by it.
        assert!(!circles::has_contributed_this_cycle(&circle, TEST_BOB), 9133);
        ts::return_shared(circle);
        ts::return_shared(wallet);

        // BOB can still contribute normally afterwards.
        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        ts::next_tx(&mut scenario, TEST_BOB);
        let circle = ts::take_shared<Circle>(&scenario);
        assert!(circles::has_contributed_this_cycle(&circle, TEST_BOB), 9134);
        ts::return_shared(circle);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // --- compliance gate blocks the legacy custody rail ------------------
    //
    // June 2026 audit repair: requires_attestation circles must not be
    // able to run their pot on the legacy rail (which has no attestation
    // checks). Contribution AND collection are blocked with abort 216,
    // forcing gated circles onto the per-cycle escrow rail. Security
    // deposits stay ungated.

    #[test_only]
    fun enable_attestation_requirement(scenario: &mut ts::Scenario, clock: &Clock) {
        // Real compliance bootstrap: the admin must pin a config when
        // enabling the requirement (the legacy-rail blocks under test
        // only read the flag, but the setter demands the pin).
        ts::next_tx(scenario, TEST_ADMIN);
        compliance::init_for_testing(ts::ctx(scenario));

        ts::next_tx(scenario, TEST_ADMIN);
        let mut circle = ts::take_shared<Circle>(scenario);
        let config = ts::take_shared<ComplianceConfig>(scenario);
        circles::set_requires_attestation(&mut circle, &config, true, clock, ts::ctx(scenario));
        ts::return_shared(config);
        ts::return_shared(circle);
    }

    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_ATTESTATION_REQUIRED, location = Self)]
    fun test_gated_circle_blocks_legacy_sui_contribute() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);
        enable_attestation_requirement(&mut scenario, &clock);

        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(
        abort_code = njangi::njangi_circles::E_COMPLIANCE_ATTESTATION_REQUIRED,
        location = njangi::njangi_circles
    )]
    fun test_gated_circle_blocks_legacy_stablecoin_contribute() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);
        enable_attestation_requirement(&mut scenario, &clock);

        contribute_usdc_as(&mut scenario, TEST_BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_ATTESTATION_REQUIRED, location = Self)]
    fun test_gated_circle_blocks_legacy_trigger_payout() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        // Fund the cycle on the (still ungated) legacy rail first, THEN
        // gate the circle: collection must be blocked too, otherwise
        // pre-gate contributions could be collected without any KYC.
        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        contribute_sui_as(&mut scenario, TEST_CAROL, &clock);
        enable_attestation_requirement(&mut scenario, &clock);

        ts::next_tx(&mut scenario, TEST_BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        trigger_payout<SUI>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = E_COMPLIANCE_ATTESTATION_REQUIRED, location = Self)]
    fun test_gated_circle_blocks_legacy_claim_payout() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);

        contribute_sui_as(&mut scenario, TEST_BOB, &clock);
        contribute_sui_as(&mut scenario, TEST_CAROL, &clock);
        enable_attestation_requirement(&mut scenario, &clock);

        // ADMIN is the scheduled recipient — even the rightful claimant
        // is pushed onto the escrow rail.
        ts::next_tx(&mut scenario, TEST_ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        claim_payout<SUI>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_gated_circle_still_accepts_security_deposits() {
        let mut scenario = ts::begin(TEST_ADMIN);
        let clock = setup_circle_and_wallet(&mut scenario);
        enable_attestation_requirement(&mut scenario, &clock);

        // Security deposits only ever return to their owner, so they are
        // deliberately exempt from the compliance gate (the UI's deposit
        // flow still runs on the legacy custody path).
        deposit_security_usdc_as(&mut scenario, TEST_BOB, &clock);

        ts::next_tx(&mut scenario, TEST_BOB);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(
            custody::get_stablecoin_balance<TESTUSDC>(&wallet) == TEST_USDC_DEPOSIT,
            9140
        );
        let member = circles::get_member(&circle, TEST_BOB);
        assert!(members::get_deposit_balance(member) > 0, 9141);
        ts::return_shared(circle);
        ts::return_shared(wallet);

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
