// Package tss implements Threshold Signature Scheme (TSS) for MPC treasury
// This implementation uses ECDSA secp256k1 with Shamir's Secret Sharing
package tss

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"sync"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/pkg/errors"
)

// TSSConfig holds configuration for TSS operations
type TSSConfig struct {
	// Threshold is the minimum number of parties needed to sign (t)
	Threshold int
	// TotalParties is the total number of parties in the MPC network (n)
	TotalParties int
	// PartyID is this party's unique identifier
	PartyID string
}

// Validate checks if the configuration is valid
func (c *TSSConfig) Validate() error {
	if c.Threshold <= 0 {
		return errors.New("threshold must be positive")
	}
	if c.TotalParties <= 0 {
		return errors.New("total parties must be positive")
	}
	if c.Threshold > c.TotalParties {
		return errors.New("threshold cannot exceed total parties")
	}
	if c.PartyID == "" {
		return errors.New("party ID cannot be empty")
	}
	return nil
}

// KeyShare represents a party's share of the distributed private key
type KeyShare struct {
	// PartyID is this party's identifier
	PartyID string
	// Share is this party's private key share (never transmitted)
	Share *big.Int
	// Commitments are the public commitments from key generation
	Commitments []*big.Int
	// PublicKeys are the public key shares of all parties
	PublicKeys []*secp256k1.PublicKey
}

// PublicKey returns the aggregated public key from all shares
func (ks *KeyShare) PublicKey() (*secp256k1.PublicKey, error) {
	if len(ks.PublicKeys) == 0 {
		return nil, errors.New("no public keys available")
	}

	// Aggregate public keys
	var aggX, aggY *big.Int
	aggX = big.NewInt(0)
	aggY = big.NewInt(0)

	for _, pk := range ks.PublicKeys {
		aggX.Add(aggX, pk.X())
		aggY.Add(aggY, pk.Y())
	}

	return secp256k1.NewPublicKey(aggX, aggY), nil
}

// LocalSecretShare holds the local secret share with commitment
type LocalSecretShare struct {
	// PartyID is this party's identifier
	PartyID string
	// SecretShare is the actual secret share
	SecretShare *big.Int
	// Commitment is the public commitment to this share
	Commitment *big.Int
}

// KeyGenerationResult holds the result of distributed key generation
type KeyGenerationResult struct {
	// KeyShare is this party's key share
	KeyShare *KeyShare
	// PublicKey is the aggregated public key
	PublicKey *secp256k1.PublicKey
	// PublicKeyBytes is the serialized public key
	PublicKeyBytes []byte
}

// TSSError represents TSS-related errors
type TSSError struct {
	Code    string
	Message string
	Cause   error
}

func (e *TSSError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("TSS[%s]: %s - %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("TSS[%s]: %s", e.Code, e.Message)
}

// Common error codes
const (
	ErrInvalidThreshold  = "INVALID_THRESHOLD"
	ErrInvalidShare      = "INVALID_SHARE"
	ErrInvalidSignature  = "INVALID_SIGNATURE"
	ErrKeyGenFailed      = "KEYGEN_FAILED"
	ErrSignFailed        = "SIGN_FAILED"
	ErrVerifyFailed      = "VERIFY_FAILED"
	ErrCommitmentMismatch = "COMMITMENT_MISMATCH"
)

// GenerateLocalKeyShare generates a local key share for a party
// This is the first step in distributed key generation
func GenerateLocalKeyShare(partyID string, totalParties int) (*LocalSecretShare, error) {
	// Generate random secret share
	secretShare, err := rand.Int(rand.Reader, secp256k1.S256().N)
	if err != nil {
		return nil, &TSSError{
			Code:    ErrKeyGenFailed,
			Message: "failed to generate secret share",
			Cause:   err,
		}
	}

	// Generate commitment (hash of share)
	commitment := sha256.Sum256(secretShare.Bytes())
	commitmentBig := new(big.Int).SetBytes(commitment[:])

	return &LocalSecretShare{
		PartyID:     partyID,
		SecretShare: secretShare,
		Commitment:  commitmentBig,
	}, nil
}

// ShamirShare represents a Shamir's Secret Sharing share
type ShamirShare struct {
	// Index is the x-coordinate (party index)
	Index *big.Int
	// Value is the y-coordinate (share value)
	Value *big.Int
}

// ShamirSecretSharing implements Shamir's Secret Sharing scheme
type ShamirSecretSharing struct {
	threshold int
	total     int
	curve     *secp256k1.KoblitzCurve
}

// NewShamirSecretSharing creates a new Shamir SSS instance
func NewShamirSecretSharing(threshold, total int) *ShamirSecretSharing {
	return &ShamirSecretSharing{
		threshold: threshold,
		total:     total,
		curve:     secp256k1.S256(),
	}
}

// GeneratePolynomial generates a random polynomial of degree (threshold - 1)
// The constant term is the secret
func (s *ShamirSecretSharing) GeneratePolynomial(secret *big.Int) ([]*big.Int, error) {
	if secret.Cmp(s.curve.N) >= 0 {
		return nil, errors.New("secret exceeds curve order")
	}

	// Polynomial coefficients: [secret, a1, a2, ..., a_{t-1}]
	coefficients := make([]*big.Int, s.threshold)
	coefficients[0] = secret

	for i := 1; i < s.threshold; i++ {
		coeff, err := rand.Int(rand.Reader, s.curve.N)
		if err != nil {
			return nil, errors.Wrap(err, "failed to generate polynomial coefficient")
		}
		coefficients[i] = coeff
	}

	return coefficients, nil
}

// EvaluatePolynomial evaluates the polynomial at point x
func (s *ShamirSecretSharing) EvaluatePolynomial(coefficients []*big.Int, x *big.Int) *big.Int {
	result := big.NewInt(0)
	xPower := big.NewInt(1)

	for _, coeff := range coefficients {
		// result += coeff * x^i
		term := new(big.Int).Mul(coeff, xPower)
		result.Add(result, term)
		result.Mod(result, s.curve.N)

		// xPower = xPower * x
		xPower.Mul(xPower, x)
		xPower.Mod(xPower, s.curve.N)
	}

	return result
}

// GenerateShares generates shares for all parties
func (s *ShamirSecretSharing) GenerateShares(secret *big.Int) ([]*ShamirShare, error) {
	coefficients, err := s.GeneratePolynomial(secret)
	if err != nil {
		return nil, err
	}

	shares := make([]*ShamirShare, s.total)
	for i := 1; i <= s.total; i++ {
		x := big.NewInt(int64(i))
		y := s.EvaluatePolynomial(coefficients, x)

		shares[i-1] = &ShamirShare{
			Index: x,
			Value: y,
		}
	}

	return shares, nil
}

// LagrangeInterpolation reconstructs the secret from shares
func (s *ShamirSecretSharing) LagrangeInterpolation(shares []*ShamirShare) (*big.Int, error) {
	if len(shares) < s.threshold {
		return nil, errors.New("insufficient shares for reconstruction")
	}

	secret := big.NewInt(0)

	for i, share := range shares[:s.threshold] {
		// Calculate Lagrange basis polynomial at x=0
		numerator := big.NewInt(1)
		denominator := big.NewInt(1)

		for j, otherShare := range shares[:s.threshold] {
			if i != j {
				// numerator *= (0 - x_j) = -x_j
				negXj := new(big.Int).Neg(otherShare.Index)
				numerator.Mul(numerator, negXj)
				numerator.Mod(numerator, s.curve.N)

				// denominator *= (x_i - x_j)
				diff := new(big.Int).Sub(share.Index, otherShare.Index)
				denominator.Mul(denominator, diff)
				denominator.Mod(denominator, s.curve.N)
			}
		}

		// Calculate modular inverse of denominator
		denominator.ModInverse(denominator, s.curve.N)

		// lagrange = numerator * denominator^-1
		lagrange := new(big.Int).Mul(numerator, denominator)
		lagrange.Mod(lagrange, s.curve.N)

		// secret += y_i * lagrange
		term := new(big.Int).Mul(share.Value, lagrange)
		secret.Add(secret, term)
		secret.Mod(secret, s.curve.N)
	}

	return secret, nil
}

// SigningShare represents a party's contribution to a signature
type SigningShare struct {
	// PartyID is the party's identifier
	PartyID string
	// R is the shared random value x-coordinate
	R *big.Int
	// S is the party's signature share
	S *big.Int
	// Commitment is the commitment to the random value
	Commitment []byte
}

// Signature is a complete ECDSA signature
type Signature struct {
	R *big.Int
	S *big.Int
}

// Serialize returns the signature as bytes
func (sig *Signature) Serialize() []byte {
	rBytes := sig.R.Bytes()
	sBytes := sig.S.Bytes()

	// Pad to 32 bytes each
	rPadded := make([]byte, 32)
	sPadded := make([]byte, 32)
	copy(rPadded[32-len(rBytes):], rBytes)
	copy(sPadded[32-len(sBytes):], sBytes)

	return append(rPadded, sPadded...)
}

// SignatureFromBytes deserializes a signature from bytes
func SignatureFromBytes(data []byte) (*Signature, error) {
	if len(data) != 64 {
		return nil, errors.New("invalid signature length")
	}

	r := new(big.Int).SetBytes(data[:32])
	s := new(big.Int).SetBytes(data[32:])

	return &Signature{R: r, S: s}, nil
}

// TSSCoordinator coordinates TSS operations across parties
type TSSCoordinator struct {
	config      *TSSConfig
	mu          sync.RWMutex
	keyShare    *KeyShare
	signingData map[string]*SigningSession
}

// SigningSession holds state for a signing operation
type SigningSession struct {
	ID           string
	MessageHash  []byte
	Shares       map[string]*SigningShare
	Completed    bool
	Result       *Signature
	mu           sync.Mutex
}

// NewTSSCoordinator creates a new TSS coordinator
func NewTSSCoordinator(config *TSSConfig) (*TSSCoordinator, error) {
	if err := config.Validate(); err != nil {
		return nil, &TSSError{
			Code:    ErrInvalidThreshold,
			Message: "invalid configuration",
			Cause:   err,
		}
	}

	return &TSSCoordinator{
		config:      config,
		signingData: make(map[string]*SigningSession),
	}, nil
}

// SetKeyShare sets the local key share
func (c *TSSCoordinator) SetKeyShare(share *KeyShare) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.keyShare = share
}

// GetKeyShare returns the local key share
func (c *TSSCoordinator) GetKeyShare() *KeyShare {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.keyShare
}

// StartSigningSession initiates a new signing session
func (c *TSSCoordinator) StartSigningSession(messageHash []byte) (*SigningSession, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.keyShare == nil {
		return nil, &TSSError{
			Code:    ErrKeyGenFailed,
			Message: "key share not set",
		}
	}

	sessionID := hex.EncodeToString(sha256.Sum256(messageHash))

	session := &SigningSession{
		ID:          sessionID,
		MessageHash: messageHash,
		Shares:      make(map[string]*SigningShare),
	}

	c.signingData[sessionID] = session

	return session, nil
}

// AddSigningShare adds a signing share from a party
func (c *TSSCoordinator) AddSigningShare(sessionID string, share *SigningShare) error {
	c.mu.Lock()
	session, exists := c.signingData[sessionID]
	c.mu.Unlock()

	if !exists {
		return &TSSError{
			Code:    ErrSignFailed,
			Message: "signing session not found",
		}
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	session.Shares[share.PartyID] = share

	// Check if we have enough shares
	if len(session.Shares) >= c.config.Threshold && !session.Completed {
		// Aggregate signature shares
		signature, err := c.aggregateSignatureShares(session)
		if err != nil {
			return err
		}

		session.Result = signature
		session.Completed = true
	}

	return nil
}

// aggregateSignatureShares combines individual signature shares into a complete signature
func (c *TSSCoordinator) aggregateSignatureShares(session *SigningSession) (*Signature, error) {
	if len(session.Shares) < c.config.Threshold {
		return nil, &TSSError{
			Code:    ErrSignFailed,
			Message: "insufficient signature shares",
		}
	}

	// Get R from first share (all should be the same)
	var r *big.Int
	shares := make([]*SigningShare, 0, len(session.Shares))
	for _, share := range session.Shares {
		if r == nil {
			r = share.R
		}
		shares = append(shares, share)
	}

	// Aggregate S values
	aggS := big.NewInt(0)
	for _, share := range shares {
		aggS.Add(aggS, share.S)
		aggS.Mod(aggS, secp256k1.S256().N)
	}

	return &Signature{
		R: r,
		S: aggS,
	}, nil
}

// GetSignatureResult returns the completed signature if available
func (c *TSSCoordinator) GetSignatureResult(sessionID string) (*Signature, error) {
	c.mu.RLock()
	session, exists := c.signingData[sessionID]
	c.mu.RUnlock()

	if !exists {
		return nil, &TSSError{
			Code:    ErrSignFailed,
			Message: "signing session not found",
		}
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if !session.Completed {
		return nil, &TSSError{
			Code:    ErrSignFailed,
			Message: "signing session not completed",
		}
	}

	return session.Result, nil
}

// VerifySignature verifies a TSS signature
func VerifySignature(publicKey *secp256k1.PublicKey, messageHash []byte, signature *Signature) bool {
	return secp256k1.VerifySignature(publicKey.SerializeUncompressed(), messageHash, signature.R.Bytes(), signature.S.Bytes())
}

// ComputeMessageHash computes the SHA256 hash of a message for signing
func ComputeMessageHash(message []byte) []byte {
	hash := sha256.Sum256(message)
	return hash[:]
}

// GenerateCommitment generates a commitment to a value
func GenerateCommitment(value *big.Int) ([]byte, error) {
	// Generate random nonce
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}

	// Commitment = H(value || nonce)
	h := sha256.New()
	h.Write(value.Bytes())
	h.Write(nonce)

	return h.Sum(nil), nil
}
