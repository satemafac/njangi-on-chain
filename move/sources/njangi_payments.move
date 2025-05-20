module njangi::njangi_payments {
    use sui::object::ID;
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::sui::SUI;
    use sui::transfer;
    use std::option::{Self, Option};
    use std::string::{Self, String};
    use std::vector;
    
    use njangi::njangi_core as core;
    use njangi::njangi_circles::{Self as circles, Circle};
    use njangi::njangi_members::{Self as members, Member};
    use njangi::njangi_custody::{Self as custody, CustodyWallet};
    use njangi::njangi_milestones::{Self as milestones, MilestoneData};
    use njangi::njangi_circle_config as config;
    
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
    const EInvalidRotationPosition: u64 = 29;
    const EPositionAlreadyTaken: u64 = 30;
    const EMilestoneTypeInvalid: u64 = 31;
    const EMilestoneTargetInvalid: u64 = 32;
    const EMilestoneVerificationFailed: u64 = 33;
    const EMilestoneDeadlinePassed: u64 = 34;
    const EMilestoneAlreadyVerified: u64 = 35;
    const EMilestonePrerequisiteNotMet: u64 = 36;
    const EUnsupportedToken: u64 = 37;
    
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
    public struct PayoutWindow has store, drop {
        start_time: u64,
        end_time: u64,
        recipient: address,
        amount: u64
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
        
        let contribution_amount = circles::get_contribution_amount(circle);
        let payment_amount = coin::value(&payment);
        
        // Must be at least the `contribution_amount`
        assert!(payment_amount >= contribution_amount, 1);
        // Verify custody wallet belongs to this circle
        assert!(custody::get_circle_id(wallet) == circles::get_id(circle), 46);

        let member = circles::get_member(circle, sender);
        assert!(members::get_status(member) == 0, 14); // MEMBER_STATUS_ACTIVE
        assert!(option::is_none(&members::get_suspension_end_time(member)), 13); // EMemberSuspended

        // IMPORTANT: First deposit the payment into the wallet BEFORE updating counters
        // This ensures the funds are available before any potential withdrawal attempt
        custody::deposit(wallet, payment, ctx);

        // Update stats AFTER the funds are deposited
        let member_mut = circles::get_member_mut(circle, sender);
        members::record_contribution(member_mut, contribution_amount, clock::timestamp_ms(clock));

        // Track this contribution in the current cycle's counter
        // Use actual payment amount (which is already in raw format with 9 decimals)
        circles::add_to_contributions_this_cycle(circle, payment_amount);

        event::emit(ContributionMade {
            circle_id: circles::get_id(circle),
            member: sender,
            amount: payment_amount,
            cycle: circles::get_current_cycle(circle),
        });
        
        // Check if the circle is active and if all members have contributed for this cycle
        // But we DONT attempt to trigger the payout automatically after a contribution
        // This avoids the race condition between contribution and withdrawal
        // Admin must explicitly trigger payouts with admin_trigger_payout
    }
    
    // ----------------------------------------------------------
    // Internal function to trigger automatic payout when all members have contributed
    // ----------------------------------------------------------
    fun trigger_automatic_payout(
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
        // Get both SUI and USD amounts for proper calculation and checks
        let circle_id = circles::get_id(circle);
        
        // Check if we have stablecoin contributions first
        let has_stablecoins = custody::has_any_stablecoin_balance(wallet);
        
        // Count active members to ensure we use the correct member count
        let member_count = circles::get_member_count(circle);
        
        // Get contribution amounts
        let contribution_amount_raw = circles::get_contribution_amount_raw(circle);
        let contribution_amount_readable = circles::get_contribution_amount(circle);
        let contribution_amount_usd = circles::get_contribution_amount_usd(circle);
        
        // Calculate how many members are contributing (minus the recipient)
        let contributing_member_count = if (member_count > 0) { member_count - 1 } else { 0 };
        
        // Calculate required SUI amount for a full payout
        let required_sui_amount = contribution_amount_raw * contributing_member_count;
        
        // Get actual SUI balance - use get_raw_balance to only check main balance
        let sui_balance = custody::get_raw_balance(wallet);
        
        // Determine if we should use stablecoin or SUI for payout
        // We use stablecoins IF:
        // 1. We have stablecoins available AND
        // 2. (We don't have enough SUI OR the circle is configured to prefer stablecoins)
        let mut payout_in_stablecoin = false;
        
        if (has_stablecoins && (sui_balance < required_sui_amount)) {
            // We've detected that there's insufficient SUI but stablecoins are available
            // Set a special flag to indicate this
            payout_in_stablecoin = true;
            
            // If we're going to use stablecoins, we need to abort this function with
            // a specific error code (100) that tells the client to call admin_trigger_usdc_payout instead
            // This prevents attempting an SUI withdrawal that will fail
            if (payout_in_stablecoin) {
                // Return error code 100 = Use stablecoins instead
                abort 100
            }
        };
        
        // For payout to member, we still use all members (the traditional approach)
        // The recipient gets the full payout as normal (all members' contributions)
        let mut payout_amount = contribution_amount_raw * member_count;
        
        // ------- SAFEGUARDS & ASSERTIONS -------
        // Check if we have a valid contribution amount
        assert!(contribution_amount_raw > 0, 59); // Raw contribution amount must be positive
        // We no longer need this check as raw values are more reliable for small amounts
        // assert!(contribution_amount_readable > 0, 60); // Readable amount must be positive
        assert!(member_count > 0, 62); // Must have at least one member
        assert!(payout_amount > 0, EInvalidPayoutAmount); // Final payout must be positive
        
        // At this point, we know we're using SUI (not stablecoins) - check if wallet has sufficient balance
        // NOTE: Using get_raw_balance which only checks the main balance, not security deposits in dynamic fields
        assert!(sui_balance > 0, EInsufficientTreasuryBalance);
        
        // Use whatever balance we have for the payout, but only use the main balance
        payout_amount = sui_balance;
        
        // Emit debug info for troubleshooting
        event::emit(PayoutDebugInfo {
            wallet_balance: sui_balance, // Always report SUI balance
            contribution_amount: contribution_amount_raw,
            member_count,
            payout_amount,
            payout_reason: string::utf8(b"Using SUI contributions")
        });
        
        // ------- EXECUTE THE PAYOUT -------
        // Mark member as paid before making payment (to prevent reentrancy)
        let member_mut = circles::get_member_mut(circle, recipient);
        members::set_received_payout(member_mut, true);
        
        // Process SUI payout from custody wallet (original logic)
        let payout_coin = custody::withdraw(wallet, payout_amount, ctx);
        
        // Transfer the payout to the recipient
        transfer::public_transfer(payout_coin, recipient);
        
        // Reset the contributions counter for this cycle
        circles::reset_contributions_this_cycle(circle);
        
        // Update rotation position and cycle if needed
        circles::advance_rotation_position_and_cycle(circle, recipient, clock);
        
        // Emit payout event with human-readable amount for UI display
        let human_readable_payout = contribution_amount_readable * member_count;
        event::emit(PayoutProcessed {
            circle_id: circle_id,
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
        let payout_coin = coin::from_balance(
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
    // Process payout from custody wallet
    // ----------------------------------------------------------
    public fun process_custody_payout(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        recipient: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        
        // Only circle admin can process payouts
        assert!(sender == circles::get_admin(circle), 7);
        
        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);
        
        // Verify custody wallet belongs to this circle
        assert!(custody::get_circle_id(wallet) == circles::get_id(circle), 46);
        
        // Wallet must be active
        assert!(custody::is_wallet_active(wallet), 43);
        
        // Check if wallet is time-locked
        if (custody::is_wallet_locked(wallet)) {
            let lock_time = custody::get_lock_time(wallet);
            assert!(current_time >= lock_time, 44);
        };
        
        // Verify recipient is a member
        assert!(circles::is_member(circle, recipient), 8);
        
        // Check timing and member status for payout
        let member = circles::get_member(circle, recipient);
        
        assert!(current_time >= circles::get_next_payout_time(circle), EInvalidPayoutSchedule);
        assert!(!members::has_received_payout(member), EPayoutAlreadyProcessed);
        
        // Calculate payout amount
        let contribution_amount = circles::get_contribution_amount(circle);
        let payout_amount = if (circles::has_goal_type(circle)) {
            // Proportional payout based on contribution
            let (total_contributions, _, _) = circles::get_treasury_balances(circle);
            (members::get_total_contributed(member) * total_contributions)
            / (contribution_amount * circles::get_member_count(circle))
        } else {
            // Standard rotational payout
            contribution_amount * circles::get_member_count(circle)
        };
        
        // Verify sufficient funds in wallet
        assert!(custody::get_balance(wallet) >= payout_amount, 12);
        
        // Check daily withdrawal limit
        assert!(custody::check_withdrawal_limit(wallet, payout_amount), 45);
        
        // Process payout
        let payout_coin = custody::withdraw(wallet, payout_amount, ctx);
        
        // Mark member as paid
        let member_mut = circles::get_member_mut(circle, recipient);
        members::set_received_payout(member_mut, true);
        
        // Send the payout to recipient
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
            let refund_coin = coin::from_balance(
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
            circles::set_rotation_position(circle, winner, position, ctx);
            
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
        
        let deposit_coin = coin::from_balance(
            circles::split_from_deposits(circle, returnable_amount),
            ctx
        );
        
        let member_mut = circles::get_member_mut(circle, member_addr);
        members::subtract_from_deposit_balance(member_mut, returnable_amount);
        
        transfer::public_transfer(deposit_coin, member_addr);
    }
    
    // ----------------------------------------------------------
    // Admin function to manually trigger the automatic payout
    // This function:
    // 1. Verifies all members have contributed for the current cycle
    // 2. Analyzes wallet contents to determine the best payout method (SUI or stablecoin)
    // 3. Calculates appropriate payout amount 
    // 4. Executes the payout and updates cycle/rotation state
    // ----------------------------------------------------------
    public entry fun admin_trigger_payout(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can trigger manual payout
        assert!(sender == circles::get_admin(circle), 7);
        
        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);
        
        // Check if all members have contributed for this cycle
        assert!(circles::has_all_members_contributed(circle), 56); 
        
        // Call the same function that automatic payout uses to maintain consistent logic
        // We catch any error 100 (use stablecoins) and propagate it
        trigger_automatic_payout(circle, wallet, clock, ctx);
    }
    
    // ----------------------------------------------------------
    // Admin function to force a payout to a specific member
    // ----------------------------------------------------------
    public entry fun admin_force_payout(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        recipient: address,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can force a payout
        assert!(sender == circles::get_admin(circle), 7);
        
        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);
        
        // Verify recipient is a member
        assert!(circles::is_member(circle, recipient), 8);
        
        // Get member and check they haven't already been paid
        let member = circles::get_member(circle, recipient);
        assert!(!members::has_received_payout(member), EPayoutAlreadyProcessed);
        
        // Calculate payout amount - for rotational circles, it's contribution_amount * member_count
        let contribution_amount = circles::get_contribution_amount(circle);
        let member_count = circles::get_member_count(circle);
        let mut payout_amount = core::to_decimals(contribution_amount) * member_count;
        
        // Verify sufficient funds in wallet
        // Use custody::get_raw_balance which checks only the main balance, not dynamic fields
        let sui_balance = custody::get_raw_balance(wallet);
        
        // For a forced payout, we still need to check that we have enough funds
        // but we don't necessarily expect all members to have contributed
        assert!(sui_balance > 0, EInsufficientTreasuryBalance);
        
        // CHANGE: Adjust payout amount to match available funds
        // This allows admin to force a partial payout with whatever is available
        if (sui_balance < payout_amount) {
            payout_amount = sui_balance;
        };
        
        // Mark member as paid before making payment (to prevent reentrancy)
        let member_mut = circles::get_member_mut(circle, recipient);
        members::set_received_payout(member_mut, true);
        
        // Process payout from custody wallet
        let payout_coin = custody::withdraw(wallet, payout_amount, ctx);
        
        // Transfer the payout to the recipient
        transfer::public_transfer(payout_coin, recipient);
        
        // Reset the contributions counter for this cycle
        circles::reset_contributions_this_cycle(circle);
        
        // Update rotation state
        // For forced payouts, we need to ensure the current position aligns with the paid member
        // Find the recipient's position in the rotation order
        let rotation_order = circles::get_rotation_order(circle);
        let mut member_position = 0;
        let mut found = false;
        
        let mut i = 0;
        let len = vector::length(&rotation_order);
        
        while (i < len) {
            let addr = *vector::borrow(&rotation_order, i);
            if (addr == recipient) {
                member_position = i;
                found = true;
                break
            };
            i = i + 1;
        };
        
        // Set the current position to the member's position before advancing
        if (found) {
            // This is an internal module function that needs to be exposed as package visibility in circles module
            circles::set_current_position(circle, member_position);
            // Now advance to the next position
            circles::advance_rotation_position_and_cycle(circle, recipient, clock);
        };
        
        // Emit payout event
        event::emit(PayoutProcessed {
            circle_id: circles::get_id(circle),
            recipient,
            amount: contribution_amount * member_count, // Use human-readable amount for the event
            cycle: circles::get_current_cycle(circle),
            payout_type: circles::get_goal_type(circle),
        });
    }
    
    // ----------------------------------------------------------
    // Admin function to trigger payout using USDC stablecoin
    // This function handles direct stablecoin payments when there's insufficient SUI
    // ----------------------------------------------------------
    public entry fun admin_trigger_usdc_payout<CoinType>(
        circle: &mut Circle,
        wallet: &mut CustodyWallet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Only admin can trigger manual payout
        assert!(sender == circles::get_admin(circle), 7);
        
        // Circle must be active for payouts
        assert!(circles::is_circle_active(circle), 54);
        
        // Check if all members have contributed for this cycle
        assert!(circles::has_all_members_contributed(circle), 56);
        
        // Verify this is a stablecoin type
        assert!(custody::has_stablecoin_balance<CoinType>(wallet), EUnsupportedToken);
        
        // Get the next recipient
        let recipient_opt = circles::get_next_payout_recipient(circle);
        assert!(option::is_some(&recipient_opt), 29); // No valid recipient
        let recipient = *option::borrow(&recipient_opt);
        
        // Verify recipient is a member and hasn't been paid
        assert!(circles::is_member(circle, recipient), 8);
        let member = circles::get_member(circle, recipient);
        assert!(!members::has_received_payout(member), EPayoutAlreadyProcessed);
        
        // Calculate stablecoin payout amount 
        let contribution_amount_usd = circles::get_contribution_amount_usd(circle);
        let member_count = circles::get_member_count(circle);
        
        // Convert USD cents to coin micro-units
        // For 6-decimal coins like USDC: 1 cent = 10,000 micro-units
        let stablecoin_unit_per_cent = 10000;
        let theoretical_payout_amount = contribution_amount_usd * stablecoin_unit_per_cent * member_count;
        
        // Verify sufficient stablecoin balance
        let total_stablecoin_balance = custody::get_stablecoin_balance<CoinType>(wallet);
        
        // Debug print to check current payout time
        std::debug::print(&b"Current next_payout_time BEFORE update:");
        std::debug::print(&circles::get_next_payout_time(circle));
        
        // Calculate security deposit amount in USDC
        let security_deposit_usd = circles::get_security_deposit_usd(circle);
        let security_deposit_amount = security_deposit_usd * stablecoin_unit_per_cent * member_count;
        
        // The available balance for payout is the total balance minus the security deposits
        let mut available_balance = total_stablecoin_balance;
        if (total_stablecoin_balance > security_deposit_amount) {
            available_balance = total_stablecoin_balance - security_deposit_amount;
        } else {
            // If there's not enough to cover security deposits, this could be an issue,
            // but we'll continue with whatever balance is available for testing purposes
            available_balance = 0;
        };
        
        // Verify there's something to withdraw
        assert!(available_balance > 0, EInsufficientTreasuryBalance);
        
        // Determine actual payout amount - ensure it doesn't exceed available balance
        let actual_payout_amount = if (theoretical_payout_amount <= available_balance) {
            theoretical_payout_amount
        } else {
            available_balance
        };
        
        // Mark member as paid before making payment (to prevent reentrancy)
        let member_mut = circles::get_member_mut(circle, recipient);
        members::set_received_payout(member_mut, true);
        
        // Process stablecoin payout from custody wallet
        let stablecoin = custody::withdraw_stablecoin<CoinType>(
            wallet,
            actual_payout_amount,
            recipient,
            clock,
            ctx
        );
        
        // Transfer directly to recipient
        transfer::public_transfer(stablecoin, recipient);
        
        // Reset contributions counter
        circles::reset_contributions_this_cycle(circle);
        
        // Update rotation state
        circles::advance_rotation_position_and_cycle(circle, recipient, clock);
        
        // Debug print to check updated payout time
        std::debug::print(&b"Current next_payout_time AFTER update:");
        std::debug::print(&circles::get_next_payout_time(circle));
        
        // Emit payout event (use USD amount for display)
        event::emit(PayoutProcessed {
            circle_id: circles::get_id(circle),
            recipient,
            amount: contribution_amount_usd, // USD cents
            cycle: circles::get_current_cycle(circle),
            payout_type: circles::get_goal_type(circle),
        });
    }
} 