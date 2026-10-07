// v11 lifecycle tests: pinned asset terms, per-member deposit records in
// the circle's custody wallet, per-asset refunds, conversion of pre-v11
// circles, the round guard, and the custody posture (no privileged key can
// move a member's deposit).
//
// Test-only helpers (`legacy_deposit_for_testing`,
// `open_round_as_pre_v11_for_testing`, the recovery-state setters) build
// circles in the shapes that exist on chain from before v11: legacy
// storage and legacy per-member fields, rounds opened before a circle's
// terms were pinned, recoveries recorded by the pre-v11 path.
#[test_only]
module njangi::njangi_v11_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;

    use njangi::njangi_circles::{Self as circles, Circle};
    use njangi::njangi_custody::{Self as custody, CustodyWallet};
    use njangi::njangi_cycle_escrow::{Self as escrow, CycleEscrow};
    use njangi::njangi_price_validator::{Self as pv, AssetRegistry};
    use njangi::njangi_payments as payments;
    use njangi::njangi_core as core;
    use njangi::njangi_members as members;

    // 6-decimal USD-pegged test coin and an unregistered-role coin.
    public struct TESTUSDC has drop {}
    public struct JUNK has drop {}

    const OPERATOR: address = @0x0FE;     // registry admin + UpgradeCap holder
    const NEW_OPERATOR: address = @0x0FF;
    const ADMIN: address = @0xA11CE;      // circle admin (rotation seat 0)
    const BOB: address = @0xB0B;
    const CAROL: address = @0xCA801;
    const DAVE: address = @0xDA4E;
    const STRANGER: address = @0x5A5A;

    const START_MS: u64 = 1_000_000;
    const WEEK_MS: u64 = 604_800_000;

    // Stablecoin circle: $10.00 rounds, $5.00 deposits.
    const USD_CONTRIB_CENTS: u64 = 1_000;
    const USD_DEPOSIT_CENTS: u64 = 500;
    const USDC_CONTRIB: u64 = 10_000_000;
    const USDC_DEPOSIT: u64 = 5_000_000;
    // SUI circle: 2 SUI rounds, 1 SUI deposits.
    const SUI_CONTRIB: u64 = 2_000_000_000;
    const SUI_DEPOSIT: u64 = 1_000_000_000;

    const FLAGS_STABLE: u64 = 7; // settlement | deposit | usd-pegged
    const FLAGS_SUI: u64 = 3;    // settlement | deposit

    // ==========================================================
    // helpers
    // ==========================================================

    fun start(): (Scenario, Clock) {
        let mut scenario = ts::begin(OPERATOR);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, START_MS);
        (scenario, clock)
    }

    fun finish(scenario: Scenario, clock: Clock) {
        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    fun new_registry(scenario: &mut Scenario, bless: bool) {
        ts::next_tx(scenario, OPERATOR);
        pv::init_registry_for_testing(ts::ctx(scenario));
        ts::next_tx(scenario, OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(scenario);
        if (bless) {
            let cap = sui::package::test_publish(object::id_from_address(@njangi), ts::ctx(scenario));
            pv::bless_canonical(&mut registry, &cap, ts::ctx(scenario));
            transfer::public_transfer(cap, OPERATOR);
        };
        pv::set_asset_flags(&mut registry, core::coin_type_bytes<SUI>(), FLAGS_SUI, ts::ctx(scenario));
        pv::register_asset_for_testing<TESTUSDC>(&mut registry, 6, FLAGS_STABLE, ts::ctx(scenario));
        pv::register_asset_for_testing<JUNK>(&mut registry, 6, 0, ts::ctx(scenario));
        ts::return_shared(registry);
    }

    fun setup_registry(scenario: &mut Scenario) {
        new_registry(scenario, true);
    }

    fun create_circle_as<T>(
        scenario: &mut Scenario,
        contribution_native: u64,
        deposit_native: u64,
        clock: &Clock
    ) {
        ts::next_tx(scenario, ADMIN);
        let registry = ts::take_shared<AssetRegistry>(scenario);
        circles::create_circle_with_asset<T>(
            b"v11 circle",
            b"USD",
            USD_CONTRIB_CENTS,
            USD_CONTRIB_CENTS,
            USD_DEPOSIT_CENTS,
            USD_DEPOSIT_CENTS,
            contribution_native,
            deposit_native,
            0,                      // weekly
            0,                      // weekday 0
            0,                      // circle_type
            5,                      // max_members
            0,                      // rotation_style
            vector[false, false],
            option::none(),
            option::none(),
            option::none(),
            option::none(),
            false,
            false,
            0,
            option::none(),
            &registry,
            clock,
            ts::ctx(scenario)
        );
        ts::return_shared(registry);
    }

    fun create_usdc_circle(scenario: &mut Scenario, clock: &Clock) {
        create_circle_as<TESTUSDC>(scenario, USDC_CONTRIB, USDC_DEPOSIT, clock);
    }

    fun seat_bob_and_carol(scenario: &mut Scenario, clock: &Clock) {
        ts::next_tx(scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(scenario);
        circles::admin_approve_members(&mut circle, vector[BOB, CAROL], clock, ts::ctx(scenario));
        circles::set_rotation_position(&mut circle, BOB, 1, clock, ts::ctx(scenario));
        circles::set_rotation_position(&mut circle, CAROL, 2, clock, ts::ctx(scenario));
        ts::return_shared(circle);
    }

    fun post_as<T>(scenario: &mut Scenario, who: address, amount: u64, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(scenario);
        let registry = ts::take_shared<AssetRegistry>(scenario);
        let deposit = coin::mint_for_testing<T>(amount, ts::ctx(scenario));
        circles::post_security_deposit<T>(&mut circle, &mut wallet, &registry, deposit, clock, ts::ctx(scenario));
        ts::return_shared(registry);
        ts::return_shared(wallet);
        ts::return_shared(circle);
    }

    fun activate(scenario: &mut Scenario, clock: &Clock) {
        ts::next_tx(scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(scenario);
        circles::activate_circle(&mut circle, clock, ts::ctx(scenario));
        ts::return_shared(circle);
    }

    /// Canonical registry, a stablecoin circle with ADMIN/BOB/CAROL seated,
    /// every deposit posted, and the circle started.
    fun active_usdc_circle(scenario: &mut Scenario, clock: &Clock) {
        setup_registry(scenario);
        create_usdc_circle(scenario, clock);
        seat_bob_and_carol(scenario, clock);
        post_as<TESTUSDC>(scenario, ADMIN, USDC_DEPOSIT, clock);
        post_as<TESTUSDC>(scenario, BOB, USDC_DEPOSIT, clock);
        post_as<TESTUSDC>(scenario, CAROL, USDC_DEPOSIT, clock);
        activate(scenario, clock);
    }

    fun open_round_as<T>(scenario: &mut Scenario, who: address, clock: &Clock): ID {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let registry = ts::take_shared<AssetRegistry>(scenario);
        escrow::open_round<T>(&mut circle, &registry, clock, ts::ctx(scenario));
        ts::return_shared(registry);
        ts::return_shared(circle);
        ts::next_tx(scenario, who);
        option::destroy_some(ts::most_recent_id_shared<CycleEscrow<T>>())
    }

    fun contribute_round_as<T>(
        scenario: &mut Scenario,
        who: address,
        escrow_id: ID,
        amount: u64,
        clock: &Clock
    ) {
        ts::next_tx(scenario, who);
        let circle = ts::take_shared<Circle>(scenario);
        let mut round = ts::take_shared_by_id<CycleEscrow<T>>(scenario, escrow_id);
        let payment = coin::mint_for_testing<T>(amount, ts::ctx(scenario));
        escrow::contribute_round<T>(&circle, &mut round, payment, clock, ts::ctx(scenario));
        ts::return_shared(round);
        ts::return_shared(circle);
    }

    fun collect_and_advance<T>(scenario: &mut Scenario, recipient: address, escrow_id: ID, clock: &Clock) {
        ts::next_tx(scenario, recipient);
        let mut round = ts::take_shared_by_id<CycleEscrow<T>>(scenario, escrow_id);
        escrow::finalize_and_redeem<T>(&mut round, clock, ts::ctx(scenario));
        ts::return_shared(round);
        ts::next_tx(scenario, recipient);
        let mut circle = ts::take_shared<Circle>(scenario);
        let round = ts::take_shared_by_id<CycleEscrow<T>>(scenario, escrow_id);
        escrow::advance_circle_after_claim<T>(&mut circle, &round, clock, ts::ctx(scenario));
        ts::return_shared(round);
        ts::return_shared(circle);
    }

    fun assert_received<T>(scenario: &mut Scenario, who: address, amount: u64, code: u64) {
        ts::next_tx(scenario, who);
        let received = ts::take_from_address<Coin<T>>(scenario, who);
        assert!(coin::value(&received) == amount, code);
        coin::burn_for_testing(received);
    }

    fun assert_received_nothing<T>(scenario: &mut Scenario, who: address, code: u64) {
        ts::next_tx(scenario, who);
        assert!(!ts::has_most_recent_for_address<Coin<T>>(who), code);
    }

    fun vote_yes(scenario: &mut Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        circles::vote_emergency_stop(&mut circle, true, clock, ts::ctx(scenario));
        ts::return_shared(circle);
    }

    fun pass_stop_vote(scenario: &mut Scenario, clock: &Clock) {
        ts::next_tx(scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(scenario);
        circles::propose_emergency_stop(&mut circle, clock, ts::ctx(scenario));
        ts::return_shared(circle);
        vote_yes(scenario, BOB, clock);
        vote_yes(scenario, CAROL, clock);
    }

    fun stop_as(scenario: &mut Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        circles::stop_for_recovery(&mut circle, clock, ts::ctx(scenario));
        ts::return_shared(circle);
    }

    fun refund_asset_as<T>(scenario: &mut Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(scenario);
        circles::refund_asset<T>(&mut circle, &mut wallet, clock, ts::ctx(scenario));
        ts::return_shared(wallet);
        ts::return_shared(circle);
    }

    /// A circle as an earlier package version leaves it: active, stablecoin
    /// mode, no pinned terms, its custody wallet created by the admin in the
    /// same transaction (same creation timestamp). Returns (circle, wallet).
    fun legacy_circle(scenario: &mut Scenario, clock: &Clock): (ID, ID) {
        ts::next_tx(scenario, ADMIN);
        let circle_id = circles::share_circle_for_testing(
            vector[ADMIN, BOB, CAROL],
            SUI_CONTRIB,
            USD_CONTRIB_CENTS,
            clock,
            ts::ctx(scenario)
        );
        let wallet_id = custody::create_custody_wallet_returning_id(
            circle_id,
            clock::timestamp_ms(clock),
            ts::ctx(scenario)
        );
        (circle_id, wallet_id)
    }

    fun legacy_deposit_as<T>(scenario: &mut Scenario, who: address, amount: u64, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(scenario);
        let deposit = coin::mint_for_testing<T>(amount, ts::ctx(scenario));
        circles::legacy_deposit_for_testing<T>(&mut circle, &mut wallet, deposit, clock, ts::ctx(scenario));
        ts::return_shared(wallet);
        ts::return_shared(circle);
    }

    fun adopt_as<T>(scenario: &mut Scenario, who: address, wallet_id: ID, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        let mut wallet = ts::take_shared_by_id<CustodyWallet>(scenario, wallet_id);
        let registry = ts::take_shared<AssetRegistry>(scenario);
        circles::adopt_asset_policy<T>(&mut circle, &mut wallet, &registry, clock, ts::ctx(scenario));
        ts::return_shared(registry);
        ts::return_shared(wallet);
        ts::return_shared(circle);
    }

    fun legacy_usdc_circle_with_deposits(scenario: &mut Scenario, clock: &Clock): ID {
        setup_registry(scenario);
        let (_circle_id, wallet_id) = legacy_circle(scenario, clock);
        legacy_deposit_as<TESTUSDC>(scenario, ADMIN, USDC_DEPOSIT, clock);
        legacy_deposit_as<TESTUSDC>(scenario, BOB, USDC_DEPOSIT, clock);
        legacy_deposit_as<TESTUSDC>(scenario, CAROL, USDC_DEPOSIT, clock);
        wallet_id
    }

    // ==========================================================
    // AssetRegistry: canonical blessing, roles, admin handover
    // ==========================================================

    #[test]
    #[expected_failure(abort_code = 306, location = njangi::njangi_price_validator)]
    fun test_bless_rejects_a_foreign_upgrade_cap() {
        let (mut scenario, clock) = start();
        ts::next_tx(&mut scenario, OPERATOR);
        pv::init_registry_for_testing(ts::ctx(&mut scenario));
        ts::next_tx(&mut scenario, STRANGER);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        let foreign = sui::package::test_publish(object::id_from_address(@0x42), ts::ctx(&mut scenario));
        pv::bless_canonical(&mut registry, &foreign, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_bless_marks_registry_canonical() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        ts::next_tx(&mut scenario, OPERATOR);
        let registry = ts::take_shared<AssetRegistry>(&scenario);
        assert!(pv::is_canonical(&registry), 1);
        assert!(pv::asset_flags(&registry, core::coin_type_bytes<TESTUSDC>()) == FLAGS_STABLE, 2);
        assert!(pv::asset_flags(&registry, core::coin_type_bytes<SUI>()) == FLAGS_SUI, 3);
        assert!(pv::asset_flags(&registry, core::coin_type_bytes<JUNK>()) == 0, 4);
        assert!(pv::is_usd_pegged<TESTUSDC>(&registry) && !pv::is_usd_pegged<SUI>(&registry), 5);
        ts::return_shared(registry);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 109, location = njangi::njangi_price_validator)]
    fun test_create_requires_the_canonical_registry() {
        let (mut scenario, clock) = start();
        new_registry(&mut scenario, false);
        create_usdc_circle(&mut scenario, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 110, location = njangi::njangi_price_validator)]
    fun test_create_requires_the_settlement_role() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_circle_as<JUNK>(&mut scenario, USDC_CONTRIB, USDC_DEPOSIT, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 105, location = njangi::njangi_price_validator)]
    fun test_disabled_asset_takes_no_new_circle() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        ts::next_tx(&mut scenario, OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::set_asset_enabled(&mut registry, core::coin_type_bytes<TESTUSDC>(), false, ts::ctx(&mut scenario));
        ts::return_shared(registry);
        create_usdc_circle(&mut scenario, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 106, location = njangi::njangi_price_validator)]
    fun test_asset_flags_are_registry_admin_only() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        ts::next_tx(&mut scenario, STRANGER);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::set_asset_flags(&mut registry, core::coin_type_bytes<JUNK>(), FLAGS_STABLE, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 111, location = njangi::njangi_price_validator)]
    fun test_asset_flags_reject_unknown_bits() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        ts::next_tx(&mut scenario, OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::set_asset_flags(&mut registry, core::coin_type_bytes<JUNK>(), 8, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 107, location = njangi::njangi_price_validator)]
    fun test_asset_registers_once() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        ts::next_tx(&mut scenario, OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::register_asset_for_testing<TESTUSDC>(&mut registry, 6, FLAGS_STABLE, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_registry_admin_handover() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        ts::next_tx(&mut scenario, OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::transfer_registry_admin(&mut registry, NEW_OPERATOR, ts::ctx(&mut scenario));
        assert!(pv::registry_admin(&registry) == NEW_OPERATOR, 1);
        ts::return_shared(registry);

        ts::next_tx(&mut scenario, NEW_OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::set_asset_flags(&mut registry, core::coin_type_bytes<JUNK>(), 2, ts::ctx(&mut scenario));
        assert!(pv::asset_flags(&registry, core::coin_type_bytes<JUNK>()) == 2, 2);
        ts::return_shared(registry);
        finish(scenario, clock);
    }

    // ==========================================================
    // Creating a circle with pinned terms
    // ==========================================================

    #[test]
    fun test_create_stablecoin_circle_pins_terms_and_binds_its_wallet() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);

        ts::next_tx(&mut scenario, ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::is_converted(&circle), 1);
        let policy = option::destroy_some(circles::asset_policy(&circle));
        assert!(circles::policy_settlement_asset(&policy) == core::coin_type_bytes<TESTUSDC>(), 2);
        let terms = circles::policy_settlement_terms(&policy);
        assert!(circles::terms_decimals(&terms) == 6, 3);
        assert!(circles::terms_contribution_amount(&terms) == USDC_CONTRIB, 4);
        assert!(circles::terms_security_deposit(&terms) == USDC_DEPOSIT, 5);
        assert!(circles::policy_set_at_ms(&policy) == START_MS, 6);
        assert!(circles::bound_wallet_id(&circle) == option::some(object::id(&wallet)), 7);
        assert!(circles::get_wallet_id(&circle) == option::some(object::id(&wallet)), 8);
        assert!(circles::legacy_migrated_entries(&circle) == option::some(0), 9);
        // Readers that predate the policy see stablecoin mode and no SUI terms.
        assert!(!circles::is_auto_swap_enabled(&circle), 10);
        assert!(circles::get_contribution_amount_raw(&circle) == 0, 11);
        // The asset's legacy coin slot is closed from the start, and holds nothing.
        assert!(custody::is_legacy_slot_migrated<TESTUSDC>(&wallet), 12);
        assert!(!custody::has_any_stablecoin_balance(&wallet), 13);
        assert!(custody::get_wallet_balance(&wallet) == 0, 14);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    fun test_create_sui_circle_keeps_config_equal_to_terms() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_circle_as<SUI>(&mut scenario, SUI_CONTRIB, SUI_DEPOSIT, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let terms = circles::policy_settlement_terms(&option::destroy_some(circles::asset_policy(&circle)));
        assert!(circles::terms_asset(&terms) == core::coin_type_bytes<SUI>(), 1);
        assert!(circles::terms_decimals(&terms) == 9, 2);
        assert!(circles::is_auto_swap_enabled(&circle), 3);
        assert!(circles::get_contribution_amount_raw(&circle) == SUI_CONTRIB, 4);
        assert!(circles::get_security_deposit_amount(&circle) == SUI_DEPOSIT, 5);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_TERMS_INVALID, location = njangi::njangi_circles)]
    fun test_create_pegged_amounts_must_match_the_usd_amounts() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_circle_as<TESTUSDC>(&mut scenario, USDC_CONTRIB + 1, USDC_DEPOSIT, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_TERMS_INVALID, location = njangi::njangi_circles)]
    fun test_create_rejects_a_deposit_under_half_a_contribution() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_circle_as<SUI>(&mut scenario, SUI_CONTRIB, SUI_CONTRIB / 2 - 1, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_unpinned_create_circle_is_retired() {
        let (mut scenario, clock) = start();
        ts::next_tx(&mut scenario, ADMIN);
        circles::create_circle(
            b"x", SUI_CONTRIB, b"USD", 1, USD_CONTRIB_CENTS, SUI_DEPOSIT, 1, USD_DEPOSIT_CENTS,
            0, 0, 0, 5, 0, vector[false, false], option::none(), option::none(), option::none(),
            option::none(), false, false, 0, option::none(), &clock, ts::ctx(&mut scenario)
        );
        abort 0
    }

    // ==========================================================
    // Security deposits
    // ==========================================================

    #[test]
    fun test_post_records_the_deposit_for_the_member() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);

        ts::next_tx(&mut scenario, BOB);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        let usdc = core::coin_type_bytes<TESTUSDC>();
        assert!(circles::member_deposit_of(&circle, BOB, usdc) == USDC_DEPOSIT, 1);
        assert!(circles::total_member_deposits(&circle, usdc) == USDC_DEPOSIT, 2);
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == USDC_DEPOSIT, 3);
        assert!(circles::deposit_marker_of(&circle, BOB) == option::some(usdc), 4);
        assert!(circles::depositors_of(&circle, usdc) == vector[BOB], 5);
        assert!(members::has_paid_deposit(circles::get_member(&circle, BOB)), 6);
        // Legacy storage and the legacy per-member fields see none of it.
        let (balance, sui_bucket, stable_bucket) = circles::legacy_deposit_fields_for_testing(&circle, BOB);
        assert!(balance == 0 && sui_bucket == 0 && stable_bucket == 0, 7);
        assert!(custody::get_stablecoin_balance<TESTUSDC>(&wallet) == 0, 8);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_ASSET_NOT_ALLOWED, location = njangi::njangi_circles)]
    fun test_post_refuses_a_coin_the_terms_do_not_name() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<JUNK>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 2, location = njangi::njangi_circles)]
    fun test_post_refuses_any_other_amount() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT - 1, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPOSIT_ALREADY_POSTED, location = njangi::njangi_circles)]
    fun test_post_refuses_a_second_deposit() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 46, location = njangi::njangi_circles)]
    fun test_post_refuses_any_wallet_but_the_bound_one() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        // A second wallet naming the circle.
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let other = custody::create_custody_wallet_returning_id(
            circles::get_id(&circle), START_MS, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);

        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared_by_id<CustodyWallet>(&scenario, other);
        let registry = ts::take_shared<AssetRegistry>(&scenario);
        let deposit = coin::mint_for_testing<TESTUSDC>(USDC_DEPOSIT, ts::ctx(&mut scenario));
        circles::post_security_deposit<TESTUSDC>(&mut circle, &mut wallet, &registry, deposit, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_CIRCLE_STOPPED, location = njangi::njangi_circles)]
    fun test_post_refused_once_the_circle_is_stopped() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, BOB, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 21, location = njangi::njangi_circles)]
    fun test_activation_needs_recorded_deposits_not_just_flags() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        // CAROL's flag set without a recorded deposit.
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::mark_all_deposits_paid_for_testing(&mut circle);
        ts::return_shared(circle);
        activate(&mut scenario, &clock);
        abort 0
    }

    #[test]
    fun test_reconcile_restores_flags_only_from_deposit_records() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);

        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        // Legacy per-member fields say CAROL deposited; no record says so.
        circles::process_member_deposit_internal(&mut circle, USDC_DEPOSIT, CAROL);
        circles::reconcile_deposit_paid(&mut circle, CAROL, &clock);
        assert!(!members::has_paid_deposit(circles::get_member(&circle, CAROL)), 1);
        circles::reconcile_deposit_paid(&mut circle, BOB, &clock);
        assert!(members::has_paid_deposit(circles::get_member(&circle, BOB)), 2);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    // Retired entrypoints abort with the one deprecation code (89).

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_legacy_security_deposit_entrypoint_is_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        let deposit = coin::mint_for_testing<TESTUSDC>(USDC_DEPOSIT, ts::ctx(&mut scenario));
        circles::member_deposit_security_deposit<TESTUSDC>(&mut circle, &mut wallet, deposit, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_legacy_stablecoin_contribution_is_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        let payment = coin::mint_for_testing<TESTUSDC>(USDC_CONTRIB, ts::ctx(&mut scenario));
        circles::contribute_stablecoin<TESTUSDC>(&mut circle, &mut wallet, payment, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 89, location = njangi::njangi_payments)]
    fun test_legacy_sui_contribution_is_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        let payment = coin::mint_for_testing<SUI>(SUI_CONTRIB, ts::ctx(&mut scenario));
        payments::contribute(&mut circle, &mut wallet, payment, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 89, location = njangi::njangi_payments)]
    fun test_legacy_trigger_payout_is_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        payments::trigger_payout<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 89, location = njangi::njangi_payments)]
    fun test_legacy_claim_payout_is_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        payments::claim_payout<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 89, location = njangi::njangi_payments)]
    fun test_auction_bids_are_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let bid = coin::mint_for_testing<SUI>(SUI_CONTRIB, ts::ctx(&mut scenario));
        payments::place_bid(&mut circle, bid, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // ==========================================================
    // Rounds on pinned terms
    // ==========================================================

    #[test]
    fun test_full_stablecoin_lap_on_pinned_rounds() {
        let (mut scenario, mut clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        let order = vector[ADMIN, BOB, CAROL];
        let mut r = 0;
        while (r < 3) {
            let recipient = *vector::borrow(&order, r);
            let round = open_round_as<TESTUSDC>(&mut scenario, recipient, &clock);
            let mut p = 0;
            while (p < 3) {
                let payer = *vector::borrow(&order, p);
                if (payer != recipient) {
                    contribute_round_as<TESTUSDC>(&mut scenario, payer, round, USDC_CONTRIB, &clock);
                };
                p = p + 1;
            };
            ts::next_tx(&mut scenario, recipient);
            let opened = ts::take_shared_by_id<CycleEscrow<TESTUSDC>>(&scenario, round);
            assert!(escrow::has_round_terms(&opened), 100 + r);
            assert!(escrow::contribution_amount(&opened) == USDC_CONTRIB, 110 + r);
            ts::return_shared(opened);
            collect_and_advance<TESTUSDC>(&mut scenario, recipient, round, &clock);
            assert_received<TESTUSDC>(&mut scenario, recipient, 2 * USDC_CONTRIB, 120 + r);
            clock::increment_for_testing(&mut clock, WEEK_MS);
            r = r + 1;
        };

        // End of the lap: paused, and every deposit still recorded and held.
        ts::next_tx(&mut scenario, ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::is_paused_after_cycle(&circle), 1);
        let usdc = core::coin_type_bytes<TESTUSDC>();
        assert!(circles::total_member_deposits(&circle, usdc) == 3 * USDC_DEPOSIT, 2);
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == 3 * USDC_DEPOSIT, 3);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    fun test_sui_circle_round_and_refund() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_circle_as<SUI>(&mut scenario, SUI_CONTRIB, SUI_DEPOSIT, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        post_as<SUI>(&mut scenario, ADMIN, SUI_DEPOSIT, &clock);
        post_as<SUI>(&mut scenario, BOB, SUI_DEPOSIT, &clock);
        post_as<SUI>(&mut scenario, CAROL, SUI_DEPOSIT, &clock);
        activate(&mut scenario, &clock);

        let round = open_round_as<SUI>(&mut scenario, ADMIN, &clock);
        contribute_round_as<SUI>(&mut scenario, BOB, round, SUI_CONTRIB, &clock);
        contribute_round_as<SUI>(&mut scenario, CAROL, round, SUI_CONTRIB, &clock);
        collect_and_advance<SUI>(&mut scenario, ADMIN, round, &clock);
        assert_received<SUI>(&mut scenario, ADMIN, 2 * SUI_CONTRIB, 1);

        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, CAROL, &clock);
        refund_asset_as<SUI>(&mut scenario, STRANGER, &clock);
        assert_received<SUI>(&mut scenario, ADMIN, SUI_DEPOSIT, 2);
        assert_received<SUI>(&mut scenario, BOB, SUI_DEPOSIT, 3);
        assert_received<SUI>(&mut scenario, CAROL, SUI_DEPOSIT, 4);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 236, location = njangi::njangi_cycle_escrow)]
    fun test_no_round_opens_before_the_circle_starts() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 237, location = njangi::njangi_cycle_escrow)]
    fun test_no_round_opens_while_the_circle_is_paused() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_paused_after_cycle_for_testing(&mut circle, true);
        ts::return_shared(circle);
        // The plain (pre-v11 named) entrypoint carries the same guard.
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        escrow::open_cycle_stable_indexed<TESTUSDC>(&mut circle, 6, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_existing_open_entrypoints_follow_the_pinned_terms() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        escrow::open_cycle_stable_indexed<TESTUSDC>(&mut circle, 6, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
        ts::next_tx(&mut scenario, ADMIN);
        let opened = ts::take_shared<CycleEscrow<TESTUSDC>>(&scenario);
        assert!(escrow::contribution_amount(&opened) == USDC_CONTRIB, 1);
        assert!(escrow::has_round_terms(&opened), 2);
        ts::return_shared(opened);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 239, location = njangi::njangi_cycle_escrow)]
    fun test_round_refuses_a_coin_other_than_the_settlement_asset() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        escrow::open_cycle_stable_indexed<SUI>(&mut circle, 6, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 243, location = njangi::njangi_cycle_escrow)]
    fun test_round_refuses_caller_decimals_that_differ_from_the_terms() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        escrow::open_cycle_stable_indexed<TESTUSDC>(&mut circle, 2, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 83, location = njangi::njangi_cycle_escrow)]
    fun test_open_round_needs_pinned_terms() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        abort 0
    }

    #[test]
    fun test_round_opened_without_the_terms_is_released_then_reopened() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        // A round opened without the pinned terms, at another amount, holds
        // the open-round marker.
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let bad = escrow::open_round_as_pre_v11_for_testing<TESTUSDC>(&mut circle, 1, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);

        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let bad_round = ts::take_shared_by_id<CycleEscrow<TESTUSDC>>(&scenario, bad);
        assert!(!escrow::is_valid_round(&circle, &bad_round), 1);
        escrow::release_invalid_round<TESTUSDC>(&mut circle, &bad_round, &clock);
        assert!(option::is_none(&circles::open_round(&circle)), 2);
        ts::return_shared(bad_round);
        ts::return_shared(circle);

        // The real round now opens, at the pinned amount, and fills.
        let round = open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        contribute_round_as<TESTUSDC>(&mut scenario, BOB, round, USDC_CONTRIB, &clock);
        contribute_round_as<TESTUSDC>(&mut scenario, CAROL, round, USDC_CONTRIB, &clock);
        collect_and_advance<TESTUSDC>(&mut scenario, ADMIN, round, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, 2 * USDC_CONTRIB, 3);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 234, location = njangi::njangi_cycle_escrow)]
    fun test_marker_from_an_earlier_version_blocks_until_released() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        escrow::open_round_as_pre_v11_for_testing<TESTUSDC>(&mut circle, 1, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
        open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 242, location = njangi::njangi_cycle_escrow)]
    fun test_a_valid_round_cannot_be_released() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        let round = open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let live = ts::take_shared_by_id<CycleEscrow<TESTUSDC>>(&scenario, round);
        escrow::release_invalid_round<TESTUSDC>(&mut circle, &live, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 240, location = njangi::njangi_cycle_escrow)]
    fun test_contribute_round_refuses_a_round_opened_without_the_terms() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        // Right coin, right amount, but opened without the pinned terms after
        // they were set: not a round contribute_round pays into.
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let untagged = escrow::open_round_as_pre_v11_for_testing<TESTUSDC>(
            &mut circle, USDC_CONTRIB, &clock, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);
        contribute_round_as<TESTUSDC>(&mut scenario, BOB, untagged, USDC_CONTRIB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 241, location = njangi::njangi_cycle_escrow)]
    fun test_contribute_round_refuses_a_past_round() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        let first = open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        contribute_round_as<TESTUSDC>(&mut scenario, BOB, first, USDC_CONTRIB, &clock);
        contribute_round_as<TESTUSDC>(&mut scenario, CAROL, first, USDC_CONTRIB, &clock);
        collect_and_advance<TESTUSDC>(&mut scenario, ADMIN, first, &clock);
        // The circle moved on to BOB's round.
        contribute_round_as<TESTUSDC>(&mut scenario, CAROL, first, USDC_CONTRIB, &clock);
        abort 0
    }

    // ==========================================================
    // Stop once, refund per asset
    // ==========================================================

    #[test]
    fun test_stop_then_refund_returns_each_recorded_deposit() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, BOB, &clock);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        assert!(!circles::is_circle_active(&circle), 1);
        assert!(circles::get_recovery_state(&circle) == 2, 2); // STOPPED, no coin moved yet
        assert!(circles::total_member_deposits(&circle, core::coin_type_bytes<TESTUSDC>()) == 3 * USDC_DEPOSIT, 3);
        ts::return_shared(circle);

        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 4);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 5);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 6);
        assert_received_nothing<TESTUSDC>(&mut scenario, STRANGER, 7);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        let usdc = core::coin_type_bytes<TESTUSDC>();
        assert!(circles::get_recovery_state(&circle) == 3, 8); // REFUNDED
        assert!(option::is_some(&circles::refund_record_of(&circle, usdc)), 9);
        assert!(circles::member_deposit_of(&circle, BOB, usdc) == 0, 10);
        assert!(option::is_none(&circles::deposit_marker_of(&circle, BOB)), 11);
        assert!(!members::has_paid_deposit(circles::get_member(&circle, BOB)), 12);
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == 0, 13);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    fun test_refund_asset_never_aborts_for_lack_of_deposits() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, BOB, &clock);
        // Another coin first: nothing recorded in it, nothing happens.
        refund_asset_as<JUNK>(&mut scenario, STRANGER, &clock);
        refund_asset_as<SUI>(&mut scenario, STRANGER, &clock);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 1);
        // Again, after everything went back: still no abort, no coin.
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received_nothing<TESTUSDC>(&mut scenario, BOB, 2);
        finish(scenario, clock);
    }

    #[test]
    fun test_execute_recovery_entrypoint_refunds_the_named_asset() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        pass_stop_vote(&mut scenario, &clock);
        ts::next_tx(&mut scenario, CAROL);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::execute_recovery<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        assert!(circles::get_recovery_state(&circle) == 3, 1);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 2);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 3);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 4);
        finish(scenario, clock);
    }

    #[test]
    fun test_execute_recovery_asset_stops_and_refunds_in_one_call() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        pass_stop_vote(&mut scenario, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::execute_recovery_asset<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        // Repeatable once stopped: the second call only re-runs the refund.
        circles::execute_recovery_asset<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 1);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 68, location = njangi::njangi_circles)]
    fun test_stop_needs_a_passed_vote() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        stop_as(&mut scenario, ADMIN, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_CIRCLE_NOT_STOPPED, location = njangi::njangi_circles)]
    fun test_refund_needs_a_stopped_circle() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        abort 0
    }

    #[test]
    fun test_refund_runs_after_a_stop_recorded_by_an_earlier_version() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        // The circle was stopped and marked refunded by the pre-v11 recovery
        // path, which reads legacy storage only.
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::mark_recovery_stopped_for_testing(&mut circle, &clock);
        circles::mark_recovery_refunded_for_testing(&mut circle, &clock);
        ts::return_shared(circle);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 1);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 2);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 3);
        finish(scenario, clock);
    }

    #[test]
    fun test_unexpected_coin_in_legacy_storage_never_blocks_refunds() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        // An unrelated coin sits in the wallet's legacy storage.
        legacy_deposit_as<JUNK>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, CAROL, &clock);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 1);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 2);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 3);
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::get_recovery_state(&circle) == 3, 4);
        // The unrelated coin was never counted and never moved.
        assert!(custody::get_stablecoin_balance<JUNK>(&wallet) == USDC_DEPOSIT, 5);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    fun test_stop_works_with_a_member_outside_the_rotation() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_circle_id, wallet_id) = legacy_circle(&mut scenario, &clock);
        // Three members, rotation of one.
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_is_active_for_testing(&mut circle, false);
        circles::reorder_rotation_positions(&mut circle, vector[ADMIN], &clock, ts::ctx(&mut scenario));
        assert!(circles::get_member_count(&circle) == 3, 1);
        ts::return_shared(circle);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);

        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::propose_emergency_stop(&mut circle, &clock, ts::ctx(&mut scenario));
        circles::vote_emergency_stop(&mut circle, true, &clock, ts::ctx(&mut scenario));
        circles::stop_for_recovery(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circles::get_recovery_state(&circle) == 2, 2);
        ts::return_shared(circle);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        assert!(circles::get_recovery_state(&circle) == 3, 3);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_CIRCLE_NOT_CONVERTED, location = njangi::njangi_circles)]
    fun test_recovery_on_an_unconverted_circle_asks_for_conversion() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_is_active_for_testing(&mut circle, false);
        circles::reorder_rotation_positions(&mut circle, vector[ADMIN], &clock, ts::ctx(&mut scenario));
        circles::propose_emergency_stop(&mut circle, &clock, ts::ctx(&mut scenario));
        circles::vote_emergency_stop(&mut circle, true, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::execute_recovery<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // ==========================================================
    // Removing a member
    // ==========================================================

    fun inactive_circle_with_deposits(scenario: &mut Scenario, clock: &Clock) {
        setup_registry(scenario);
        create_usdc_circle(scenario, clock);
        seat_bob_and_carol(scenario, clock);
        post_as<TESTUSDC>(scenario, ADMIN, USDC_DEPOSIT, clock);
        post_as<TESTUSDC>(scenario, BOB, USDC_DEPOSIT, clock);
        post_as<TESTUSDC>(scenario, CAROL, USDC_DEPOSIT, clock);
    }

    #[test]
    fun test_removal_with_asset_returns_the_deposit_to_the_member() {
        let (mut scenario, clock) = start();
        inactive_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::admin_remove_member_asset<TESTUSDC>(&mut circle, BOB, &mut wallet, &clock, ts::ctx(&mut scenario));
        assert!(!circles::is_member(&circle, BOB), 1);
        assert!(circles::member_deposit_of(&circle, BOB, core::coin_type_bytes<TESTUSDC>()) == 0, 2);
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == 2 * USDC_DEPOSIT, 3);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 4);
        assert_received_nothing<TESTUSDC>(&mut scenario, ADMIN, 5);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_ASSET_NOT_ALLOWED, location = njangi::njangi_circles)]
    fun test_removal_with_asset_refuses_another_coin() {
        let (mut scenario, clock) = start();
        inactive_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::admin_remove_member_asset<SUI>(&mut circle, BOB, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_plain_removal_leaves_the_deposit_for_the_member_to_collect() {
        let (mut scenario, clock) = start();
        inactive_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::admin_remove_member(&mut circle, BOB, &mut wallet, &clock, ts::ctx(&mut scenario));
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received_nothing<TESTUSDC>(&mut scenario, BOB, 1);

        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::claim_own_refund<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 2);
        assert_received_nothing<TESTUSDC>(&mut scenario, ADMIN, 3);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_CIRCLE_NOT_CONVERTED, location = njangi::njangi_circles)]
    fun test_unconverted_removal_never_pays_from_legacy_storage() {
        let (mut scenario, clock) = start();
        let _wallet = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_is_active_for_testing(&mut circle, false);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::admin_remove_member(&mut circle, BOB, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_unconverted_removal_of_a_member_without_deposit() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_is_active_for_testing(&mut circle, false);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::admin_remove_member(&mut circle, BOB, &mut wallet, &clock, ts::ctx(&mut scenario));
        assert!(!circles::is_member(&circle, BOB), 1);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_CIRCLE_NOT_STOPPED, location = njangi::njangi_circles)]
    fun test_members_collect_their_own_deposit_only_after_a_stop() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::claim_own_refund<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // ==========================================================
    // Converting a pre-v11 circle
    // ==========================================================

    #[test]
    fun test_conversion_moves_ledger_deposits_into_member_records() {
        let (mut scenario, clock) = start();
        let wallet_id = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared_by_id<CustodyWallet>(&scenario, wallet_id);
        let usdc = core::coin_type_bytes<TESTUSDC>();
        assert!(circles::is_converted(&circle), 1);
        assert!(circles::bound_wallet_id(&circle) == option::some(wallet_id), 2);
        assert!(circles::legacy_migrated_entries(&circle) == option::some(3), 3);
        let terms = circles::policy_settlement_terms(&option::destroy_some(circles::asset_policy(&circle)));
        assert!(circles::terms_contribution_amount(&terms) == USDC_CONTRIB, 4);
        assert!(circles::terms_security_deposit(&terms) == USDC_DEPOSIT, 5);
        assert!(circles::member_deposit_of(&circle, ADMIN, usdc) == USDC_DEPOSIT, 6);
        assert!(circles::member_deposit_of(&circle, BOB, usdc) == USDC_DEPOSIT, 7);
        assert!(circles::member_deposit_of(&circle, CAROL, usdc) == USDC_DEPOSIT, 8);
        // Same wallet: legacy storage emptied into the v11 deposit records.
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == 3 * USDC_DEPOSIT, 9);
        assert!(custody::get_stablecoin_balance<TESTUSDC>(&wallet) == 0, 10);
        assert!(custody::is_legacy_slot_migrated<TESTUSDC>(&wallet), 11);
        // Legacy per-member fields describe legacy storage: now empty.
        let (balance, sui_bucket, stable_bucket) = circles::legacy_deposit_fields_for_testing(&circle, BOB);
        assert!(balance == 0 && sui_bucket == 0 && stable_bucket == 0, 12);
        assert!(members::has_paid_deposit(circles::get_member(&circle, BOB)), 13);
        ts::return_shared(wallet);
        ts::return_shared(circle);

        // And the converted circle refunds exactly the ledger amounts.
        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, BOB, &clock);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 14);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 15);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 16);
        finish(scenario, clock);
    }

    #[test]
    fun test_conversion_and_refunds_follow_the_ledger_not_legacy_fields() {
        let (mut scenario, clock) = start();
        let wallet_id = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        // Legacy per-member fields that disagree with the ledger, before
        // conversion...
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::process_member_deposit_internal(&mut circle, 5 * SUI_DEPOSIT, CAROL);
        ts::return_shared(circle);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        assert!(circles::member_deposit_of(&circle, CAROL, core::coin_type_bytes<TESTUSDC>()) == USDC_DEPOSIT, 1);
        // ...and after it.
        circles::process_member_deposit_internal(&mut circle, 5 * SUI_DEPOSIT, BOB);
        ts::return_shared(circle);

        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, CAROL, &clock);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 2);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 3);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_LEGACY_NOT_MIGRATABLE, location = njangi::njangi_circles)]
    fun test_conversion_fails_closed_when_records_claim_an_unledgered_deposit() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_c, wallet_id) = legacy_circle(&mut scenario, &clock);
        legacy_deposit_as<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, &clock);
        legacy_deposit_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::process_member_deposit_internal(&mut circle, SUI_DEPOSIT, CAROL);
        ts::return_shared(circle);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_LEGACY_NOT_MIGRATABLE, location = njangi::njangi_circles)]
    fun test_conversion_refuses_a_wallet_that_held_two_coins() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_c, wallet_id) = legacy_circle(&mut scenario, &clock);
        legacy_deposit_as<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, &clock);
        legacy_deposit_as<JUNK>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_LEGACY_NOT_MIGRATABLE, location = njangi::njangi_circles)]
    fun test_conversion_refuses_a_ledger_with_legacy_rail_contributions() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_c, wallet_id) = legacy_circle(&mut scenario, &clock);
        legacy_deposit_as<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, &clock);
        ts::next_tx(&mut scenario, BOB);
        let mut wallet = ts::take_shared_by_id<CustodyWallet>(&scenario, wallet_id);
        let payment = coin::mint_for_testing<TESTUSDC>(USDC_CONTRIB, ts::ctx(&mut scenario));
        circles::legacy_contribution_for_testing<TESTUSDC>(&mut wallet, payment, BOB, &clock, ts::ctx(&mut scenario));
        ts::return_shared(wallet);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 46, location = njangi::njangi_circles)]
    fun test_conversion_refuses_a_wallet_someone_else_created() {
        let (mut scenario, clock) = start();
        let _real = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let other = custody::create_custody_wallet_returning_id(
            circles::get_id(&circle), START_MS, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, other, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 46, location = njangi::njangi_circles)]
    fun test_conversion_refuses_a_wallet_other_than_the_recorded_one() {
        let (mut scenario, clock) = start();
        let real = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_wallet_id_for_testing(&mut circle, real);
        // Same creator, same creation time — but not the recorded wallet.
        let lookalike = custody::create_custody_wallet_returning_id(
            circles::get_id(&circle), START_MS, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, lookalike, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_LEGACY_NOT_MIGRATABLE, location = njangi::njangi_circles)]
    fun test_conversion_refuses_a_lookalike_wallet_missing_members_deposits() {
        let (mut scenario, clock) = start();
        let _real = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        // No recorded wallet id (pre-v9 circles). The admin's lookalike
        // wallet cannot carry the other members' deposits in its ledger.
        ts::next_tx(&mut scenario, ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let lookalike = custody::create_custody_wallet_returning_id(
            circles::get_id(&circle), START_MS, ts::ctx(&mut scenario)
        );
        ts::return_shared(circle);
        adopt_as<TESTUSDC>(&mut scenario, ADMIN, lookalike, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_TERMS_INVALID, location = njangi::njangi_circles)]
    fun test_conversion_pins_only_the_coin_the_circle_already_uses() {
        let (mut scenario, clock) = start();
        let wallet_id = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        // Stablecoin-mode circle: SUI terms would change its economics.
        adopt_as<SUI>(&mut scenario, STRANGER, wallet_id, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_POLICY_EXISTS, location = njangi::njangi_circles)]
    fun test_conversion_runs_once() {
        let (mut scenario, clock) = start();
        let wallet_id = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        abort 0
    }

    #[test]
    fun test_conversion_of_a_sui_circle_moves_sui_deposits() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_c, wallet_id) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_auto_swap_for_testing(&mut circle, true);
        ts::return_shared(circle);
        // share_circle_for_testing: security deposit = contribution / 2.
        legacy_deposit_as<SUI>(&mut scenario, ADMIN, SUI_DEPOSIT, &clock);
        legacy_deposit_as<SUI>(&mut scenario, BOB, SUI_DEPOSIT, &clock);
        legacy_deposit_as<SUI>(&mut scenario, CAROL, SUI_DEPOSIT, &clock);
        adopt_as<SUI>(&mut scenario, STRANGER, wallet_id, &clock);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared_by_id<CustodyWallet>(&scenario, wallet_id);
        assert!(circles::member_deposit_of(&circle, BOB, core::coin_type_bytes<SUI>()) == SUI_DEPOSIT, 1);
        assert!(custody::deposit_balance_value<SUI>(&wallet) == 3 * SUI_DEPOSIT, 2);
        assert!(custody::get_wallet_balance(&wallet) == 0, 3);
        ts::return_shared(wallet);
        ts::return_shared(circle);

        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, BOB, &clock);
        refund_asset_as<SUI>(&mut scenario, STRANGER, &clock);
        assert_received<SUI>(&mut scenario, BOB, SUI_DEPOSIT, 4);
        finish(scenario, clock);
    }

    #[test]
    fun test_a_circle_with_an_empty_ledger_converts_for_anyone() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        let (_c, wallet_id) = legacy_circle(&mut scenario, &clock);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        assert!(circles::is_converted(&circle), 1);
        assert!(circles::legacy_migrated_entries(&circle) == option::some(0), 2);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 2, location = sui::dynamic_field)]
    fun test_legacy_coin_slot_stays_closed_after_conversion() {
        let (mut scenario, clock) = start();
        let wallet_id = legacy_usdc_circle_with_deposits(&mut scenario, &clock);
        adopt_as<TESTUSDC>(&mut scenario, STRANGER, wallet_id, &clock);
        // A legacy-storage write of the pinned asset (pre-v11 shape) meets
        // the migrated marker and the transaction aborts.
        legacy_deposit_as<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, &clock);
        abort 0
    }

    // ==========================================================
    // Pinned terms stay pinned
    // ==========================================================

    #[test]
    #[expected_failure(abort_code = circles::E_POLICY_LOCKED, location = njangi::njangi_circles)]
    fun test_mode_flag_cannot_contradict_the_terms() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::toggle_auto_swap(&mut circle, true, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_native_amounts_are_never_repriced() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::sync_native_display_amounts(&mut circle, 350, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_unpinned_circle_is_not_repriced_either() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::sync_native_display_amounts(&mut circle, 350, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_POLICY_LOCKED, location = njangi::njangi_circles)]
    fun test_pinned_amounts_are_not_edited() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::update_cycle_limits(&mut circle, 0, 0, 2_000, 1_000, 2_000, 1_000, 350, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_POLICY_LOCKED, location = njangi::njangi_circles)]
    fun test_wallet_binding_cannot_be_repointed() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::update_wallet_id(&mut circle, object::id_from_address(@0x77), &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    fun test_empty_pinned_circle_can_be_deleted() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::can_delete_circle(&circle, &wallet, ADMIN), 1);
        circles::delete_circle(circle, &wallet, ts::ctx(&mut scenario));
        ts::return_shared(wallet);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 6, location = njangi::njangi_circles)]
    fun test_pinned_circle_with_a_recorded_deposit_is_not_deleted() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        post_as<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(!circles::can_delete_circle(&circle, &wallet, ADMIN), 1);
        circles::delete_circle(circle, &wallet, ts::ctx(&mut scenario));
        abort 0
    }

    // ==========================================================
    // Custody posture: no privileged key moves a member's deposit
    //
    // The circle admin, the registry admin and the UpgradeCap holder each
    // run every lever they have over a circle holding deposits. Afterwards
    // the deposits are exactly where they were, none of them received a
    // coin, and the members' refunds still run — to the members — even
    // with the asset disabled and its roles cleared in the registry.
    // ==========================================================

    #[test]
    fun test_no_admin_operator_or_cap_holder_path_moves_member_deposits() {
        let (mut scenario, clock) = start();
        inactive_circle_with_deposits(&mut scenario, &clock);
        let usdc = core::coin_type_bytes<TESTUSDC>();

        // Circle admin: every admin lever that applies to an inactive circle.
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::toggle_auto_swap(&mut circle, false, &clock, ts::ctx(&mut scenario));
        circles::admin_set_max_members(&mut circle, 4, &clock, ts::ctx(&mut scenario));
        circles::update_next_in_command(&mut circle, option::some(BOB), &clock, ts::ctx(&mut scenario));
        circles::heartbeat_admin_liveness(&mut circle, &clock, ts::ctx(&mut scenario));
        circles::reorder_rotation_positions(&mut circle, vector[CAROL, BOB, ADMIN], &clock, ts::ctx(&mut scenario));
        circles::admin_approve_member(&mut circle, DAVE, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);

        // Registry admin: disable the asset, clear its roles, hand over.
        ts::next_tx(&mut scenario, OPERATOR);
        let mut registry = ts::take_shared<AssetRegistry>(&scenario);
        pv::set_asset_enabled(&mut registry, usdc, false, ts::ctx(&mut scenario));
        pv::set_asset_flags(&mut registry, usdc, 0, ts::ctx(&mut scenario));
        // UpgradeCap holder: the cap governs the registry's canonical mark only.
        let cap = sui::package::test_publish(object::id_from_address(@njangi), ts::ctx(&mut scenario));
        pv::bless_canonical(&mut registry, &cap, ts::ctx(&mut scenario));
        transfer::public_transfer(cap, OPERATOR);
        pv::transfer_registry_admin(&mut registry, NEW_OPERATOR, ts::ctx(&mut scenario));
        ts::return_shared(registry);

        // Nothing moved, and nobody privileged received anything.
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == 3 * USDC_DEPOSIT, 1);
        assert!(circles::member_deposit_of(&circle, ADMIN, usdc) == USDC_DEPOSIT, 2);
        assert!(circles::member_deposit_of(&circle, BOB, usdc) == USDC_DEPOSIT, 3);
        assert!(circles::member_deposit_of(&circle, CAROL, usdc) == USDC_DEPOSIT, 4);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received_nothing<TESTUSDC>(&mut scenario, ADMIN, 5);
        assert_received_nothing<TESTUSDC>(&mut scenario, OPERATOR, 6);
        assert_received_nothing<TESTUSDC>(&mut scenario, NEW_OPERATOR, 7);

        // The members' exit still works, to the members, with the asset off.
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::propose_emergency_stop(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
        vote_yes(&mut scenario, BOB, &clock);
        vote_yes(&mut scenario, CAROL, &clock);
        stop_as(&mut scenario, CAROL, &clock);
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 8);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 9);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 10);
        assert_received_nothing<TESTUSDC>(&mut scenario, OPERATOR, 11);
        assert_received_nothing<TESTUSDC>(&mut scenario, STRANGER, 12);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_admin_cannot_rewrite_deposit_bookkeeping() {
        let (mut scenario, clock) = start();
        inactive_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::process_member_deposit(&mut circle, 1, BOB, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_manual_lap_bump_is_retired() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::update_cycle(&mut circle, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_auction_state_writers_are_retired() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::start_auction(&mut circle, 0, 1, 1, 0, START_MS);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 89, location = njangi::njangi_payments)]
    fun test_auction_admin_entrypoints_are_retired() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        payments::start_position_auction(&mut circle, 0, 1, 1, 0, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = circles::E_DEPRECATED_ENTRYPOINT, location = njangi::njangi_circles)]
    fun test_caller_supplied_circle_events_are_retired() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        circles::emit_payout_overdue(&circle, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 89, location = njangi::njangi_custody)]
    fun test_guessed_decimals_view_is_retired() {
        let (mut scenario, clock) = start();
        let (_c, _w) = legacy_circle(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        custody::get_coin_decimals(&wallet, std::string::utf8(b"USDC"));
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 7, location = njangi::njangi_circles)]
    fun test_only_the_admin_removes_and_only_to_the_member() {
        let (mut scenario, clock) = start();
        inactive_circle_with_deposits(&mut scenario, &clock);
        ts::next_tx(&mut scenario, STRANGER);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::admin_remove_member_asset<TESTUSDC>(&mut circle, BOB, &mut wallet, &clock, ts::ctx(&mut scenario));
        abort 0
    }

    // ==========================================================
    // One member, one seat
    // ==========================================================

    #[test]
    fun test_set_rotation_position_moves_a_seated_member() {
        // Seating a member who already holds a seat vacates the old one:
        // the order ends up naming that member exactly once.
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);   // max_members 5
        seat_bob_and_carol(&mut scenario, &clock);   // ADMIN 0, BOB 1, CAROL 2

        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_rotation_position(&mut circle, BOB, 3, &clock, ts::ctx(&mut scenario));
        let order = circles::get_rotation_order(&circle);
        assert!(vector::length(&order) == 4, 1);
        assert!(*vector::borrow(&order, 0) == ADMIN, 2);
        assert!(*vector::borrow(&order, 1) == @0x0, 3);
        assert!(*vector::borrow(&order, 2) == CAROL, 4);
        assert!(*vector::borrow(&order, 3) == BOB, 5);
        assert!(members::get_payout_position(circles::get_member(&circle, BOB)) == option::some(3), 6);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 94, location = njangi::njangi_circles)]
    fun test_reorder_refuses_a_member_in_two_seats() {
        let (mut scenario, clock) = start();
        setup_registry(&mut scenario);
        create_usdc_circle(&mut scenario, &clock);
        seat_bob_and_carol(&mut scenario, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::reorder_rotation_positions(
            &mut circle,
            vector[ADMIN, BOB, CAROL, ADMIN],
            &clock,
            ts::ctx(&mut scenario)
        );
        abort 0
    }

    // ==========================================================
    // Planned close: complete_circle between laps
    // ==========================================================

    /// Runs one full lap on the active USDC circle: ADMIN, BOB and CAROL
    /// each collect once, after which the circle pauses with no round open.
    fun run_full_usdc_lap(scenario: &mut Scenario, clock: &Clock) {
        let r1 = open_round_as<TESTUSDC>(scenario, ADMIN, clock);
        contribute_round_as<TESTUSDC>(scenario, BOB, r1, USDC_CONTRIB, clock);
        contribute_round_as<TESTUSDC>(scenario, CAROL, r1, USDC_CONTRIB, clock);
        collect_and_advance<TESTUSDC>(scenario, ADMIN, r1, clock);
        let r2 = open_round_as<TESTUSDC>(scenario, ADMIN, clock);
        contribute_round_as<TESTUSDC>(scenario, ADMIN, r2, USDC_CONTRIB, clock);
        contribute_round_as<TESTUSDC>(scenario, CAROL, r2, USDC_CONTRIB, clock);
        collect_and_advance<TESTUSDC>(scenario, BOB, r2, clock);
        let r3 = open_round_as<TESTUSDC>(scenario, ADMIN, clock);
        contribute_round_as<TESTUSDC>(scenario, ADMIN, r3, USDC_CONTRIB, clock);
        contribute_round_as<TESTUSDC>(scenario, BOB, r3, USDC_CONTRIB, clock);
        collect_and_advance<TESTUSDC>(scenario, CAROL, r3, clock);
    }

    fun complete_as(scenario: &mut Scenario, who: address, clock: &Clock) {
        ts::next_tx(scenario, who);
        let mut circle = ts::take_shared<Circle>(scenario);
        circles::complete_circle(&mut circle, clock, ts::ctx(scenario));
        ts::return_shared(circle);
    }

    #[test]
    fun test_admin_completes_a_paused_circle_and_every_deposit_comes_back() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        run_full_usdc_lap(&mut scenario, &clock);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        assert!(circles::is_paused_after_cycle(&circle), 1);
        assert!(option::is_none(&circles::open_round(&circle)), 2);
        assert!(!circles::is_completed(&circle), 3);
        ts::return_shared(circle);

        complete_as(&mut scenario, ADMIN, &clock);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        assert!(!circles::is_circle_active(&circle), 4);
        assert!(circles::is_completed(&circle), 5);
        let record = option::destroy_some(circles::completion(&circle));
        assert!(circles::completion_by(&record) == ADMIN, 6);
        assert!(circles::completion_time_ms(&record) == START_MS, 7);
        assert!(circles::get_recovery_state(&circle) == 2, 8); // STOPPED, no coin moved yet
        ts::return_shared(circle);

        // The same permissionless, rule-fixed refund as after an emergency
        // stop: each deposit to the member who paid it, nothing to anyone else.
        refund_asset_as<TESTUSDC>(&mut scenario, STRANGER, &clock);
        assert_received<TESTUSDC>(&mut scenario, ADMIN, USDC_DEPOSIT, 9);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 10);
        assert_received<TESTUSDC>(&mut scenario, CAROL, USDC_DEPOSIT, 11);
        assert_received_nothing<TESTUSDC>(&mut scenario, STRANGER, 12);

        ts::next_tx(&mut scenario, STRANGER);
        let circle = ts::take_shared<Circle>(&scenario);
        let wallet = ts::take_shared<CustodyWallet>(&scenario);
        assert!(circles::get_recovery_state(&circle) == 3, 13); // REFUNDED
        assert!(custody::deposit_balance_value<TESTUSDC>(&wallet) == 0, 14);
        ts::return_shared(wallet);
        ts::return_shared(circle);
        finish(scenario, clock);
    }

    #[test]
    fun test_member_claims_own_deposit_after_completion() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        run_full_usdc_lap(&mut scenario, &clock);
        complete_as(&mut scenario, ADMIN, &clock);

        ts::next_tx(&mut scenario, BOB);
        let mut circle = ts::take_shared<Circle>(&scenario);
        let mut wallet = ts::take_shared<CustodyWallet>(&scenario);
        circles::claim_own_refund<TESTUSDC>(&mut circle, &mut wallet, &clock, ts::ctx(&mut scenario));
        ts::return_shared(wallet);
        ts::return_shared(circle);
        assert_received<TESTUSDC>(&mut scenario, BOB, USDC_DEPOSIT, 1);
        // Nobody else moved: their deposits wait for them (or for refund_asset).
        assert_received_nothing<TESTUSDC>(&mut scenario, STRANGER, 2);
        finish(scenario, clock);
    }

    #[test]
    #[expected_failure(abort_code = 57, location = njangi::njangi_circles)]
    fun test_complete_refused_while_a_round_is_in_flight() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        // Round 1 is open and funded by BOB: not paused, nothing to close.
        let r1 = open_round_as<TESTUSDC>(&mut scenario, ADMIN, &clock);
        contribute_round_as<TESTUSDC>(&mut scenario, BOB, r1, USDC_CONTRIB, &clock);
        complete_as(&mut scenario, ADMIN, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 7, location = njangi::njangi_circles)]
    fun test_only_the_admin_completes() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        run_full_usdc_lap(&mut scenario, &clock);
        complete_as(&mut scenario, BOB, &clock);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = 93, location = njangi::njangi_circles)]
    fun test_complete_refused_once_stopped() {
        let (mut scenario, clock) = start();
        active_usdc_circle(&mut scenario, &clock);
        pass_stop_vote(&mut scenario, &clock);
        stop_as(&mut scenario, BOB, &clock);
        ts::next_tx(&mut scenario, ADMIN);
        let mut circle = ts::take_shared<Circle>(&scenario);
        circles::set_paused_after_cycle_for_testing(&mut circle, true);
        ts::return_shared(circle);
        complete_as(&mut scenario, ADMIN, &clock);
        abort 0
    }
}
