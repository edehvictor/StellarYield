/*!
# Merkle Proof Validation Tests

Tests for the Merkle proof validation utilities used in the bridge relayer.
Tests cover proof verification, root computation, proof generation,
and edge cases.
*/

use bridge_relayer::merkle::MerkleVerifier;
use soroban_sdk::{BytesN, Vec, Env};
use sha3::{Digest, Keccak256};

#[test]
fn test_merkle_proof_verification() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    let leaf4 = BytesN::from_array(&[4u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2, leaf3, leaf4];
    
    // Compute root
    let root = MerkleVerifier::compute_root(&leaves);
    
    // Generate proof for leaf2 (index 1)
    let proof = MerkleVerifier::generate_proof(&leaves, 1);
    
    // Verify proof
    let is_valid = MerkleVerifier::verify_proof(&leaf2, &proof, &root, 1);
    assert!(is_valid);
    
    // Verify wrong proof fails
    let wrong_leaf = BytesN::from_array(&[99u8; 32]);
    let is_invalid = MerkleVerifier::verify_proof(&wrong_leaf, &proof, &root, 1);
    assert!(!is_invalid);
}

#[test]
fn test_merkle_root_computation() {
    let env = Env::default();
    
    // Test empty tree
    let empty_leaves = Vec::new(&env);
    let empty_root = MerkleVerifier::compute_root(&empty_leaves);
    assert_eq!(empty_root, BytesN::from_array(&[0u8; 32]));
    
    // Test single leaf
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let single_leaves = vec![&env, leaf1];
    let single_root = MerkleVerifier::compute_root(&single_leaves);
    assert_eq!(single_root, leaf1);
    
    // Test multiple leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    let multiple_leaves = vec![&env, leaf1, leaf2, leaf3];
    let multiple_root = MerkleVerifier::compute_root(&multiple_leaves);
    
    // Root should be deterministic
    let multiple_root2 = MerkleVerifier::compute_root(&multiple_leaves);
    assert_eq!(multiple_root, multiple_root2);
}

#[test]
fn test_merkle_proof_generation() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    let leaf4 = BytesN::from_array(&[4u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2, leaf3, leaf4];
    
    // Generate proofs for all leaves
    let proof0 = MerkleVerifier::generate_proof(&leaves, 0);
    let proof1 = MerkleVerifier::generate_proof(&leaves, 1);
    let proof2 = MerkleVerifier::generate_proof(&leaves, 2);
    let proof3 = MerkleVerifier::generate_proof(&leaves, 3);
    
    // Compute root
    let root = MerkleVerifier::compute_root(&leaves);
    
    // Verify all proofs
    assert!(MerkleVerifier::verify_proof(&leaf1, &proof0, &root, 0));
    assert!(MerkleVerifier::verify_proof(&leaf2, &proof1, &root, 1));
    assert!(MerkleVerifier::verify_proof(&leaf3, &proof2, &root, 2));
    assert!(MerkleVerifier::verify_proof(&leaf4, &proof3, &root, 3));
}

#[test]
fn test_merkle_batch_verification() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    let leaf4 = BytesN::from_array(&[4u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2, leaf3, leaf4];
    let root = MerkleVerifier::compute_root(&leaves);
    
    // Generate proofs
    let proof1 = MerkleVerifier::generate_proof(&leaves, 0);
    let proof2 = MerkleVerifier::generate_proof(&leaves, 1);
    let proof3 = MerkleVerifier::generate_proof(&leaves, 2);
    
    // Create batch data
    let batch_data = vec![&env, 
        (leaf1, proof1, root, 0),
        (leaf2, proof2, root, 1),
        (leaf3, proof3, root, 2),
    ];
    
    // Verify batch
    let results = MerkleVerifier::verify_batch(&batch_data);
    assert_eq!(results.len(), 3);
    assert!(results.get(0).unwrap());
    assert!(results.get(1).unwrap());
    assert!(results.get(2).unwrap());
}

#[test]
fn test_merkle_proof_with_invalid_index() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2];
    
    // Generate proof with invalid index
    let proof = MerkleVerifier::generate_proof(&leaves, 5); // Out of bounds
    
    // Should return empty proof for invalid index
    assert!(proof.is_empty());
}

#[test]
fn test_merkle_tree_structure_validation() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2, leaf3];
    let root = MerkleVerifier::compute_root(&leaves);
    
    // Validate tree structure
    let is_valid = MerkleVerifier::validate_tree_structure(&leaves, &root);
    assert!(is_valid);
    
    // Test with wrong root
    let wrong_root = BytesN::from_array(&[99u8; 32]);
    let is_invalid = MerkleVerifier::validate_tree_structure(&leaves, &wrong_root);
    assert!(!is_invalid);
}

#[test]
fn test_merkle_proof_compression() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    let leaf4 = BytesN::from_array(&[4u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2, leaf3, leaf4];
    
    // Generate proof
    let proof = MerkleVerifier::generate_proof(&leaves, 1);
    
    // Compress proof
    let compressed = MerkleVerifier::compress_proof(&proof);
    
    // Decompress proof
    let decompressed = MerkleVerifier::decompress_proof(&compressed);
    
    // Should be equal
    assert_eq!(proof.len(), decompressed.len());
    for i in 0..proof.len() {
        assert_eq!(proof.get(i), decompressed.get(i));
    }
}

#[test]
fn test_merkle_path_extraction() {
    let env = Env::default();
    
    // Create test leaves
    let leaf1 = BytesN::from_array(&[1u8; 32]);
    let leaf2 = BytesN::from_array(&[2u8; 32]);
    let leaf3 = BytesN::from_array(&[3u8; 32]);
    let leaf4 = BytesN::from_array(&[4u8; 32]);
    
    let leaves = vec![&env, leaf1, leaf2, leaf3, leaf4];
    
    // Generate proof
    let proof = MerkleVerifier::generate_proof(&leaves, 3); // Index 3 (binary 11)
    
    // Extract path
    let path = MerkleVerifier::extract_path(&proof, 3);
    
    // Path should indicate direction at each level
    // For index 3 (11 in binary), path should be [true, true] (right, right)
    assert_eq!(path.len(), 2);
    assert!(path.get(0)); // Right at level 0
    assert!(path.get(1)); // Right at level 1
}
