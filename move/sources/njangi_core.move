module njangi::njangi_core {
    use sui::object;
    use sui::tx_context;
    use sui::clock;
    use std::string::String;
    use std::option::{Self, Option};
    
    // ----------------------------------------------------------
    // Constants and Error codes
    // ----------------------------------------------------------
    const MIN_MEMBERS: u64 = 3;
    const MAX_MEMBERS: u64 = 20;
    
    // SUI specific constants
    const DECIMAL_SCALING: u64 = 1_000_000_000; // 10^9 for SUI decimals
    public fun decimal_scaling(): u64 { DECIMAL_SCALING }
    
    // Error constants (common to multiple modules)
    const EInvalidMemberCount: u64 = 0;
    const EInvalidContributionAmount: u64 = 1;
    const EInvalidSecurityDeposit: u64 = 2;
    const EInvalidCycleLength: u64 = 3;
    const EInvalidCycleDay: u64 = 4;
    const ECircleFull: u64 = 5;
    const EInsufficientDeposit: u64 = 6;
    const ENotAdmin: u64 = 7;
    const ENotMember: u64 = 8;
    const EInsufficientBalance: u64 = 12;
    const ENO_SECURITY_DEPOSIT: u64 = 21;
    const EMINIMUM_MEMBERS_REQUIRED: u64 = 22;
    
    // Time constants (all in milliseconds)
    const MS_PER_DAY: u64 = 86_400_000;       // 24 * 60 * 60 * 1000
    const MS_PER_WEEK: u64 = 604_800_000;     // 7  * 24 * 60 * 60 * 1000
    const MS_PER_MONTH: u64 = 2_419_200_000;   // 28 * 24 * 60 * 60 * 1000
    public fun ms_per_day(): u64 { MS_PER_DAY }
    public fun ms_per_week(): u64 { MS_PER_WEEK }
    public fun ms_per_month(): u64 { MS_PER_MONTH }

    // Day constants (as u64 for consistent % operations)
    const DAYS_IN_WEEK: u64 = 7;
    const DAYS_IN_MONTH: u64 = 28;
    public fun days_in_week(): u64 { DAYS_IN_WEEK }
    public fun days_in_month(): u64 { DAYS_IN_MONTH }
    
    // Member status constants
    const MEMBER_STATUS_ACTIVE: u8 = 0;
    const MEMBER_STATUS_PENDING: u8 = 1;  // New status for members who joined without deposit
    const MEMBER_STATUS_SUSPENDED: u8 = 2;
    const MEMBER_STATUS_EXITED: u8 = 3;
    public fun member_status_active(): u8 { MEMBER_STATUS_ACTIVE }
    public fun member_status_pending(): u8 { MEMBER_STATUS_PENDING }
    public fun member_status_suspended(): u8 { MEMBER_STATUS_SUSPENDED }
    public fun member_status_exited(): u8 { MEMBER_STATUS_EXITED }

    // Milestone type constants
    const MILESTONE_TYPE_MONETARY: u8 = 0;
    const MILESTONE_TYPE_TIME: u8 = 1;
    public fun milestone_type_monetary(): u8 { MILESTONE_TYPE_MONETARY }
    public fun milestone_type_time(): u8 { MILESTONE_TYPE_TIME }
    
    // Custody operation types
    const CUSTODY_OP_DEPOSIT: u8 = 0;
    const CUSTODY_OP_WITHDRAWAL: u8 = 1;
    const CUSTODY_OP_PAYOUT: u8 = 2;
    const CUSTODY_OP_STABLECOIN_DEPOSIT: u8 = 3;
    public fun custody_op_deposit(): u8 { CUSTODY_OP_DEPOSIT }
    public fun custody_op_withdrawal(): u8 { CUSTODY_OP_WITHDRAWAL }
    public fun custody_op_payout(): u8 { CUSTODY_OP_PAYOUT }
    public fun custody_op_stablecoin_deposit(): u8 { CUSTODY_OP_STABLECOIN_DEPOSIT }

    // ----------------------------------------------------------
    // Helper functions to handle SUI decimal scaling
    // ----------------------------------------------------------
    public fun to_decimals(amount: u64): u64 {
        // We'll use a safer approach to handle very large amounts
        // DECIMAL_SCALING is 10^9 (1_000_000_000)
        // Max u64 is 18,446,744,073,709,551,615
        // So the safe limit for multiplication is 18,446,744,073 (without scaling)
        
        // Check if amount is too large to multiply safely
        if (amount > 18_446_744_073) {
            // If we have a huge amount, we'll return the max safe scaled value
            // This prevents runtime errors while still allowing very large values
            18_446_744_073_000_000_000 // Max safe value with 9 decimals
        } else {
            amount * DECIMAL_SCALING
        }
    }

    public fun from_decimals(amount: u64): u64 {
        amount / DECIMAL_SCALING
    }
    
    // ----------------------------------------------------------
    // Time/Date Helper Functions
    // ----------------------------------------------------------
    
    // Convert timestamp to (year, month, day) tuple
    #[allow(unused_assignment)]
    public fun timestamp_to_date(timestamp: u64): (u64, u64, u64) {
        // Start with Unix epoch: January 1, 1970
        let mut total_days = timestamp / MS_PER_DAY;
        
        // Initial values
        let mut year = 1970;
        let mut month = 1;
        let mut day = 1; // This is used at the end, so keep it
        
        // Calculate year
        while (true) {
            let days_in_year = if (is_leap_year(year)) { 366 } else { 365 };
            if (total_days >= days_in_year) {
                total_days = total_days - days_in_year;
                year = year + 1;
            } else {
                break
            }
        };
        
        // Calculate month
        let mut month_days = vector[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (is_leap_year(year)) {
            // Update February for leap year
            let feb_days = vector::borrow_mut(&mut month_days, 1);
            *feb_days = 29;
        };
        
        while (month <= 12) {
            let days_in_month = *vector::borrow(&month_days, month - 1);
            if (total_days >= days_in_month) {
                total_days = total_days - days_in_month;
                month = month + 1;
            } else {
                break
            }
        };
        
        // Calculate day (1-based)
        day = total_days + 1;
        
        (year, month, day)
    }

    // Convert (year, month, day) to timestamp
    public fun date_to_timestamp(year: u64, month: u64, day: u64): u64 {
        // Calculate days since epoch (Jan 1, 1970)
        let mut days: u64 = 0;
        
        // Add days for years
        let mut y = 1970;
        while (y < year) {
            days = days + if (is_leap_year(y)) { 366 } else { 365 };
            y = y + 1;
        };
        
        // Add days for months
        let mut month_days = vector[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (is_leap_year(year)) {
            // Update February for leap year
            let feb_days = vector::borrow_mut(&mut month_days, 1);
            *feb_days = 29;
        };
        
        let mut m = 1;
        while (m < month) {
            days = days + *vector::borrow(&month_days, m - 1);
            m = m + 1;
        };
        
        // Add days of current month
        days = days + (day - 1);
        
        // Convert to milliseconds
        days * MS_PER_DAY
    }

    // Check if a year is a leap year
    public fun is_leap_year(year: u64): bool {
        if (year % 400 == 0) {
            true
        } else if (year % 100 == 0) {
            false
        } else {
            year % 4 == 0
        }
    }

    public fun get_day_ms(timestamp: u64): u64 {
        timestamp % MS_PER_DAY
    }

    public fun get_weekday(timestamp: u64): u64 {
        // Align Monday = 0, Sunday = 6
        // Jan 1, 1970 was a Thursday (3)
        ((timestamp / MS_PER_DAY + 3) % 7)
    }

    public fun get_day_of_month(timestamp: u64): u64 {
        let (_, _, day) = timestamp_to_date(timestamp);
        day
    }

    public fun get_day_of_quarter(timestamp: u64): u64 {
        let (year, month, day) = timestamp_to_date(timestamp);
        
        // Calculate first month of the quarter
        let quarter_start_month = ((month - 1) / 3) * 3 + 1;
        
        // Calculate days since start of quarter
        let mut days_since_quarter_start = 0;
        
        // Add days for full months
        let mut month_days = vector[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (is_leap_year(year)) {
            // Update February for leap year
            let feb_days = vector::borrow_mut(&mut month_days, 1);
            *feb_days = 29;
        };
        
        let mut m = quarter_start_month;
        while (m < month) {
            days_since_quarter_start = days_since_quarter_start + *vector::borrow(&month_days, m - 1);
            m = m + 1;
        };
        
        // Add days in current month
        days_since_quarter_start = days_since_quarter_start + day;
        
        days_since_quarter_start
    }

    public fun is_valid_cycle_day(cycle_length: u64, cycle_day: u64): bool {
        if (cycle_length == 0) {
            // weekly
            cycle_day < DAYS_IN_WEEK
        } else if (cycle_length == 1) {
            // monthly
            cycle_day > 0 && cycle_day <= DAYS_IN_MONTH
        } else {
            // quarterly
            cycle_day > 0 && cycle_day <= DAYS_IN_MONTH
        }
    }
    
    // ----------------------------------------------------------
    // Calculate next payout time based on cycle
    // ----------------------------------------------------------
    public fun calculate_next_payout_time(cycle_length: u64, cycle_day: u64, current_time: u64): u64 {
        // Extract year, month, day from the timestamp
        let (year, month, day) = timestamp_to_date(current_time);
        let day_ms = get_day_ms(current_time);
        
        if (cycle_length == 0) {
            // Weekly payouts - handle future tense
            let weekday = get_weekday(current_time);
            let days_until = if (cycle_day > weekday) {
                // Selected day is later this week
                (cycle_day - weekday) as u64
            } else if (cycle_day < weekday || (cycle_day == weekday && day_ms > 0)) {
                // Selected day is earlier than today, so schedule for next week
                (DAYS_IN_WEEK - weekday + cycle_day) as u64
            } else {
                // Selected day is today with no time elapsed
                0
            };
            
            if (days_until == 0 && day_ms > 0) {
                // We're on the selected day but with time elapsed, so schedule for next week
                current_time + (MS_PER_WEEK - day_ms)
            } else {
                // Schedule for the selected day this week (if it's in the future)
                // or next week (if it's in the past)
                current_time + (days_until * MS_PER_DAY) - day_ms
            }
        } else if (cycle_length == 1) {
            // Monthly payouts - always set future date
            let mut next_month = month;
            let mut next_year = year;
            
            // If today's date is greater than the selected day, move to next month
            // This ensures we get the next occurrence of the day
            if (day > cycle_day || (day == cycle_day && day_ms > 0)) {
                next_month = month + 1;
                if (next_month > 12) {
                    next_month = 1;
                    next_year = year + 1;
                };
            };
            
            // We know cycle_day is always ≤ 28 and all months have at least 28 days
            // So we don't need to check month length anymore
            
            // Get timestamp for the target day of next month/current month (always in the future)
            date_to_timestamp(next_year, next_month, cycle_day)
        } else {
            // Quarterly payouts - always set future date
            let mut next_month = month;
            let mut next_year = year;
            
            // If today's date is greater than the selected day, move to next quarter
            if (day > cycle_day || (day == cycle_day && day_ms > 0)) {
                next_month = month + 3;
                if (next_month > 12) {
                    next_month = next_month - 12;
                    next_year = year + 1;
                };
            };
            
            // We know cycle_day is always ≤ 28 and all months have at least 28 days
            // So we don't need to check month length anymore
            
            // Get timestamp for the target day of next quarter's month (always in the future)
            date_to_timestamp(next_year, next_month, cycle_day)
        }
    }

    // ----------------------------------------------------------
    // Defines USD amounts in cents (e.g., $10.50 = 1050)
    // ----------------------------------------------------------
    public struct UsdAmounts has store, drop {
        contribution_amount: u64, 
        security_deposit: u64,
        target_amount: option::Option<u64>
    }
    
    // ----------------------------------------------------------
    // Helper functions for module visibility
    // ----------------------------------------------------------
    public fun assert_admin(sender: address, admin: address) {
        assert!(sender == admin, ENotAdmin);
    }
    
    public fun get_min_members(): u64 {
        MIN_MEMBERS
    }
    
    public fun get_max_members(): u64 {
        MAX_MEMBERS
    }
    
    // Get the minimum safe security deposit
    public fun min_security_deposit(contribution_amount: u64): u64 {
        contribution_amount / 2
    }
    
    // Helper to get sample addresses for testing
    public fun get_sample_addresses(): vector<address> {
        let mut addrs = vector::empty<address>();
        
        // In a real implementation, we would need a better approach
        // This is a simplified mock for demonstration purposes
        vector::push_back(&mut addrs, @0x1);
        
        addrs
    }

    // Create UsdAmounts constructor
    public fun create_usd_amounts(
        contribution_amount: u64,
        security_deposit: u64,
        target_amount: option::Option<u64>
    ): UsdAmounts {
        UsdAmounts {
            contribution_amount,
            security_deposit,
            target_amount
        }
    }

    // Getters for UsdAmounts fields
    public fun get_usd_contribution_amount(usd_amounts: &UsdAmounts): u64 {
        usd_amounts.contribution_amount
    }

    public fun get_usd_security_deposit(usd_amounts: &UsdAmounts): u64 {
        usd_amounts.security_deposit
    }

    public fun get_usd_target_amount(usd_amounts: &UsdAmounts): option::Option<u64> {
        usd_amounts.target_amount
    }

    // ----------------------------------------------------------
    // Stablecoin utility functions
    // ----------------------------------------------------------

    // Convert between different coin decimal precisions
    // For example, to convert an amount from USDC (6 decimals) to SUI decimal scale (9 decimals)
    // call adjust_decimals(usdc_amount, 6, 9)
    public fun adjust_decimals(amount: u64, from_decimals: u8, to_decimals: u8): u64 {
        if (from_decimals == to_decimals) {
            return amount
        };
        
        if (from_decimals < to_decimals) {
            // Scale up (e.g. USDC 6 decimals to SUI 9 decimals)
            let mut scale_factor = 1u64;
            let diff = (to_decimals - from_decimals) as u64;
            let mut i = 0u64;
            while (i < diff) {
                scale_factor = scale_factor * 10;
                i = i + 1;
            };
            amount * scale_factor
        } else {
            // Scale down (e.g. SUI 9 decimals to USDC 6 decimals)
            // Note: This can lose precision if not an exact multiple
            let mut scale_factor = 1u64;
            let diff = (from_decimals - to_decimals) as u64;
            let mut i = 0u64;
            while (i < diff) {
                scale_factor = scale_factor * 10;
                i = i + 1;
            };
            amount / scale_factor
        }
    }

    // Standard stablecoin decimals
    public fun usdc_decimals(): u8 { 6 }
    public fun sui_decimals(): u8 { 9 }
} 