module njangi::njangi_milestones {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::table::{Self, Table};
    use sui::dynamic_field as df;
    use std::string::{Self, String};
    use sui::event;
    use std::vector;
    use std::option::{Self, Option};
    
    use njangi::njangi_core::{Self as core};
    use njangi::njangi_circles::{Self as circles};
    
    // ----------------------------------------------------------
    // Error codes specific to milestones
    // ----------------------------------------------------------
    const EInvalidMilestone: u64 = 28;
    const EMilestoneTypeInvalid: u64 = 31;
    const EMilestoneTargetInvalid: u64 = 32;
    const EMilestoneVerificationFailed: u64 = 33;
    const EMilestoneDeadlinePassed: u64 = 34;
    const EMilestoneAlreadyVerified: u64 = 35;
    const EMilestonePrerequisiteNotMet: u64 = 36;
    
    // Key for dynamic field
    public struct MilestoneDataKey has copy, drop, store {}
    
    // ----------------------------------------------------------
    // Main Milestone struct - moved from njangi_circles
    // ----------------------------------------------------------
    public struct Milestone has store, drop {
        milestone_type: u8,
        target_amount: Option<u64>,        // For monetary (in SUI decimals)
        target_duration: Option<u64>,      // For time-based (in ms)
        start_time: u64,
        deadline: u64,
        completed: bool,
        verified_by: Option<address>,
        completion_time: Option<u64>,
        description: String,
        prerequisites: vector<u64>,        // Indices of prior milestones
        verification_requirements: vector<u8>,
        verification_proofs: vector<vector<u8>>,
    }
    
    // Container for milestones to store as dynamic field
    public struct MilestoneData has key, store {
        id: UID,
        circle_id: ID,
        milestones: vector<Milestone>
    }
    
    // ----------------------------------------------------------
    // Initialize milestone data for a circle
    // ----------------------------------------------------------
    public fun init_circle_milestones(circle_id: ID, ctx: &mut TxContext) {
        let milestone_data = MilestoneData {
            id: object::new(ctx),
            circle_id,
            milestones: vector::empty()
        };
        
        // Share the milestone data object for the circle
        transfer::share_object(milestone_data);
    }
    
    // ----------------------------------------------------------
    // Get milestone data using circle_id - helper function
    // ----------------------------------------------------------
    public fun get_milestone_data(milestone_data: &MilestoneData): (ID, &vector<Milestone>) {
        (milestone_data.circle_id, &milestone_data.milestones)
    }
    
    // ----------------------------------------------------------
    // Add monetary milestone
    // ----------------------------------------------------------
    public fun add_monetary_milestone(
        milestone_data: &mut MilestoneData,
        target_amount: u64,
        deadline: u64,
        description: vector<u8>,
        prerequisites: vector<u64>,
        verification_requirements: vector<u8>,
        start_time: u64
    ) {
        let milestone = Milestone {
            milestone_type: core::milestone_type_monetary(),
            target_amount: option::some(core::to_decimals(target_amount)),
            target_duration: option::none(),
            start_time,
            deadline,
            completed: false,
            verified_by: option::none(),
            completion_time: option::none(),
            description: string::utf8(description),
            prerequisites,
            verification_requirements,
            verification_proofs: vector::empty(),
        };
        
        vector::push_back(&mut milestone_data.milestones, milestone);
    }
    
    // ----------------------------------------------------------
    // Add time milestone
    // ----------------------------------------------------------
    public fun add_time_milestone(
        milestone_data: &mut MilestoneData,
        duration_days: u64,
        deadline: u64,
        description: vector<u8>,
        start_time: u64
    ) {
        let milestone = Milestone {
            milestone_type: core::milestone_type_time(),
            target_amount: option::none(),
            target_duration: option::some(duration_days * core::ms_per_day()),
            start_time,
            deadline,
            completed: false,
            verified_by: option::none(),
            completion_time: option::none(),
            description: string::utf8(description),
            prerequisites: vector::empty(),
            verification_requirements: vector::empty(),
            verification_proofs: vector::empty(),
        };
        
        vector::push_back(&mut milestone_data.milestones, milestone);
    }
    
    // ----------------------------------------------------------
    // Verify milestone
    // ----------------------------------------------------------
    public fun verify_milestone(
        milestone_data: &mut MilestoneData,
        circle: &mut circles::Circle,
        milestone_number: u64,
        current_time: u64,
        verifier: address
    ) {
        assert!(milestone_number < vector::length(&milestone_data.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow_mut(&mut milestone_data.milestones, milestone_number);
        assert!(!milestone.completed, EMilestoneAlreadyVerified);
        assert!(current_time <= milestone.deadline, EMilestoneDeadlinePassed);
        
        // Based on milestone type
        if (milestone.milestone_type == core::milestone_type_monetary()) {
            let target = *option::borrow(&milestone.target_amount);
            // We need to get the balance from the circle
            // assert!(balance::value(&circle.contributions) >= target, EMilestoneTargetInvalid);
            // TODO: Implement a way to check circle's contribution balance
        } else if (milestone.milestone_type == core::milestone_type_time()) {
            let target_duration = *option::borrow(&milestone.target_duration);
            let elapsed_time = current_time - milestone.start_time;
            assert!(elapsed_time >= target_duration, EMilestoneTargetInvalid);
        } else {
            abort EMilestoneTypeInvalid
        };
        
        // Check that we have enough proofs for each requirement
        assert!(
            vector::length(&milestone.verification_proofs) 
            >= vector::length(&milestone.verification_requirements),
            EMilestoneVerificationFailed
        );
        
        milestone.completed = true;
        milestone.verified_by = option::some(verifier);
        milestone.completion_time = option::some(current_time);
        
        // If it's a monetary milestone, add to circle.goal_progress
        // circle.last_milestone_completed = milestone_number;
        // TODO: Update circle state with completed milestone
    }
    
    // ----------------------------------------------------------
    // Get milestone info
    // ----------------------------------------------------------
    public fun get_milestone_info(milestone_data: &MilestoneData, milestone_number: u64): (u8, Option<u64>, Option<u64>, u64, u64, bool, Option<address>, Option<u64>, String) {
        assert!(milestone_number < vector::length(&milestone_data.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow(&milestone_data.milestones, milestone_number);
        (
            milestone.milestone_type,
            milestone.target_amount,
            milestone.target_duration,
            milestone.start_time,
            milestone.deadline,
            milestone.completed,
            milestone.verified_by,
            milestone.completion_time,
            milestone.description
        )
    }
    
    // ----------------------------------------------------------
    // Submit milestone verification
    // ----------------------------------------------------------
    public fun submit_milestone_verification(
        milestone_data: &mut MilestoneData,
        milestone_number: u64,
        verification_proof: vector<u8>,
        timestamp: u64,
        sender: address
    ) {
        assert!(milestone_number < vector::length(&milestone_data.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow_mut(&mut milestone_data.milestones, milestone_number);
        assert!(!milestone.completed, EMilestoneAlreadyVerified);
        
        vector::push_back(&mut milestone.verification_proofs, verification_proof);
    }
    
    // ----------------------------------------------------------
    // Get milestone verification type
    // ----------------------------------------------------------
    public fun get_milestone_verification_type(milestone_data: &MilestoneData, milestone_number: u64, index: u64): u8 {
        assert!(milestone_number < vector::length(&milestone_data.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow(&milestone_data.milestones, milestone_number);
        // Assuming verification_requirements is a vector of verification types (u8)
        // If it's a single verification type, adjust accordingly
        if (vector::length(&milestone.verification_requirements) > index) {
            *vector::borrow(&milestone.verification_requirements, index)
        } else {
            0 // Default verification type
        }
    }
    
    // ----------------------------------------------------------
    // Get verification proofs length
    // ----------------------------------------------------------
    public fun get_verification_proofs_length(milestone_data: &MilestoneData, milestone_number: u64): u64 {
        assert!(milestone_number < vector::length(&milestone_data.milestones), EInvalidMilestone);
        
        let milestone = vector::borrow(&milestone_data.milestones, milestone_number);
        vector::length(&milestone.verification_proofs)
    }
    
    // ----------------------------------------------------------
    // Delete milestone data - called when circle is deleted
    // ----------------------------------------------------------
    public fun delete_milestone_data(milestone_data: MilestoneData, ctx: &TxContext) {
        let MilestoneData { 
            id,
            circle_id: _,
            milestones: _
        } = milestone_data;
        
        // Delete the MilestoneData object
        object::delete(id);
    }
    
    // ----------------------------------------------------------
    // Public entry points that link to njangi_circles
    // ----------------------------------------------------------
    public fun get_milestone_count(milestone_data: &MilestoneData): u64 {
        vector::length(&milestone_data.milestones)
    }
    
    public fun is_milestone_completed(milestone_data: &MilestoneData, milestone_number: u64): bool {
        if (milestone_number >= vector::length(&milestone_data.milestones)) {
            return false
        };
        
        let milestone = vector::borrow(&milestone_data.milestones, milestone_number);
        milestone.completed
    }
} 