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
    const EPayoutAlreadyProcessed: u64 = 23;
    const EInvalidPayoutSchedule: u64 = 24;
    const EInsufficientTreasuryBalance: u64 = 25;
    const EInvalidBidAmount: u64 = 26;
    const EAuctionNotActive: u64 = 27;
    const EInvalidMilestone: u64 = 28;
    const EMilestoneTargetInvalid: u64 = 32;
    const EAmountOverflow: u64 = 38;
    const ENotScheduledRecipient: u64 = 39;
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

        // ------- SAFEGUARDS & ASSERTIONS -------
        assert!(contribution_amount_raw > 0, 59); // Raw contribution amount must be positive
        assert!(member_count > 0, 62); // Must have at least one member

        // USDC-first: required payout amount in stablecoin micro-units (6dp).
        let stablecoin_per_member = custody::usd_cents_to_usdc_amount(contribution_amount_usd);
        let stablecoin_payout_amount = safe_mul(stablecoin_per_member, member_count);
        let stablecoin_balance = custody::get_stablecoin_balance<CoinType>(wallet);

        if (stablecoin_payout_amount > 0 && stablecoin_balance >= stablecoin_payout_amount) {
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
                member_count,
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

            let human_readable_payout = contribution_amount_readable * member_count;
            event::emit(PayoutProcessed {
                circle_id,
                recipient,
                amount: human_readable_payout,
                cycle: circles::get_current_cycle(circle),
                payout_type: circles::get_goal_type(circle),
            });
            return
        };

        // Fallback to SUI when USDC is insufficient.
        let payout_amount = safe_mul(contribution_amount_raw, member_count);
        assert!(payout_amount > 0, EInvalidPayoutAmount);
        let sui_balance = custody::get_raw_balance(wallet);

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
            member_count,
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

        let human_readable_payout = contribution_amount_readable * member_count;
        event::emit(PayoutProcessed {
            circle_id,
            recipient,
            amount: human_readable_payout,
            cycle: circles::get_current_cycle(circle),
            payout_type: circles::get_goal_type(circle),
        });
    }
    
    // ----------------------------------------------------------
    // Process scheduled payout
    // ----------------------------------------------------------
    public fun process_scheduled_payout(
        circle: &mut Circle,
        recipient: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), 7);
        assert!(circles::is_member(circle, recipient), 8);
        
        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);
        
        let current_time = clock::timestamp_ms(clock);
        assert!(current_time >= circles::get_next_payout_time(circle), EInvalidPayoutSchedule);
        
        // First check properties that don't require mutable borrowing
        let member = circles::get_member(circle, recipient);
        assert!(!members::has_received_payout(member), EPayoutAlreadyProcessed);
        
        // Calculate payout amount before any mutable borrowing
        let contribution_amount = circles::get_contribution_amount(circle);
        let (total_contributions, _, _) = circles::get_treasury_balances(circle);
        
        let payout_amount = if (circles::has_goal_type(circle)) {
            // Proportional to how much the user contributed, relative to total in the circle
            let member_contributed = members::get_total_contributed(member);
            let member_count = circles::get_member_count(circle);
            
            (member_contributed * total_contributions) / (contribution_amount * member_count)
        } else {
            // Rotational
            contribution_amount * circles::get_member_count(circle)
        };
        
        assert!(total_contributions >= payout_amount, EInsufficientTreasuryBalance);
        
        // Now perform the mutable operations
        let payout_coin: Coin<SUI> = coin::from_balance(
            circles::split_from_contributions(circle, payout_amount),
            ctx
        );
        
        // Mark the member as paid after we've done everything else
        let member_mut = circles::get_member_mut(circle, recipient);
        members::set_received_payout(member_mut, true);
        
        transfer::public_transfer(payout_coin, recipient);
        
        event::emit(PayoutProcessed {
            circle_id: circles::get_id(circle),
            recipient,
            amount: payout_amount,
            cycle: circles::get_current_cycle(circle),
            payout_type: circles::get_goal_type(circle),
        });
    }
    
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
    // ----------------------------------------------------------
    public fun process_security_deposit_return(
        circle: &mut Circle,
        member_addr: address,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == circles::get_admin(circle), 7);
        
        // Circle must not be active to return security deposits
        assert!(!circles::is_circle_active(circle), 54);
        
        let member = circles::get_member(circle, member_addr);
        
        // Ensure no obligations
        assert!(
            members::get_total_contributed(member) >= 
            circles::get_contribution_amount(circle) * members::get_total_meetings_required(member),
            18
        );
        
        // Possibly partial if the user has warnings or low reputation
        let returnable_amount =
            if (members::get_warning_count(member) == 0 && members::get_reputation_score(member) >= 80) {
                members::get_deposit_balance(member)
            } else {
                (members::get_deposit_balance(member) * (members::get_reputation_score(member) as u64)) / 100
            };
        
        assert!(returnable_amount > 0 && returnable_amount <= members::get_deposit_balance(member), EInvalidPayoutAmount);
        
        let (_, deposits_balance, _) = circles::get_treasury_balances(circle);
        assert!(deposits_balance >= returnable_amount, EInsufficientTreasuryBalance);
        
        let deposit_coin: Coin<SUI> = coin::from_balance(
            circles::split_from_deposits(circle, returnable_amount),
            ctx
        );
        
        let member_mut = circles::get_member_mut(circle, member_addr);
        members::subtract_from_deposit_balance(member_mut, returnable_amount);
        members::subtract_recovery_sui_deposit(member_mut, returnable_amount);
        
        transfer::public_transfer(deposit_coin, member_addr);
    }
    
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
}
