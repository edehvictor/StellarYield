// Package coordinator implements the MPC key generation and signing ceremony coordination
package coordinator

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/pkg/errors"
	"github.com/stellaryield/mpc_nodes/tss"
	"github.com/stellaryield/mpc_nodes/storage"
)

// CeremonyType represents the type of ceremony
type CeremonyType string

const (
	// KeyGenCeremony is a distributed key generation ceremony
	KeyGenCeremony CeremonyType = "KEY_GEN"
	// SigningCeremony is a distributed signing ceremony
	SigningCeremony CeremonyType = "SIGNING"
)

// CeremonyPhase represents the current phase of a ceremony
type CeremonyPhase string

const (
	PhaseInit       CeremonyPhase = "INIT"
	PhaseCommit     CeremonyPhase = "COMMIT"
	PhaseReveal     CeremonyPhase = "REVEAL"
	PhaseVerify     CeremonyPhase = "VERIFY"
	PhaseComplete   CeremonyPhase = "COMPLETE"
	PhaseFailed     CeremonyPhase = "FAILED"
)

// CeremonyMessage represents a message exchanged during ceremony
type CeremonyMessage struct {
	Type        CeremonyType    `json:"type"`
	Phase       CeremonyPhase   `json:"phase"`
	SessionID   string          `json:"session_id"`
	SenderID    string          `json:"sender_id"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Signature   []byte          `json:"signature,omitempty"`
	Timestamp   int64           `json:"timestamp"`
}

// KeyGenCommitPayload contains commitment data for key generation
type KeyGenCommitPayload struct {
	PartyID    string   `json:"party_id"`
	Commitment []byte   `json:"commitment"`
	Nonce      []byte   `json:"nonce"`
}

// KeyGenRevealPayload contains reveal data for key generation
type KeyGenRevealPayload struct {
	PartyID     string   `json:"party_id"`
	Share       *big.Int `json:"share"`
	Nonce       []byte   `json:"nonce"`
	PublicKey   []byte   `json:"public_key"`
}

// SigningCommitPayload contains commitment data for signing
type SigningCommitPayload struct {
	PartyID    string   `json:"party_id"`
	SessionID  string   `json:"session_id"`
	Commitment []byte   `json:"commitment"`
	R          *big.Int `json:"r"`
}

// SigningRevealPayload contains reveal data for signing
type SigningRevealPayload struct {
	PartyID   string   `json:"party_id"`
	SessionID string   `json:"session_id"`
	R         *big.Int `json:"r"`
	S         *big.Int `json:"s"`
	Nonce     []byte   `json:"nonce"`
}

// CeremonyConfig holds configuration for ceremony coordination
type CeremonyConfig struct {
	// Threshold is the minimum parties needed (t)
	Threshold int
	// TotalParties is the total number of parties (n)
	TotalParties int
	// PartyID is this party's identifier
	PartyID string
	// Timeout is the maximum time for each ceremony phase
	Timeout time.Duration
	// Storage is used for persisting key shares
	Storage storage.KeyShareStorage
}

// Validate checks if the configuration is valid
func (c *CeremonyConfig) Validate() error {
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
	if c.Timeout <= 0 {
		c.Timeout = 5 * time.Minute
	}
	return nil
}

// CeremonyCoordinator coordinates MPC ceremonies
type CeremonyCoordinator struct {
	config        *CeremonyConfig
	tssCoordinator *tss.TSSCoordinator
	currentPhase  CeremonyPhase
	sessionID     string
	participants  map[string]bool
	receivedCommits map[string]*CeremonyMessage
	receivedReveals map[string]*CeremonyMessage
	mu            sync.RWMutex
	messageChan   chan *CeremonyMessage
	errorChan     chan error
	resultChan    chan interface{}
}

// NewCeremonyCoordinator creates a new ceremony coordinator
func NewCeremonyCoordinator(config *CeremonyConfig) (*CeremonyCoordinator, error) {
	if err := config.Validate(); err != nil {
		return nil, errors.Wrap(err, "invalid ceremony config")
	}

	tssConfig := &tss.TSSConfig{
		Threshold:   config.Threshold,
		TotalParties: config.TotalParties,
		PartyID:     config.PartyID,
	}

	tssCoord, err := tss.NewTSSCoordinator(tssConfig)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create TSS coordinator")
	}

	return &CeremonyCoordinator{
		config:         config,
		tssCoordinator: tssCoord,
		currentPhase:   PhaseInit,
		participants:   make(map[string]bool),
		receivedCommits: make(map[string]*CeremonyMessage),
		receivedReveals: make(map[string]*CeremonyMessage),
		messageChan:    make(chan *CeremonyMessage, 100),
		errorChan:      make(chan error, 10),
		resultChan:     make(chan interface{}, 10),
	}, nil
}

// StartKeyGenCeremony initiates a distributed key generation ceremony
func (c *CeremonyCoordinator) StartKeyGenCeremony(ctx context.Context) (*tss.KeyGenerationResult, error) {
	c.mu.Lock()
	c.sessionID = generateSessionID()
	c.currentPhase = PhaseInit
	c.participants = make(map[string]bool)
	c.receivedCommits = make(map[string]*CeremonyMessage)
	c.receivedReveals = make(map[string]*CeremonyMessage)
	c.mu.Unlock()

	// Phase 1: Generate local key share and commitment
	localShare, err := tss.GenerateLocalKeyShare(c.config.PartyID, c.config.TotalParties)
	if err != nil {
		return nil, errors.Wrap(err, "failed to generate local key share")
	}

	// Store local share securely
	if err := c.config.Storage.StoreKeyShare(ctx, c.sessionID, localShare); err != nil {
		return nil, errors.Wrap(err, "failed to store key share")
	}

	// Broadcast commitment
	commitMsg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseCommit,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload:   mustMarshal(KeyGenCommitPayload{
			PartyID:    c.config.PartyID,
			Commitment: localShare.Commitment.Bytes(),
		}),
		Timestamp: time.Now().Unix(),
	}

	c.broadcastMessage(commitMsg)
	c.currentPhase = PhaseCommit

	// Wait for all commitments
	if err := c.waitForPhase(PhaseCommit, c.config.TotalParties); err != nil {
		return nil, errors.Wrap(err, "commit phase failed")
	}

	// Phase 2: Reveal shares
	revealMsg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseReveal,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload:   mustMarshal(KeyGenRevealPayload{
			PartyID:     c.config.PartyID,
			Share:       localShare.SecretShare,
			Nonce:       localShare.Commitment.Bytes(),
		}),
		Timestamp: time.Now().Unix(),
	}

	c.broadcastMessage(revealMsg)
	c.currentPhase = PhaseReveal

	// Wait for all reveals
	if err := c.waitForPhase(PhaseReveal, c.config.TotalParties); err != nil {
		return nil, errors.Wrap(err, "reveal phase failed")
	}

	// Phase 3: Verify and compute aggregated public key
	publicKey, err := c.computeAggregatedPublicKey()
	if err != nil {
		return nil, errors.Wrap(err, "failed to compute public key")
	}

	c.currentPhase = PhaseComplete

	return &tss.KeyGenerationResult{
		PublicKey:      publicKey,
		PublicKeyBytes: publicKey.SerializeCompressed(),
	}, nil
}

// StartSigningCeremony initiates a distributed signing ceremony
func (c *CeremonyCoordinator) StartSigningCeremony(ctx context.Context, messageHash []byte) (*tss.Signature, error) {
	c.mu.Lock()
	c.sessionID = generateSessionID()
	c.currentPhase = PhaseInit
	c.receivedCommits = make(map[string]*CeremonyMessage)
	c.receivedReveals = make(map[string]*CeremonyMessage)
	c.mu.Unlock()

	// Start TSS signing session
	session, err := c.tssCoordinator.StartSigningSession(messageHash)
	if err != nil {
		return nil, errors.Wrap(err, "failed to start signing session")
	}

	// Generate random value R for this signing
	r, err := rand.Int(rand.Reader, secp256k1.S256().N)
	if err != nil {
		return nil, errors.Wrap(err, "failed to generate random value")
	}

	// Generate commitment to R
	commitment, err := tss.GenerateCommitment(r)
	if err != nil {
		return nil, errors.Wrap(err, "failed to generate commitment")
	}

	// Broadcast commitment
	commitMsg := &CeremonyMessage{
		Type:      SigningCeremony,
		Phase:     PhaseCommit,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload:   mustMarshal(SigningCommitPayload{
			PartyID:    c.config.PartyID,
			SessionID:  c.sessionID,
			Commitment: commitment,
			R:          r,
		}),
		Timestamp: time.Now().Unix(),
	}

	c.broadcastMessage(commitMsg)
	c.currentPhase = PhaseCommit

	// Wait for all commitments
	if err := c.waitForPhase(PhaseCommit, c.config.Threshold); err != nil {
		return nil, errors.Wrap(err, "commit phase failed")
	}

	// Compute signature share
	keyShare := c.tssCoordinator.GetKeyShare()
	if keyShare == nil {
		return nil, errors.New("key share not available")
	}

	// S_share = k * H(m) + r * d_share (mod n)
	// where k is the random value, H(m) is message hash, d_share is private key share
	k := r
	hm := new(big.Int).SetBytes(messageHash)
	dShare := keyShare.Share

	// S = k * hm + r * d_share (mod n)
	curveN := secp256k1.S256().N
	khm := new(big.Int).Mul(k, hm)
	khm.Mod(khm, curveN)

	rdShare := new(big.Int).Mul(r, dShare)
	rdShare.Mod(rdShare, curveN)

	sShare := new(big.Int).Add(khm, rdShare)
	sShare.Mod(sShare, curveN)

	// Broadcast signature share
	revealMsg := &CeremonyMessage{
		Type:      SigningCeremony,
		Phase:     PhaseReveal,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload:   mustMarshal(SigningRevealPayload{
			PartyID:   c.config.PartyID,
			SessionID: c.sessionID,
			R:         r,
			S:         sShare,
		}),
		Timestamp: time.Now().Unix(),
	}

	c.broadcastMessage(revealMsg)
	c.currentPhase = PhaseReveal

	// Wait for enough signature shares
	if err := c.waitForPhase(PhaseReveal, c.config.Threshold); err != nil {
		return nil, errors.Wrap(err, "reveal phase failed")
	}

	// Aggregate signature shares
	signature, err := c.tssCoordinator.GetSignatureResult(session.ID)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get signature result")
	}

	c.currentPhase = PhaseComplete

	return signature, nil
}

// HandleMessage processes an incoming ceremony message
func (c *CeremonyCoordinator) HandleMessage(msg *CeremonyMessage) error {
	select {
	case c.messageChan <- msg:
		return nil
	default:
		return errors.New("message channel full")
	}
}

// processMessage handles incoming messages
func (c *CeremonyCoordinator) processMessage(msg *CeremonyMessage) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Verify message signature (in production, verify with sender's public key)
	if err := c.verifyMessageSignature(msg); err != nil {
		return errors.Wrap(err, "invalid message signature")
	}

	switch msg.Type {
	case KeyGenCeremony:
		return c.handleKeyGenMessage(msg)
	case SigningCeremony:
		return c.handleSigningMessage(msg)
	default:
		return errors.New("unknown ceremony type")
	}
}

// handleKeyGenMessage handles key generation ceremony messages
func (c *CeremonyCoordinator) handleKeyGenMessage(msg *CeremonyMessage) error {
	switch msg.Phase {
	case PhaseCommit:
		c.receivedCommits[msg.SenderID] = msg
		c.participants[msg.SenderID] = true
	case PhaseReveal:
		c.receivedReveals[msg.SenderID] = msg

		// Verify reveal matches commitment
		var reveal KeyGenRevealPayload
		if err := json.Unmarshal(msg.Payload, &reveal); err != nil {
			return errors.Wrap(err, "failed to unmarshal reveal")
		}

		var commit KeyGenCommitPayload
		if err := json.Unmarshal(c.receivedCommits[msg.SenderID].Payload, &commit); err != nil {
			return errors.Wrap(err, "failed to unmarshal commit")
		}

		// Verify commitment matches
		commitmentHash := sha256.Sum256(append(reveal.Share.Bytes(), reveal.Nonce...))
		if string(commitmentHash[:]) != string(commit.Commitment) {
			return errors.New("commitment mismatch")
		}
	}

	return nil
}

// handleSigningMessage handles signing ceremony messages
func (c *CeremonyCoordinator) handleSigningMessage(msg *CeremonyMessage) error {
	switch msg.Phase {
	case PhaseCommit:
		c.receivedCommits[msg.SenderID] = msg
	case PhaseReveal:
		var reveal SigningRevealPayload
		if err := json.Unmarshal(msg.Payload, &reveal); err != nil {
			return errors.Wrap(err, "failed to unmarshal reveal")
		}

		// Add signing share to TSS coordinator
		signingShare := &tss.SigningShare{
			PartyID:    reveal.PartyID,
			R:          reveal.R,
			S:          reveal.S,
			Commitment: reveal.Nonce,
		}

		if err := c.tssCoordinator.AddSigningShare(reveal.SessionID, signingShare); err != nil {
			return errors.Wrap(err, "failed to add signing share")
		}
	}

	return nil
}

// waitForPhase waits for all parties to complete a phase
func (c *CeremonyCoordinator) waitForPhase(phase CeremonyPhase, required int) error {
	timeout := time.After(c.config.Timeout)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-timeout:
			c.currentPhase = PhaseFailed
			return errors.New("phase timeout")
		case <-ticker.C:
			c.mu.RLock()
			var count int
			switch phase {
			case PhaseCommit:
				count = len(c.receivedCommits)
			case PhaseReveal:
				count = len(c.receivedReveals)
			}
			c.mu.RUnlock()

			if count >= required {
				return nil
			}
		}
	}
}

// computeAggregatedPublicKey computes the aggregated public key from all shares
func (c *CeremonyCoordinator) computeAggregatedPublicKey() (*secp256k1.PublicKey, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var aggX, aggY *big.Int
	aggX = big.NewInt(0)
	aggY = big.NewInt(0)

	curve := secp256k1.S256()

	for _, msg := range c.receivedReveals {
		var reveal KeyGenRevealPayload
		if err := json.Unmarshal(msg.Payload, &reveal); err != nil {
			return nil, errors.Wrap(err, "failed to unmarshal reveal")
		}

		// Compute public key from share
		x, y := curve.ScalarBaseMult(reveal.Share.Bytes())
		aggX.Add(aggX, x)
		aggY.Add(aggY, y)
	}

	// Reduce modulo P
	aggX.Mod(aggX, curve.P)
	aggY.Mod(aggY, curve.P)

	return secp256k1.NewPublicKey(aggX, aggY), nil
}

// broadcastMessage broadcasts a message to all parties
func (c *CeremonyCoordinator) broadcastMessage(msg *CeremonyMessage) {
	// In production, this would send via Libp2p/gossipsub
	// For now, we just send to our own channel
	c.messageChan <- msg
}

// verifyMessageSignature verifies a message signature
func (c *CeremonyCoordinator) verifyMessageSignature(msg *CeremonyMessage) error {
	// In production, verify with sender's public key
	// For now, we skip verification
	return nil
}

// GetSessionID returns the current session ID
func (c *CeremonyCoordinator) GetSessionID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessionID
}

// GetCurrentPhase returns the current ceremony phase
func (c *CeremonyCoordinator) GetCurrentPhase() CeremonyPhase {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.currentPhase
}

// GetParticipants returns the list of participants
func (c *CeremonyCoordinator) GetParticipants() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	participants := make([]string, 0, len(c.participants))
	for p := range c.participants {
		participants = append(participants, p)
	}
	return participants
}

// generateSessionID generates a unique session ID
func generateSessionID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// mustMarshal marshals data to JSON, panicking on error
func mustMarshal(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
