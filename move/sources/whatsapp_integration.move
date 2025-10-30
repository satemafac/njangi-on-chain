module njangi::whatsapp_integration {
    use sui::object::{Self, UID, ID};
    use sui::table::{Self, Table};
    use std::vector;
    use sui::event;
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use std::string::{Self, String};
    use std::option::{Self, Option};

    // ----------------------------------------------------------
    // Error codes
    // ----------------------------------------------------------
    const E_CIRCLE_NOT_LINKED: u64 = 1;
    const E_NOT_CIRCLE_ADMIN: u64 = 2;
    const E_RATE_LIMITED: u64 = 3;
    const E_LINK_NOT_FOUND: u64 = 4;
    const E_INVALID_LINK_TYPE: u64 = 5;
    const E_ALREADY_LINKED: u64 = 6;
    const E_UNAUTHORIZED_ADMIN: u64 = 7;
    const E_INVALID_ADMIN_PROOF: u64 = 8;

    // ----------------------------------------------------------
    // Constants
    // ----------------------------------------------------------
    const LINK_TYPE_INDIVIDUAL: u8 = 1;
    const LINK_TYPE_GROUP: u8 = 2;
    
    const NOTIFICATION_NEW_CYCLE: u8 = 1;
    const NOTIFICATION_MEMBER_CONTRIBUTED: u8 = 2;
    const NOTIFICATION_ALL_CONTRIBUTED: u8 = 3;
    const NOTIFICATION_DEADLINE_APPROACHING: u8 = 4;
    const NOTIFICATION_PAYOUT_OVERDUE: u8 = 5;
    const NOTIFICATION_CONTRIBUTOR_OVERDUE: u8 = 6;
    const NOTIFICATION_PAYOUT_REMINDER: u8 = 7;

    const MAX_MESSAGES_PER_HOUR: u64 = 10;
    const MAX_MESSAGES_PER_DAY: u64 = 100;
    const SECONDS_PER_HOUR: u64 = 3600;
    const MS_PER_HOUR: u64 = 3_600_000;

    const ADMIN_ACTION_LINK: u8 = 1;
    const ADMIN_ACTION_UNLINK: u8 = 2;
    const ADMIN_ACTION_LOG_NOTIFICATION: u8 = 3;

    // ----------------------------------------------------------
    // Structs
    // ----------------------------------------------------------

    /// Individual WhatsApp link entry
    public struct WhatsAppLink has store {
        id: UID,
        circle_id: ID,
        link_type: u8,                            // 1 = individual, 2 = group
        admin_phone_number: Option<String>,       // If personal
        group_id: Option<String>,                 // If group (e.g., "group-id@g.us")
        group_name: Option<String>,
        linked_by: address,                       // Admin who linked it
        linked_at: u64,                           // Timestamp
        enabled: bool,
        last_notification_sent: u64,              // Last notification timestamp
    }

    /// Message log entry
    public struct LogEntry has store, copy, drop {
        message_type: u8,
        recipient: String,
        sent_at: u64,
        success: bool,
    }

    /// Rate limit bucket for tracking message frequency
    public struct RateLimitBucket has store {
        hour_bucket: u64,                         // Unix timestamp of hour start (in seconds)
        message_count: u64,
        day_bucket: u64,                          // Unix timestamp of day start (in seconds)
        day_count: u64,
    }

    /// Global registry of WhatsApp links
    public struct WhatsAppLinksRegistry has key {
        id: UID,
        links: vector<WhatsAppLink>,
        circle_to_link: Table<ID, u64>,          // Quick lookup: circle_id → link index
        group_to_link: Table<String, u64>,       // Quick lookup: group_id → link index
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
    // Events
    // ----------------------------------------------------------

    public struct CircleLinked has copy, drop {
        circle_id: ID,
        link_type: u8,
        admin_address: address,
        recipient: String,                        // phone or group ID
        linked_at: u64,
    }

    public struct CircleUnlinked has copy, drop {
        circle_id: ID,
        admin_address: address,
        unlinked_at: u64,
    }

    public struct NotificationSent has copy, drop {
        circle_id: ID,
        message_type: u8,
        recipient: String,
        sent_at: u64,
        success: bool,
    }

    public struct RateLimitExceeded has copy, drop {
        link_id: ID,
        circle_id: ID,
        recipient: String,
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
            group_to_link: table::new(ctx),
            total_links: 0,
        };
        transfer::share_object(registry);
    }

    // ----------------------------------------------------------
    // Functions - Linking & Unlinking
    // ----------------------------------------------------------

    /// Link a circle to WhatsApp (personal or group)
    public fun link_circle(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        link_type: u8,
        phone_or_group: String,
        admin_address: address,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        
        // Verify sender is the admin
        assert!(sender == admin_address, E_NOT_CIRCLE_ADMIN);
        
        // Validate link type
        assert!(link_type == LINK_TYPE_INDIVIDUAL || link_type == LINK_TYPE_GROUP, E_INVALID_LINK_TYPE);
        
        // Check if circle already linked
        assert!(!table::contains(&registry.circle_to_link, circle_id), E_ALREADY_LINKED);

        let new_link = WhatsAppLink {
            id: object::new(ctx),
            circle_id,
            link_type,
            admin_phone_number: if (link_type == LINK_TYPE_INDIVIDUAL) {
                option::some(phone_or_group)
            } else {
                option::none()
            },
            group_id: if (link_type == LINK_TYPE_GROUP) {
                option::some(phone_or_group)
            } else {
                option::none()
            },
            group_name: if (link_type == LINK_TYPE_GROUP) {
                option::some(phone_or_group)
            } else {
                option::none()
            },
            linked_by: sender,
            linked_at: tx_context::epoch(ctx),
            enabled: true,
            last_notification_sent: 0,
        };

        let link_index = vector::length(&registry.links);
        
        // Store in main vector
        vector::push_back(&mut registry.links, new_link);
        
        // Store in lookup tables
        if (link_type == LINK_TYPE_INDIVIDUAL) {
            table::add(&mut registry.circle_to_link, circle_id, link_index);
        } else {
            table::add(&mut registry.circle_to_link, circle_id, link_index);
            table::add(&mut registry.group_to_link, phone_or_group, link_index);
        };
        
        registry.total_links = registry.total_links + 1;

        event::emit(CircleLinked {
            circle_id,
            link_type,
            admin_address: sender,
            recipient: phone_or_group,
            linked_at: tx_context::epoch(ctx),
        });
    }

    /// Unlink a circle from WhatsApp
    public fun unlink_circle(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        admin_address: address,
        ctx: &mut TxContext
    ) {
        // Find link by circle_id
        assert!(table::contains(&registry.circle_to_link, circle_id), E_LINK_NOT_FOUND);
        
        let link_index = *table::borrow(&registry.circle_to_link, circle_id);
        let link = vector::borrow_mut(&mut registry.links, link_index);
        
        // Verify admin
        assert!(link.linked_by == admin_address, E_NOT_CIRCLE_ADMIN);
        
        // Disable the link
        link.enabled = false;

        event::emit(CircleUnlinked {
            circle_id,
            admin_address,
            unlinked_at: tx_context::epoch(ctx),
        });
    }

    // ----------------------------------------------------------
    // Functions - Querying Links
    // ----------------------------------------------------------

    /// Get recipient for a circle (phone or group)
    public fun get_recipient(
        registry: &WhatsAppLinksRegistry,
        circle_id: ID,
    ): Option<String> {
        if (table::contains(&registry.circle_to_link, circle_id)) {
            let link_index = *table::borrow(&registry.circle_to_link, circle_id);
            let link = vector::borrow(&registry.links, link_index);
            
            if (!link.enabled) {
                return option::none()
            };
            
            if (link.link_type == LINK_TYPE_INDIVIDUAL) {
                link.admin_phone_number
            } else {
                link.group_id
            }
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

    /// Record a notification was sent
    public fun log_notification(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        message_type: u8,
        recipient: String,
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

        // Emit event
        event::emit(NotificationSent {
            circle_id,
            message_type,
            recipient,
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

    /// Enhanced link_circle with admin verification
    public fun link_circle_verified(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        link_type: u8,
        phone_or_group: String,
        admin_action: &AdminAction,
        ctx: &mut TxContext
    ) {
        // Verify admin authorization
        assert!(admin_action.verified, E_UNAUTHORIZED_ADMIN);
        assert!(admin_action.action_type == ADMIN_ACTION_LINK, E_INVALID_ADMIN_PROOF);
        
        // Proceed with linking
        link_circle(
            registry,
            circle_id,
            link_type,
            phone_or_group,
            admin_action.admin_address,
            ctx
        );
    }

    /// Enhanced unlink_circle with admin verification
    public fun unlink_circle_verified(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        admin_action: &AdminAction,
        ctx: &mut TxContext
    ) {
        // Verify admin authorization
        assert!(admin_action.verified, E_UNAUTHORIZED_ADMIN);
        assert!(admin_action.action_type == ADMIN_ACTION_UNLINK, E_INVALID_ADMIN_PROOF);
        
        // Proceed with unlinking
        unlink_circle(
            registry,
            circle_id,
            admin_action.admin_address,
            ctx
        );
    }

    /// Enhanced log_notification with admin verification
    public fun log_notification_verified(
        registry: &mut WhatsAppLinksRegistry,
        circle_id: ID,
        message_type: u8,
        recipient: String,
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
            recipient,
            success,
            ctx
        );
    }

    /// Get total number of links
    public fun get_total_links(registry: &WhatsAppLinksRegistry): u64 {
        registry.total_links
    }
}
