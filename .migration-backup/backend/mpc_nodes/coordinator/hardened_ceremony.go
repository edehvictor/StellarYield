// Package coordinator implements hardened MPC ceremony coordination
// with signed messages, phase replay protection, and comprehensive audit trails.
package coordinator

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/pkg/errors"
)

// HardenedCeremonyMessage adds cryptographic proof and replay protection to ceremony messages
type HardenedCeremonyMessage struct {
	// Original ceremony message
	Message *CeremonyMessage `json:"message"`

	// Message signature (ECDSA over (type || phase || session_id || sender_id || payload || timestamp))
	MessageSignature []byte `json:"message_signature"`

	// Sender's public key for verification
	SenderPublicKey []byte `json:"sender_public_key"`

	// Replay nonce unique per (sender_id, session_id, phase)
	ReplayNonce uint64 `json:"replay_nonce"`

	// Phase-specific entropy to prevent phase substitution attacks
	PhaseHash []byte `json:"phase_hash"`

	// Timestamp to detect time-travel attacks (must be within [now-5min, now+5min])
	SignedTimestamp int64 `json:"signed_timestamp"`
}

// AuditEventType categorizes different ceremony events
type AuditEventType string

const (
	AuditPhaseTransition    AuditEventType = "PHASE_TRANSITION"
	AuditMessageReceived    AuditEventType = "MESSAGE_RECEIVED"
	AuditMessageValidated   AuditEventType = "MESSAGE_VALIDATED"
	AuditReplayDetected     AuditEventType = "REPLAY_DETECTED"
	AuditInvalidSignature   AuditEventType = "INVALID_SIGNATURE"
	AuditTimeViolation      AuditEventType = "TIME_VIOLATION"
	AuditPhaseViolation     AuditEventType = "PHASE_VIOLATION"
	AuditThresholdReached   AuditEventType = "THRESHOLD_REACHED"
	AuditCeremonyCompleted  AuditEventType = "CEREMONY_COMPLETED"
	AuditCeremonyFailed     AuditEventType = "CEREMONY_FAILED"
	AuditKeyShareStored     AuditEventType = "KEY_SHARE_STORED"
)

// AuditEvent logs security-relevant ceremony events for compliance and forensics
type AuditEvent struct {
	EventType      AuditEventType `json:"event_type"`
	SessionID      string         `json:"session_id"`
	Timestamp      time.Time      `json:"timestamp"`
	PartyID        string         `json:"party_id"`
	Message        string         `json:"message,omitempty"`
	Phase          CeremonyPhase  `json:"phase,omitempty"`
	Details        json.RawMessage `json:"details,omitempty"`
	Hash           []byte         `json:"hash"` // SHA256 of event for tampering detection
}

// ReplayProtectionState tracks messages per (sender_id, session_id, phase) to prevent replays
type ReplayProtectionState struct {
	LastNonce    uint64
	LastHash     string
	MessageCount uint64
	FirstSeen    time.Time
	LastSeen     time.Time
}

// PhaseTransitionAuditInfo captures details of phase changes
type PhaseTransitionAuditInfo struct {
	OldPhase         CeremonyPhase `json:"old_phase"`
	NewPhase         CeremonyPhase `json:"new_phase"`
	ParticipantCount int           `json:"participant_count"`
	ExpectedCount    int           `json:"expected_count"`
	TransitionTime   time.Time     `json:"transition_time"`
}

// HardenedCeremonyCoordinator extends CeremonyCoordinator with security hardening
type HardenedCeremonyCoordinator struct {
	*CeremonyCoordinator

	// Singer's private key for signing messages
	signerPrivateKey *ecdsa.PrivateKey

	// Replay protection state: map[sender_id][session_id][phase] -> ReplayProtectionState
	replayState map[string]map[string]map[CeremonyPhase]ReplayProtectionState
	replayMutex sync.RWMutex

	// Phase-specific entropy hashes for replay detection
	phaseHashes map[CeremonyPhase][]byte
	phaseMutex  sync.RWMutex

	// Audit event log
	auditLog []AuditEvent
	auditMutex sync.RWMutex

	// Maximum time allowed between message signing and receipt (5 minutes)
	maxClockSkew time.Duration

	// Verify signatures for all messages
	verifySignatures bool

	// Known party public keys: map[party_id] -> public_key
	partyPublicKeys map[string]*ecdsa.PublicKey
	keysMutex       sync.RWMutex
}

// NewHardenedCeremonyCoordinator creates a new hardened ceremony coordinator
func NewHardenedCeremonyCoordinator(
	baseCoordinator *CeremonyCoordinator,
	signerPrivateKey *ecdsa.PrivateKey,
	verifySignatures bool,
) *HardenedCeremonyCoordinator {
	return &HardenedCeremonyCoordinator{
		CeremonyCoordinator: baseCoordinator,
		signerPrivateKey:    signerPrivateKey,
		replayState:         make(map[string]map[string]map[CeremonyPhase]ReplayProtectionState]),
		phaseHashes:         make(map[CeremonyPhase][]byte),
		auditLog:            make([]AuditEvent, 0),
		maxClockSkew:        5 * time.Minute,
		verifySignatures:    verifySignatures,
		partyPublicKeys:     make(map[string]*ecdsa.PublicKey),
	}
}

// RegisterPartyPublicKey registers a party's public key for verification
func (h *HardenedCeremonyCoordinator) RegisterPartyPublicKey(
	partyID string,
	publicKey *ecdsa.PublicKey,
) error {
	if partyID == "" || publicKey == nil {
		return errors.New("invalid party ID or public key")
	}

	h.keysMutex.Lock()
	defer h.keysMutex.Unlock()

	h.partyPublicKeys[partyID] = publicKey
	return nil
}

// SignCeremonyMessage signs a ceremony message with cryptographic proof
func (h *HardenedCeremonyCoordinator) SignCeremonyMessage(
	msg *CeremonyMessage,
) (*HardenedCeremonyMessage, error) {
	if h.signerPrivateKey == nil {
		return nil, errors.New("signer private key not configured")
	}

	// Compute message digest: SHA256(type || phase || session_id || sender_id || payload || timestamp)
	digest := h.computeMessageDigest(msg)

	// Sign digest with ECDSA
	r, s, err := ecdsa.Sign(rand.Reader, h.signerPrivateKey, digest[:])
	if err != nil {
		return nil, errors.Wrap(err, "failed to sign message")
	}

	signature := append(r.Bytes(), s.Bytes()...)

	// Generate replay nonce (monotonically increasing per sender/session/phase)
	replayNonce := h.getNextReplayNonce(msg.SenderID, msg.SessionID, msg.Phase)

	// Compute phase hash (entropy unique to this phase)
	phaseHash := h.getPhaseHash(msg.Phase)

	// Create hardened message
	hardenedMsg := &HardenedCeremonyMessage{
		Message:         msg,
		MessageSignature: signature,
		SenderPublicKey: h.encodePublicKey(&h.signerPrivateKey.PublicKey),
		ReplayNonce:     replayNonce,
		PhaseHash:       phaseHash,
		SignedTimestamp: time.Now().Unix(),
	}

	// Log audit event
	h.logAuditEvent(&AuditEvent{
		EventType:   AuditMessageValidated,
		SessionID:   msg.SessionID,
		Timestamp:   time.Now(),
		PartyID:     msg.SenderID,
		Phase:       msg.Phase,
		Message:     "Message signed and ready for broadcast",
	})

	return hardenedMsg, nil
}

// VerifyHardenedMessage verifies a hardened message for authenticity and replay attacks
func (h *HardenedCeremonyCoordinator) VerifyHardenedMessage(
	hardenedMsg *HardenedCeremonyMessage,
) error {
	if hardenedMsg == nil || hardenedMsg.Message == nil {
		return errors.New("invalid hardened message")
	}

	msg := hardenedMsg.Message

	// 1. Check timestamp is not too far in past or future (clock skew detection)
	timeDiff := time.Since(time.Unix(hardenedMsg.SignedTimestamp, 0)).Abs()
	if timeDiff > h.maxClockSkew {
		h.logAuditEvent(&AuditEvent{
			EventType:   AuditTimeViolation,
			SessionID:   msg.SessionID,
			Timestamp:   time.Now(),
			PartyID:     msg.SenderID,
			Phase:       msg.Phase,
			Message:     fmt.Sprintf("Message timestamp outside acceptable window: %v", timeDiff),
		})
		return errors.New("message timestamp outside acceptable clock skew window")
	}

	// 2. Detect replay attacks (check nonce monotonicity)
	if err := h.checkReplayNonce(msg.SenderID, msg.SessionID, msg.Phase, hardenedMsg.ReplayNonce); err != nil {
		h.logAuditEvent(&AuditEvent{
			EventType:   AuditReplayDetected,
			SessionID:   msg.SessionID,
			Timestamp:   time.Now(),
			PartyID:     msg.SenderID,
			Phase:       msg.Phase,
			Message:     err.Error(),
		})
		return err
	}

	// 3. Verify message signature
	if h.verifySignatures {
		if err := h.verifyMessageSignature(msg, hardenedMsg); err != nil {
			h.logAuditEvent(&AuditEvent{
				EventType:   AuditInvalidSignature,
				SessionID:   msg.SessionID,
				Timestamp:   time.Now(),
				PartyID:     msg.SenderID,
				Phase:       msg.Phase,
				Message:     err.Error(),
			})
			return err
		}
	}

	// 4. Verify phase hash (prevents phase substitution attacks)
	if !h.verifyPhaseHash(msg.Phase, hardenedMsg.PhaseHash) {
		h.logAuditEvent(&AuditEvent{
			EventType:   AuditPhaseViolation,
			SessionID:   msg.SessionID,
			Timestamp:   time.Now(),
			PartyID:     msg.SenderID,
			Phase:       msg.Phase,
			Message:     "Phase hash mismatch - possible phase substitution attack",
		})
		return errors.New("phase hash verification failed")
	}

	// 5. Log successful validation
	h.logAuditEvent(&AuditEvent{
		EventType:   AuditMessageReceived,
		SessionID:   msg.SessionID,
		Timestamp:   time.Now(),
		PartyID:     msg.SenderID,
		Phase:       msg.Phase,
		Message:     fmt.Sprintf("Message verified: nonce=%d", hardenedMsg.ReplayNonce),
	})

	return nil
}

// TransitionPhase safely transitions ceremony to next phase with audit logging
func (h *HardenedCeremonyCoordinator) TransitionPhase(
	sessionID string,
	fromPhase CeremonyPhase,
	toPhase CeremonyPhase,
	participantCount int,
) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Verify current phase matches expected
	if h.currentPhase != fromPhase {
		return errors.Errorf("phase mismatch: expected %s, got %s", fromPhase, h.currentPhase)
	}

	// Generate new phase hash for next phase
	phaseHash := h.generatePhaseHash(toPhase)
	h.phaseMutex.Lock()
	h.phaseHashes[toPhase] = phaseHash
	h.phaseMutex.Unlock()

	// Update phase
	h.currentPhase = toPhase

	// Log phase transition
	transitionInfo := PhaseTransitionAuditInfo{
		OldPhase:         fromPhase,
		NewPhase:         toPhase,
		ParticipantCount: participantCount,
		ExpectedCount:    h.config.TotalParties,
		TransitionTime:   time.Now(),
	}

	details, _ := json.Marshal(transitionInfo)
	h.logAuditEvent(&AuditEvent{
		EventType:   AuditPhaseTransition,
		SessionID:   sessionID,
		Timestamp:   time.Now(),
		PartyID:     h.config.PartyID,
		Phase:       toPhase,
		Message:     fmt.Sprintf("Transitioned from %s to %s", fromPhase, toPhase),
		Details:     details,
	})

	return nil
}

// CeremonyCompleted logs ceremony completion with audit trail
func (h *HardenedCeremonyCoordinator) CeremonyCompleted(sessionID string, ceremonyType CeremonyType) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.logAuditEvent(&AuditEvent{
		EventType:   AuditCeremonyCompleted,
		SessionID:   sessionID,
		Timestamp:   time.Now(),
		PartyID:     h.config.PartyID,
		Phase:       PhaseComplete,
		Message:     fmt.Sprintf("MPC %s ceremony completed successfully", ceremonyType),
	})

	return nil
}

// CeremonyFailed logs ceremony failure with root cause
func (h *HardenedCeremonyCoordinator) CeremonyFailed(sessionID string, reason string) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.logAuditEvent(&AuditEvent{
		EventType:   AuditCeremonyFailed,
		SessionID:   sessionID,
		Timestamp:   time.Now(),
		PartyID:     h.config.PartyID,
		Phase:       PhaseFailed,
		Message:     fmt.Sprintf("MPC ceremony failed: %s", reason),
	})

	return nil
}

// LogKeyShareStored logs when a key share is stored (for compliance)
func (h *HardenedCeremonyCoordinator) LogKeyShareStored(sessionID string, partyID string) error {
	h.logAuditEvent(&AuditEvent{
		EventType:   AuditKeyShareStored,
		SessionID:   sessionID,
		Timestamp:   time.Now(),
		PartyID:     partyID,
		Message:     fmt.Sprintf("Key share stored securely for session %s", sessionID),
	})

	return nil
}

// GetAuditLog retrieves the complete audit log for a session
func (h *HardenedCeremonyCoordinator) GetAuditLog(sessionID string) []AuditEvent {
	h.auditMutex.RLock()
	defer h.auditMutex.RUnlock()

	var sessionAudit []AuditEvent
	for _, event := range h.auditLog {
		if event.SessionID == sessionID {
			sessionAudit = append(sessionAudit, event)
		}
	}

	return sessionAudit
}

// GetAuditLogHash returns SHA256(all audit events) for integrity verification
func (h *HardenedCeremonyCoordinator) GetAuditLogHash(sessionID string) ([]byte, error) {
	auditEvents := h.GetAuditLog(sessionID)
	
	hash := sha256.New()
	for _, event := range auditEvents {
		eventData, err := json.Marshal(event)
		if err != nil {
			return nil, errors.Wrap(err, "failed to marshal audit event")
		}
		hash.Write(eventData)
	}

	return hash.Sum(nil), nil
}

// ═════════════════════════════════════════════════════════════════════════
// Private helper methods
// ═════════════════════════════════════════════════════════════════════════

// computeMessageDigest computes SHA256 of standardized message format
func (h *HardenedCeremonyCoordinator) computeMessageDigest(msg *CeremonyMessage) [32]byte {
	data := fmt.Sprintf("%s||%s||%s||%s||%s||%d",
		msg.Type,
		msg.Phase,
		msg.SessionID,
		msg.SenderID,
		string(msg.Payload),
		msg.Timestamp,
	)
	return sha256.Sum256([]byte(data))
}

// getNextReplayNonce returns monotonically increasing nonce for (sender, session, phase)
func (h *HardenedCeremonyCoordinator) getNextReplayNonce(
	senderID string,
	sessionID string,
	phase CeremonyPhase,
) uint64 {
	h.replayMutex.Lock()
	defer h.replayMutex.Unlock()

	if _, ok := h.replayState[senderID]; !ok {
		h.replayState[senderID] = make(map[string]map[CeremonyPhase]ReplayProtectionState)
	}
	if _, ok := h.replayState[senderID][sessionID]; !ok {
		h.replayState[senderID][sessionID] = make(map[CeremonyPhase]ReplayProtectionState)
	}

	state := h.replayState[senderID][sessionID][phase]
	state.LastNonce++
	state.MessageCount++
	state.LastSeen = time.Now()
	if state.FirstSeen.IsZero() {
		state.FirstSeen = time.Now()
	}

	h.replayState[senderID][sessionID][phase] = state

	return state.LastNonce
}

// checkReplayNonce verifies nonce is monotonically increasing and valid
func (h *HardenedCeremonyCoordinator) checkReplayNonce(
	senderID string,
	sessionID string,
	phase CeremonyPhase,
	nonce uint64,
) error {
	h.replayMutex.RLock()
	defer h.replayMutex.RUnlock()

	state, ok := h.replayState[senderID][sessionID][phase]
	if !ok {
		// First message from this sender/session/phase
		return nil
	}

	if nonce <= state.LastNonce {
		return errors.Errorf("replay detected: nonce %d <= last %d", nonce, state.LastNonce)
	}

	// Detect if nonce jumps too far (possible clock skew or forgery)
	if nonce > state.LastNonce+1000 {
		return errors.Errorf("nonce gap too large: %d", nonce-state.LastNonce)
	}

	return nil
}

// generatePhaseHash generates random entropy hash for a phase
func (h *HardenedCeremonyCoordinator) generatePhaseHash(phase CeremonyPhase) []byte {
	entropy := make([]byte, 32)
	rand.Read(entropy)

	hash := sha256.Sum256(append([]byte(phase), entropy...))
	return hash[:]
}

// getPhaseHash returns current phase hash
func (h *HardenedCeremonyCoordinator) getPhaseHash(phase CeremonyPhase) []byte {
	h.phaseMutex.RLock()
	defer h.phaseMutex.RUnlock()

	if hash, ok := h.phaseHashes[phase]; ok {
		return hash
	}

	// Generate if not exists
	hash := h.generatePhaseHash(phase)
	h.phaseMutex.Lock()
	h.phaseHashes[phase] = hash
	h.phaseMutex.Unlock()

	return hash
}

// verifyPhaseHash checks if phase hash matches expected value
func (h *HardenedCeremonyCoordinator) verifyPhaseHash(phase CeremonyPhase, phaseHash []byte) bool {
	h.phaseMutex.RLock()
	defer h.phaseMutex.RUnlock()

	expectedHash, ok := h.phaseHashes[phase]
	if !ok {
		return false
	}

	return string(expectedHash) == string(phaseHash)
}

// verifyMessageSignature verifies ECDSA signature of message
func (h *HardenedCeremonyCoordinator) verifyMessageSignature(
	msg *CeremonyMessage,
	hardenedMsg *HardenedCeremonyMessage,
) error {
	// Get sender's public key
	h.keysMutex.RLock()
	senderKey, ok := h.partyPublicKeys[msg.SenderID]
	h.keysMutex.RUnlock()

	if !ok && h.verifySignatures {
		return errors.Errorf("unknown party: %s", msg.SenderID)
	}

	if senderKey == nil {
		return errors.New("sender public key not available")
	}

	// Parse signature (first 32 bytes = R, next 32 bytes = S)
	if len(hardenedMsg.MessageSignature) != 64 {
		return errors.New("invalid signature length")
	}

	r := new(big.Int).SetBytes(hardenedMsg.MessageSignature[:32])
	s := new(big.Int).SetBytes(hardenedMsg.MessageSignature[32:])

	// Compute message digest
	digest := h.computeMessageDigest(msg)

	// Verify signature
	if !ecdsa.Verify(senderKey, digest[:], r, s) {
		return errors.New("signature verification failed")
	}

	return nil
}

// encodePublicKey serializes ECDSA public key
func (h *HardenedCeremonyCoordinator) encodePublicKey(pubKey *ecdsa.PublicKey) []byte {
	return append(pubKey.X.Bytes(), pubKey.Y.Bytes()...)
}

// logAuditEvent appends event to audit log with hash for tampering detection
func (h *HardenedCeremonyCoordinator) logAuditEvent(event *AuditEvent) {
	// Compute event hash
	eventData, _ := json.Marshal(event)
	eventHash := sha256.Sum256(eventData)
	event.Hash = eventHash[:]

	h.auditMutex.Lock()
	defer h.auditMutex.Unlock()

	h.auditLog = append(h.auditLog, *event)
}

// ExportAuditTrail exports audit trail for external compliance systems
func (h *HardenedCeremonyCoordinator) ExportAuditTrail(sessionID string) (string, error) {
	auditEvents := h.GetAuditLog(sessionID)

	auditTrail := struct {
		SessionID   string       `json:"session_id"`
		Events      []AuditEvent `json:"events"`
		ExportedAt  time.Time    `json:"exported_at"`
		EventCount  int          `json:"event_count"`
		TrailHash   string       `json:"trail_hash"`
	}{
		SessionID:  sessionID,
		Events:     auditEvents,
		ExportedAt: time.Now(),
		EventCount: len(auditEvents),
	}

	// Compute trail hash
	data, _ := json.Marshal(auditEvents)
	hash := sha256.Sum256(data)
	auditTrail.TrailHash = hex.EncodeToString(hash[:])

	jsonData, err := json.MarshalIndent(auditTrail, "", "  ")
	if err != nil {
		return "", errors.Wrap(err, "failed to marshal audit trail")
	}

	return string(jsonData), nil
}
