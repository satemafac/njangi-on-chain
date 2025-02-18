#[test_only]
module njangi::njangi_circle_tests {
    use sui::test_scenario::{Self as test, Scenario, next_tx, ctx};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::test_utils::assert_eq;
    use njangi::njangi_circle::{Self, Circle};
    
    // Test constants
    const ADMIN: address = @0xA1;
    const MEMBER1: address = @0xB1;
    const MEMBER2: address = @0xB2;
    
    // Test helper to set up a basic test scenario with a clock
    fun setup_test(): (Scenario, Clock) {
        let mut scenario = test::begin(ADMIN);
        let clock = clock::create_for_testing(ctx(&mut scenario));
        (scenario, clock)
    }

    #[test]
    fun test_create_circle() {
        let (mut scenario, clock) = setup_test();
        
        // Start admin transaction
        next_tx(&mut scenario, ADMIN);
        {
            // Create circle parameters
            let name = b"Test Circle";
            let contribution_amount = 100; // 100 SUI
            let security_deposit = 50;  // 50 SUI
            let cycle_length = 0;       // Weekly
            let cycle_day = 1;          // Monday
            let circle_type = 0;        // Regular
            let max_members = 5;
            let rotation_style = 0;
            let penalty_rules = vector[true, true]; // Enable both penalty types
            let goal_type = std::option::none();
            let target_amount = std::option::none();
            let target_date = std::option::none();
            let verification_required = false;

            // Create the circle
            njangi_circle::create_circle(
                name,
                contribution_amount,
                security_deposit,
                cycle_length,
                cycle_day,
                circle_type,
                max_members,
                rotation_style,
                penalty_rules,
                goal_type,
                target_amount,
                target_date,
                verification_required,
                &clock,
                ctx(&mut scenario)
            );
        };

        // Clean up
        clock::destroy_for_testing(clock);
        test::end(scenario);
    }

    #[test]
    fun test_join_circle() {
        let (mut scenario, clock) = setup_test();
        
        // First create the circle
        next_tx(&mut scenario, ADMIN);
        {
            njangi_circle::create_circle(
                b"Test Circle",
                100,
                50,
                0,
                1,
                0,
                5,
                0,
                vector[true, true],
                std::option::none(),
                std::option::none(),
                std::option::none(),
                false,
                &clock,
                ctx(&mut scenario)
            );
        };

        // Now test joining as MEMBER1
        next_tx(&mut scenario, MEMBER1);
        {
            let mut circle = test::take_shared<Circle>(&scenario);
            let deposit_coin = coin::mint_for_testing<SUI>(50_000_000_000, ctx(&mut scenario)); // 50 SUI with 9 decimals
            
            njangi_circle::join_circle(
                &mut circle,
                deposit_coin,
                std::option::none(),
                &clock,
                ctx(&mut scenario)
            );

            test::return_shared(circle);
        };

        // Clean up
        clock::destroy_for_testing(clock);
        test::end(scenario);
    }
} 