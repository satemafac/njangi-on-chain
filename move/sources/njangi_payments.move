module njangi::njangi_payments {
    use sui::coin::Coin;
    use sui::clock::Clock;
    use sui::sui::SUI;
    use std::string::String;

    use njangi::njangi_circles::Circle;
    use njangi::njangi_custody::CustodyWallet;

    // ----------------------------------------------------------
    // v11: the legacy custody money rail is retired.
    //
    // Rounds are paid through the per-round escrow (njangi_cycle_escrow);
    // security deposits through njangi_circles::post_security_deposit. The
    // retired entrypoints below keep their signatures (an upgrade cannot
    // change or remove a public function) and abort with the deprecation
    // code shared with njangi_circles.
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    // Codes 22, 25, 26, 27, 38, 39 and 216 belonged to the retired rail;
    // 23, 24, 28 and 32 were retired earlier. Do not reuse them.
    // Mirrors njangi_circles::E_DEPRECATED_ENTRYPOINT.
    const E_DEPRECATED_ENTRYPOINT: u64 = 89;
    
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
    
    // NOTE: the `MilestoneCompleted` / `MilestoneVerificationSubmitted`
    // events moved to njangi_milestones with the June 2026 smart-goals
    // completion; the milestone machinery is self-contained there now.

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

    // ----------------------------------------------------------
    // Legacy SUI contribution into the custody wallet — RETIRED in v11
    // (rounds: njangi_cycle_escrow::contribute_round / contribute*).
    // ----------------------------------------------------------
    public fun contribute(
        _circle: &mut Circle,
        _wallet: &mut CustodyWallet,
        _payment: Coin<SUI>,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
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
    // Position auctions — RETIRED in v11. Auctions moved payout order and
    // took SUI bids outside the coordination rules. The signatures stay
    // (an upgrade cannot change or remove a public function).
    // ----------------------------------------------------------
    public fun start_position_auction(
        _circle: &mut Circle,
        _position: u64,
        _minimum_bid: u64,
        _duration_days: u64,
        _discount_rate: u64,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun place_bid(
        _circle: &mut Circle,
        _bid: Coin<SUI>,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    public fun complete_auction(
        _circle: &mut Circle,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    // ----------------------------------------------------------
    // Milestone management
    //
    // NOTE: the legacy wrappers (`add_monetary_milestone`,
    // `add_time_milestone`, `verify_milestone`,
    // `submit_milestone_verification`) were removed in the June 2026
    // smart-goals completion. They delegated into the old half-built
    // njangi_milestones scaffolding (admin-verified completion with a
    // placeholder amount, no real progress source). The finished
    // machinery is self-contained in njangi_milestones: admin-defined
    // ordered milestones, progress derived permissionlessly from
    // settled `njangi_cycle_escrow::CycleEscrow` pots, permissionless
    // condition-asserted completion, and `GoalAchieved` on the final
    // milestone. Milestones observe funds; they never hold or move them.
    // ----------------------------------------------------------

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
    // Legacy custody-rail payouts — RETIRED in v11. Round payouts are
    // collected from the per-round escrow by the scheduled recipient
    // (njangi_cycle_escrow::finalize_and_redeem / redeem_claim).
    // ----------------------------------------------------------
    #[allow(unused_type_parameter)]
    public fun trigger_payout<CoinType>(
        _circle: &mut Circle,
        _wallet: &mut CustodyWallet,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

    #[allow(unused_type_parameter)]
    public fun claim_payout<CoinType>(
        _circle: &mut Circle,
        _wallet: &mut CustodyWallet,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        abort E_DEPRECATED_ENTRYPOINT
    }

}
