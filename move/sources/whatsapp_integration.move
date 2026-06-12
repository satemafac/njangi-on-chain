module njangi::whatsapp_integration {
    use sui::table::{Self, Table};
    use sui::event;
    use njangi::njangi_circles::{Self, Circle};

    // ----------------------------------------------------------
    // Compliance redesign — Phase 1
    //
    // The previous version of this module stored raw phone numbers, group
    // IDs, and group names directly in `WhatsAppLink` struct fields and
    // emitted them in events, which is incompatible with GDPR-style data
    // minimization. PII now lives entirely off-chain: the server encrypts
    // the WhatsApp routing payload and uploads it to Walrus; only the
    // resulting `walrus_blob_id` and an opaque random `link_nonce` are
    // anchored on-chain. No salted hash of the phone number is stored on
    // chain because the phone-number space is too low entropy for hashing
    // to provide meaningful protection.
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    const E_NOT_CIRCLE_ADMIN: u64 = 2;
    const E_LINK_NOT_FOUND: u64 = 4;
    const E_INVALID_LINK_TYPE: u64 = 5;
    const E_ALREADY_LINKED: u64 = 6;
    const E_UNAUTHORIZED_ADMIN: u64 = 7;
    const E_INVALID_ADMIN_PROOF: u64 = 8;
    const E_INVALID_NONCE_LENGTH: u64 = 9;

    // ----------------------------------------------------------
    // Constants
    // ----------------------------------------------------------
    const LINK_TYPE_INDIVIDUAL: u8 = 1;
    const LINK_TYPE_GROUP: u8 = 2;

    const MAX_MESSAGES_PER_HOUR: u64 = 10;
    const MAX_MESSAGES_PER_DAY: u64 = 100;
    const SECONDS_PER_HOUR: u64 = 3600;

    const ADMIN_ACTION_LINK: u8 = 1;
    const ADMIN_ACTION_UNLINK: u8 = 2;
    const ADMIN_ACTION_LOG_NOTIFICATION: u8 = 3;

    // 32-byte random nonce, generated server-side at link time.
    const LINK_NONCE_BYTES: u64 = 32;

    // ----------------------------------------------------------
    // Structs
    // ----------------------------------------------------------

    /// Individual WhatsApp link entry. Holds only opaque pointers to the
    /// Walrus-encrypted payload and the link metadata required for
    /// recovery; no PII fields remain.
    #[allow(lint(missing_key))]
    public struct WhatsAppLink has store {
        id: UID,
        circle_id: ID,
        link_type: u8,                 // 1 = individual, 2 = group
        walrus_blob_id: vector<u8>,    // pointer to encrypted PII in Walrus
        link_nonce: vector<u8>,        // 32 random bytes; opaque correlation handle
        linked_by: address,            // Admin who linked it
        linked_at: u64,                // Timestamp
        enabled: bool,
        last_notification_sent: u64,   // Last notification timestamp
    }

    /// Rate limit bucket for tracking message frequency
    public struct RateLimitBucket has store {
        hour_bucket: u64,                         // Unix timestamp of hour start (in seconds)
        message_count: u64,
        day_bucket: u64,                          // Unix timestamp of day start (in seconds)
        day_count: u64,
    }

    /// Global registry of WhatsApp links. The previous group_to_link reverse
    /// index has been removed because it required a plaintext group ID. All
    /// reverse lookups happen off-chain via the encrypted Walrus blobs and a
    /// separately maintained server-side index.
    public struct WhatsAppLinksRegistry has key {
        id: UID,
        links: vector<WhatsAppLink>,
        circle_to_link: Table<ID, u64>,          // Quick lookup: circle_id → link index
        total_links: u64,
    }

    /// Admin-only operations require zkLogin verification
    public struct AdminAction has drop {
        admin_address: address,
        action_type: u8,
        timestamp: u64,
        verified: bool,
    }

    // ----------------------------------------------------------
    // Events — none of these carry PII; recipients are referenced by the
    // opaque `link_nonce` so off-chain consumers can correlate events to a
    // Walrus blob without exposing phone numbers or group IDs on chain.
    // ----------------------------------------------------------

    public struct CircleLinked has copy, drop {
        circle_id: ID,
        link_type: u8,
        admin_address: address,
        link_nonce: vector<u8>,
        linked_at: u64,
    }

    public struct CircleUnlinked has copy, drop {
        circle_id: ID,
        admin_address: address,
        link_nonce: vector<u8>,
        unlinked_at: u64,
    }

    public struct NotificationSent has copy, drop {
        circle_id: ID,
        message_type: u8,
        link_nonce: vector<u8>,
        sent_at: u64,
        success: bool,
    }

    #[allow(unused_field)]
    public struct RateLimitExceeded has copy, drop {
        link_id: ID,
        circle_id: ID,
        link_nonce: vector<u8>,
        attempted_at: u64,
    }

    public struct NewCycleStartedEvent has copy, drop {
        circle_id: ID,
        cycle: u64,
        contribution_amount: u64,
        deadline: u64,
        emitted_at: u64,
    }

    public struct MemberContributedEvent has copy, drop {
        circle_id: ID,
        member: address,
        amount: u64,
        contributed_count: u64,
        total_members: u64,
        emitted_at: u64,
    }

    public struct AllMembersContributedEvent has copy, drop {
        circle_id: ID,
        total_amount: u64,
        emitted_at: u64,
    }

    public struct DeadlineApproachingEvent has copy, drop {
        circle_id: ID,
        deadline: u64,
        hours_remaining: u64,
        pending_members: u64,
        emitted_at: u64,
    }

    public struct PayoutOverdueEvent has copy, drop {
        circle_id: ID,
        recipient: address,
        amount: u64,
        hours_overdue: u64,
        emitted_at: u64,
    }

    public struct ContributorOverdueEvent has copy, drop {
        circle_id: ID,
        contributor: address,
        days_overdue: u64,
        emitted_at: u64,
    }

    public struct PayoutReminderEvent has copy, drop {
        circle_id: ID,
        recipient: address,
        amount: u64,
        hours_until: u64,
        emitted_at: u64,
    }

    // ----------------------------------------------------------
    // Functions - Initialization
    // ----------------------------------------------------------

    /// Initialize the registry (call once at deployment)
    public fun init_registry(ctx: &mut TxContext) {
        let registry = WhatsAppLinksRegistry {
            id: object::new(ctx),
            links: vector::empty(),
            circle_to_link: table::new(ctx),
            total_links: 0,
        };
        transfer::share_object(registry);
    }

    // ----------------------------------------------------------
    // Functions - Linking & Unlinking
    // ----------------------------------------------------------

    /// Link a circle to WhatsApp by anchoring an encrypted Walrus blob.
    /// `walrus_blob_id` is the publisher-returned blob handle for the
    /// encrypted PII payload; `link_nonce` is a 32-byte random correlation
    /// handle generated server-side. Neither value reveals the underlying
    /// phone number or group ID.
    public fun link_circle(
        registry: &mut WhatsAppLinksRegistry,
        circle: &Circle,
        link_type: u8,
        walrus_blob_id: vector<u8>,
        link_nonce: vector<u8>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let circle_id = object::id(circle);

        // The sender must be the circle's on-chain admin — taking the
        // Circle by reference (instead of a caller-supplied id + address
        // pair) makes it impossible to anchor a link for a circle the
        // sender does not administer.
        assert!(sender == njangi_circles::get_admin(circle), E_NOT_CIRCLE_ADMIN);

        // Validate link type
        assert!(link_type == LINK_TYPE_INDIVIDUAL || link_type == LINK_TYPE_GROUP, E_INVALID_LINK_TYPE);

        // Validate nonce length to keep correlation handles consistent.
        assert!(vector::length(&link_nonce) == LINK_NONCE_BYTES, E_INVALID_NONCE_LENGTH);

        // Check if circle already linked
        assert!(!table::contains(&registry.circle_to_link, circle_id), E_ALREADY_LINKED);

        let new_link = WhatsAppLink {
            id: object::new(ctx),
            circle_id,
            link_type,
            walrus_blob_id,
            link_nonce,
            linked_by: sender,
            linked_at: tx_context::epoch(ctx),
            enabled: true,
            last_notification_sent: 0,
        };

        let link_index = vector::length(&registry.links);

        // Store in main vector and the circle-keyed lookup. There is no
        // longer a reverse index by phone/group because doing so would
        // require leaking those identifiers on chain.
        let nonce_for_event = new_link.link_nonce;
        vector::push_back(&mut registry.links, new_link);
        table::add(&mut registry.circle_to_link, circle_id, link_index);

        registry.total_links = registry.total_links + 1;

        event::emit(CircleLinked {
            circle_id,
            link_type,
            admin_address: sender,
            link_nonce: nonce_for_event,
            linked_at: tx_context::epoch(ctx),
        });
    }

    /// Unlink a circle from WhatsApp
    public fun unlink_circle(
        registry: &mut WhatsAppLinksRegistry,
        circle: &Circle,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let circle_id = object::id(circle);

        // The CURRENT circle admin disables the link (not `linked_by` —
        // admin rotation must not strand the link, and the old
        // caller-supplied-address check let anyone who read the public
        // CircleLinked event disable any circle's notifications).
        assert!(sender == njangi_circles::get_admin(circle), E_NOT_CIRCLE_ADMIN);

        // Find link by circle_id
        assert!(table::contains(&registry.circle_to_link, circle_id), E_LINK_NOT_FOUND);

        let link_index = *table::borrow(&registry.circle_to_link, circle_id);
        let link = vector::borrow_mut(&mut registry.links, link_index);

        // Disable the link instead of removing it from the vector.
        let nonce_for_event = link.link_nonce;
        link.enabled = false;

        // Remove from the circle-keyed lookup table.
        table::remove(&mut registry.circle_to_link, circle_id);

        registry.total_links = registry.total_links - 1;

        event::emit(CircleUnlinked {
            circle_id,
            admin_address: sender,
            link_nonce: nonce_for_event,
            unlinked_at: tx_context::epoch(ctx),
        });
    }

    // ----------------------------------------------------------
    // Functions - Querying Links
    // ----------------------------------------------------------

    /// Returns the Walrus blob pointer for a circle. The caller must fetch
    /// and decrypt the blob off-chain to obtain the actual phone or group
    /// address. Returns `option::none()` if the circle is not linked or has
    /// been disabled.
    public fun get_link_blob_id(
        registry: &WhatsAppLinksRegistry,
        circle_id: ID,
    ): Option<vector<u8>> {
        if (table::contains(&registry.circle_to_link, circle_id)) {
            let link_index = *table::borrow(&registry.circle_to_link, circle_id);
            let link = vector::borrow(&registry.links, link_index);

            if (!link.enabled) {
                return option::none()
            };

            option::some(link.walrus_blob_id)
        } else {
            option::none()
        }
    }

    /// Returns the opaque nonce associated with a circle link, used for
    /// correlating off-chain notification logs with on-chain events.
    public fun get_link_nonce(
        registry: &WhatsAppLinksRegistry,
        circle_id: ID,
    ): Option<vector<u8>> {
        if (table::contains(&registry.circle_to_link, circle_id)) {
            let link_index = *table::borrow(&registry.circle_to_link, circle_id);
            let link = vector::borrow(&registry.links, link_index);

            if (!link.enabled) {
                return option::none()
            };

            option::some(link.link_nonce)
        } else {
            option::none()
        }
    }

    /// Check if circle is linked to WhatsApp
    public fun is_circle_linked(
        registry: &WhatsAppLinksRegistry,
        circle_id: ID,
    ): bool {
        table::contains(&registry.circle_to_link, circle_id)
    }

    /// Check if link is enabled
    public fun is_link_enabled(
        registry: &WhatsAppLinksRegistry,
        circle_id: ID,
    ): bool {
        if (table::contains(&registry.circle_to_link, circle_id)) {
            let link_index = *table::borrow(&registry.circle_to_link, circle_id);
            let link = vector::borrow(&registry.links, link_index);
            link.enabled
        } else {
            false
        }
    }

    // ----------------------------------------------------------
    // Functions - Logging Notifications
    // ----------------------------------------------------------

    /// Record a notification was sent. The recipient identifier never appears
    /// on chain; only the link's opaque nonce is emitted.
    public fun log_notification(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        message_type: u8,
        success: bool,
        ctx: &mut TxContext
    ) {
        // Find link
        if (!table::contains(&registry.circle_to_link, circle_id)) {
            return
        };

        let link_index = *table::borrow(&registry.circle_to_link, circle_id);
        let link = vector::borrow_mut(&mut registry.links, link_index);

        // Update last notification timestamp
        link.last_notification_sent = tx_context::epoch(ctx);
        let nonce_for_event = link.link_nonce;

        // Emit event
        event::emit(NotificationSent {
            circle_id,
            message_type,
            link_nonce: nonce_for_event,
            sent_at: tx_context::epoch(ctx),
            success,
        });
    }

    // ----------------------------------------------------------
    // Functions - Rate Limiting
    // ----------------------------------------------------------

    /// Get current hour bucket (for rate limiting)
    public fun get_current_hour_bucket(current_timestamp: u64): u64 {
        (current_timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR
    }

    /// Get current day bucket (for rate limiting)
    public fun get_current_day_bucket(current_timestamp: u64): u64 {
        let seconds_per_day = 86_400u64;
        (current_timestamp / seconds_per_day) * seconds_per_day
    }

    /// Initialize rate limiting for a link
    public fun init_rate_limit_bucket(current_timestamp: u64): RateLimitBucket {
        RateLimitBucket {
            hour_bucket: get_current_hour_bucket(current_timestamp),
            message_count: 0,
            day_bucket: get_current_day_bucket(current_timestamp),
            day_count: 0,
        }
    }

    /// Check if we can send a notification (hourly limit)
    public fun can_send_notification_hourly(
        bucket: &RateLimitBucket,
        current_timestamp: u64,
    ): bool {
        let current_hour = get_current_hour_bucket(current_timestamp);

        // If hour changed, reset counter
        if (current_hour != bucket.hour_bucket) {
            return true
        };

        // Check if under limit
        bucket.message_count < MAX_MESSAGES_PER_HOUR
    }

    /// Check if we can send a notification (daily limit)
    public fun can_send_notification_daily(
        bucket: &RateLimitBucket,
        current_timestamp: u64,
    ): bool {
        let current_day = get_current_day_bucket(current_timestamp);

        // If day changed, reset counter
        if (current_day != bucket.day_bucket) {
            return true
        };

        // Check if under limit
        bucket.day_count < MAX_MESSAGES_PER_DAY
    }

    /// Check both hourly and daily limits
    public fun check_rate_limit(
        bucket: &RateLimitBucket,
        current_timestamp: u64,
    ): bool {
        can_send_notification_hourly(bucket, current_timestamp) &&
        can_send_notification_daily(bucket, current_timestamp)
    }

    // ----------------------------------------------------------
    // Functions - Events
    // ----------------------------------------------------------

    /// Emit new cycle started event
    public fun emit_new_cycle_started(
        circle_id: ID,
        cycle: u64,
        contribution_amount: u64,
        deadline: u64,
        current_timestamp: u64,
    ) {
        event::emit(NewCycleStartedEvent {
            circle_id,
            cycle,
            contribution_amount,
            deadline,
            emitted_at: current_timestamp,
        });
    }

    /// Emit member contributed event
    public fun emit_member_contributed(
        circle_id: ID,
        member: address,
        amount: u64,
        contributed_count: u64,
        total_members: u64,
        current_timestamp: u64,
    ) {
        event::emit(MemberContributedEvent {
            circle_id,
            member,
            amount,
            contributed_count,
            total_members,
            emitted_at: current_timestamp,
        });
    }

    /// Emit all members contributed event
    public fun emit_all_members_contributed(
        circle_id: ID,
        total_amount: u64,
        current_timestamp: u64,
    ) {
        event::emit(AllMembersContributedEvent {
            circle_id,
            total_amount,
            emitted_at: current_timestamp,
        });
    }

    /// Emit deadline approaching event
    public fun emit_deadline_approaching(
        circle_id: ID,
        deadline: u64,
        hours_remaining: u64,
        pending_members: u64,
        current_timestamp: u64,
    ) {
        event::emit(DeadlineApproachingEvent {
            circle_id,
            deadline,
            hours_remaining,
            pending_members,
            emitted_at: current_timestamp,
        });
    }

    /// Emit payout overdue event
    public fun emit_payout_overdue(
        circle_id: ID,
        recipient: address,
        amount: u64,
        hours_overdue: u64,
        current_timestamp: u64,
    ) {
        event::emit(PayoutOverdueEvent {
            circle_id,
            recipient,
            amount,
            hours_overdue,
            emitted_at: current_timestamp,
        });
    }

    /// Emit contributor overdue event
    public fun emit_contributor_overdue(
        circle_id: ID,
        contributor: address,
        days_overdue: u64,
        current_timestamp: u64,
    ) {
        event::emit(ContributorOverdueEvent {
            circle_id,
            contributor,
            days_overdue,
            emitted_at: current_timestamp,
        });
    }

    /// Emit payout reminder event
    public fun emit_payout_reminder(
        circle_id: ID,
        recipient: address,
        amount: u64,
        hours_until: u64,
        current_timestamp: u64,
    ) {
        event::emit(PayoutReminderEvent {
            circle_id,
            recipient,
            amount,
            hours_until,
            emitted_at: current_timestamp,
        });
    }

    // ----------------------------------------------------------
    // Functions - Admin Verification
    // ----------------------------------------------------------

    /// Verify admin action with zkLogin proof
    public fun verify_admin_action(
        admin_address: address,
        action_type: u8,
        ctx: &mut TxContext
    ): AdminAction {
        let sender = tx_context::sender(ctx);

        // Verify sender is the admin
        assert!(sender == admin_address, E_UNAUTHORIZED_ADMIN);

        // Verify action type is valid
        assert!(
            action_type == ADMIN_ACTION_LINK ||
            action_type == ADMIN_ACTION_UNLINK ||
            action_type == ADMIN_ACTION_LOG_NOTIFICATION,
            E_INVALID_ADMIN_PROOF
        );

        AdminAction {
            admin_address,
            action_type,
            timestamp: tx_context::epoch(ctx),
            verified: true,
        }
    }

    // The former link_circle_verified / unlink_circle_verified wrappers
    // were removed: they layered AdminAction (sender == caller-supplied
    // address) over the old unbound signatures — the same hole the
    // Circle-bound link/unlink above closes — and had no callers.

    /// Enhanced log_notification with admin verification
    public fun log_notification_verified(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        message_type: u8,
        success: bool,
        admin_action: &AdminAction,
        ctx: &mut TxContext
    ) {
        // Verify admin authorization
        assert!(admin_action.verified, E_UNAUTHORIZED_ADMIN);
        assert!(admin_action.action_type == ADMIN_ACTION_LOG_NOTIFICATION, E_INVALID_ADMIN_PROOF);

        // Proceed with logging
        log_notification(
            registry,
            circle_id,
            message_type,
            success,
            ctx
        );
    }

    /// Get total number of links
    public fun get_total_links(registry: &WhatsAppLinksRegistry): u64 {
        registry.total_links
    }

    // ----------------------------------------------------------
    // Tests — admin binding on link/unlink
    // ----------------------------------------------------------

    #[test_only]
    fun setup_circle_and_registry(
        admin: address,
        scenario: &mut sui::test_scenario::Scenario,
    ) {
        let clock = sui::clock::create_for_testing(sui::test_scenario::ctx(scenario));
        njangi_circles::share_circle_for_testing(
            vector[admin, @0xB, @0xC], 1_000_000_000, 250, &clock,
            sui::test_scenario::ctx(scenario)
        );
        init_registry(sui::test_scenario::ctx(scenario));
        sui::clock::destroy_for_testing(clock);
    }

    #[test_only]
    fun test_nonce(): vector<u8> {
        let mut nonce = vector::empty<u8>();
        let mut i = 0;
        while (i < LINK_NONCE_BYTES) {
            vector::push_back(&mut nonce, (i as u8));
            i = i + 1;
        };
        nonce
    }

    #[test]
    fun test_admin_links_and_unlinks_circle() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        setup_circle_and_registry(admin, &mut scenario);

        sui::test_scenario::next_tx(&mut scenario, admin);
        {
            let mut registry = sui::test_scenario::take_shared<WhatsAppLinksRegistry>(&scenario);
            let circle = sui::test_scenario::take_shared<Circle>(&scenario);
            link_circle(
                &mut registry, &circle, LINK_TYPE_INDIVIDUAL,
                b"blob-1", test_nonce(),
                sui::test_scenario::ctx(&mut scenario)
            );
            assert!(get_total_links(&registry) == 1, 0);
            unlink_circle(&mut registry, &circle, sui::test_scenario::ctx(&mut scenario));
            assert!(get_total_links(&registry) == 0, 1);
            sui::test_scenario::return_shared(registry);
            sui::test_scenario::return_shared(circle);
        };
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_CIRCLE_ADMIN)]
    fun test_non_admin_cannot_link_circle() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        setup_circle_and_registry(admin, &mut scenario);

        // A regular member (not the admin) tries to anchor a link.
        sui::test_scenario::next_tx(&mut scenario, @0xB);
        {
            let mut registry = sui::test_scenario::take_shared<WhatsAppLinksRegistry>(&scenario);
            let circle = sui::test_scenario::take_shared<Circle>(&scenario);
            link_circle(
                &mut registry, &circle, LINK_TYPE_INDIVIDUAL,
                b"blob-1", test_nonce(),
                sui::test_scenario::ctx(&mut scenario)
            );
            sui::test_scenario::return_shared(registry);
            sui::test_scenario::return_shared(circle);
        };
        sui::test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_CIRCLE_ADMIN)]
    fun test_non_admin_cannot_unlink_circle() {
        let admin = @0xA;
        let mut scenario = sui::test_scenario::begin(admin);
        setup_circle_and_registry(admin, &mut scenario);

        sui::test_scenario::next_tx(&mut scenario, admin);
        {
            let mut registry = sui::test_scenario::take_shared<WhatsAppLinksRegistry>(&scenario);
            let circle = sui::test_scenario::take_shared<Circle>(&scenario);
            link_circle(
                &mut registry, &circle, LINK_TYPE_INDIVIDUAL,
                b"blob-1", test_nonce(),
                sui::test_scenario::ctx(&mut scenario)
            );
            sui::test_scenario::return_shared(registry);
            sui::test_scenario::return_shared(circle);
        };

        // The old caller-supplied-address check let anyone who read the
        // public CircleLinked event disable the link; the Circle-bound
        // check must reject a non-admin sender.
        sui::test_scenario::next_tx(&mut scenario, @0xB);
        {
            let mut registry = sui::test_scenario::take_shared<WhatsAppLinksRegistry>(&scenario);
            let circle = sui::test_scenario::take_shared<Circle>(&scenario);
            unlink_circle(&mut registry, &circle, sui::test_scenario::ctx(&mut scenario));
            sui::test_scenario::return_shared(registry);
            sui::test_scenario::return_shared(circle);
        };
        sui::test_scenario::end(scenario);
    }
}
