package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pkg/errors"
	"github.com/stellar/go/keypair"
	"github.com/stellaryield/mpc_nodes/storage"
)

// DefaultMaxMessageAge bounds how far a participant message timestamp may
// drift from the node clock before it is rejected as stale.
const DefaultMaxMessageAge = 5 * time.Minute

const participantMessageDomain = "stellaryield/mpc-node-message/v1"

// participantMessageKey is the gin context key holding the verified message.
const participantMessageKey = "participant_message"

var (
	// ErrParticipantsNotConfigured is returned when no participant set is loaded.
	ErrParticipantsNotConfigured = errors.New("participant set is not configured")
	// ErrUnknownParticipant is returned for senders outside the participant set.
	ErrUnknownParticipant = errors.New("sender is not a configured participant")
	// ErrRevokedParticipant is returned for senders whose access was revoked.
	ErrRevokedParticipant = errors.New("sender has been revoked")
	// ErrInvalidMessageSignature is returned when the sender signature does not verify.
	ErrInvalidMessageSignature = errors.New("message signature is invalid")
	// ErrStaleMessage is returned when the message timestamp is outside the allowed window.
	ErrStaleMessage = errors.New("message timestamp is outside the allowed window")
)

// Participant is one configured MPC node identity.
type Participant struct {
	// ID is the party identifier carried as sender_id in messages.
	ID string `json:"id"`
	// PublicKey is the participant's Stellar (ed25519) public key, G...
	PublicKey string `json:"public_key"`
	// Revoked marks a participant that may no longer send messages.
	Revoked bool `json:"revoked"`
}

type participantEntry struct {
	key     *keypair.FromAddress
	revoked bool
}

// ParticipantRegistry is the authoritative set of MPC participants whose
// signed messages this node accepts.
type ParticipantRegistry struct {
	mu           sync.RWMutex
	participants map[string]*participantEntry
}

// NewParticipantRegistry builds a registry from the configured participants.
func NewParticipantRegistry(participants []Participant) (*ParticipantRegistry, error) {
	if len(participants) == 0 {
		return nil, errors.New("participant set must not be empty")
	}

	r := &ParticipantRegistry{participants: make(map[string]*participantEntry, len(participants))}
	for _, p := range participants {
		if p.ID == "" {
			return nil, errors.New("participant id must not be empty")
		}
		if _, dup := r.participants[p.ID]; dup {
			return nil, errors.Errorf("duplicate participant id %q", p.ID)
		}
		key, err := keypair.ParseAddress(p.PublicKey)
		if err != nil {
			return nil, errors.Wrapf(err, "invalid public key for participant %q", p.ID)
		}
		r.participants[p.ID] = &participantEntry{key: key, revoked: p.Revoked}
	}
	return r, nil
}

// LoadParticipantRegistry reads a JSON array of Participant from path.
func LoadParticipantRegistry(path string) (*ParticipantRegistry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read participants file")
	}
	var participants []Participant
	if err := json.Unmarshal(data, &participants); err != nil {
		return nil, errors.Wrap(err, "failed to parse participants file")
	}
	return NewParticipantRegistry(participants)
}

// Revoke marks a participant as revoked; subsequent messages are rejected.
func (r *ParticipantRegistry) Revoke(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.participants[id]
	if !ok {
		return ErrUnknownParticipant
	}
	entry.revoked = true
	return nil
}

// ParticipantMessage is the signed envelope every ceremony message carries.
type ParticipantMessage struct {
	SessionID string          `json:"session_id" binding:"required"`
	SenderID  string          `json:"sender_id" binding:"required"`
	Timestamp int64           `json:"timestamp" binding:"required"`
	Payload   json.RawMessage `json:"payload"`
	// Signature is the base64 ed25519 signature over ParticipantMessageDigest.
	Signature string `json:"signature" binding:"required"`
}

// ParticipantMessageDigest is the hash a sender signs. It binds the message
// to the API route so a commit cannot be replayed as a reveal.
func ParticipantMessageDigest(route string, msg *ParticipantMessage) []byte {
	h := sha256.New()
	fmt.Fprintf(h, "%s\n%s\n%s\n%s\n%d\n", participantMessageDomain, route, msg.SessionID, msg.SenderID, msg.Timestamp)
	h.Write(msg.Payload)
	return h.Sum(nil)
}

// SignParticipantMessage signs msg for route with the sender's key.
func SignParticipantMessage(kp *keypair.Full, route string, msg *ParticipantMessage) error {
	sig, err := kp.Sign(ParticipantMessageDigest(route, msg))
	if err != nil {
		return err
	}
	msg.Signature = base64.StdEncoding.EncodeToString(sig)
	return nil
}

// Verify authenticates msg as coming from a current participant.
func (r *ParticipantRegistry) Verify(route string, msg *ParticipantMessage, now time.Time, maxAge time.Duration) error {
	r.mu.RLock()
	entry, ok := r.participants[msg.SenderID]
	var revoked bool
	if ok {
		revoked = entry.revoked
	}
	r.mu.RUnlock()

	if !ok {
		return ErrUnknownParticipant
	}
	if revoked {
		return ErrRevokedParticipant
	}

	sig, err := base64.StdEncoding.DecodeString(msg.Signature)
	if err != nil {
		return ErrInvalidMessageSignature
	}
	if err := entry.key.Verify(ParticipantMessageDigest(route, msg), sig); err != nil {
		return ErrInvalidMessageSignature
	}

	if maxAge > 0 {
		age := now.Sub(time.Unix(msg.Timestamp, 0))
		if age > maxAge || age < -maxAge {
			return ErrStaleMessage
		}
	}
	return nil
}

// requireParticipant authenticates the request body as a ParticipantMessage
// from the configured participant set before the handler runs.
func (s *Server) requireParticipant(c *gin.Context) {
	route := c.FullPath()

	if s.config.Participants == nil {
		s.rejectParticipantMessage(c, route, "", http.StatusServiceUnavailable, "PARTICIPANTS_NOT_CONFIGURED", ErrParticipantsNotConfigured)
		return
	}

	var msg ParticipantMessage
	if err := c.ShouldBindJSON(&msg); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	maxAge := s.config.MaxMessageAge
	if maxAge == 0 {
		maxAge = DefaultMaxMessageAge
	}

	err := s.config.Participants.Verify(route, &msg, time.Now(), maxAge)
	switch {
	case err == nil:
		c.Set(participantMessageKey, &msg)
		c.Next()
	case errors.Is(err, ErrUnknownParticipant):
		s.rejectParticipantMessage(c, route, msg.SenderID, http.StatusForbidden, "UNKNOWN_PARTICIPANT", err)
	case errors.Is(err, ErrRevokedParticipant):
		s.rejectParticipantMessage(c, route, msg.SenderID, http.StatusForbidden, "PARTICIPANT_REVOKED", err)
	case errors.Is(err, ErrStaleMessage):
		s.rejectParticipantMessage(c, route, msg.SenderID, http.StatusUnauthorized, "STALE_MESSAGE", err)
	default:
		s.rejectParticipantMessage(c, route, msg.SenderID, http.StatusUnauthorized, "INVALID_SIGNATURE", err)
	}
}

func (s *Server) rejectParticipantMessage(c *gin.Context, route, senderID string, status int, code string, err error) {
	if s.service != nil && s.service.audit != nil {
		s.service.audit.Log(&storage.AuditLogEntry{
			Timestamp:    time.Now(),
			Action:       "PARTICIPANT_MESSAGE_REJECTED",
			PartyID:      senderID,
			IPAddress:    c.ClientIP(),
			UserAgent:    c.Request.UserAgent(),
			Success:      false,
			ErrorMessage: fmt.Sprintf("%s %s: %v", code, route, err),
		})
	}
	c.AbortWithStatusJSON(status, APIResponse{
		Success: false,
		Error:   err.Error(),
		Code:    code,
	})
}

// participantMessage returns the verified message set by requireParticipant.
func participantMessage(c *gin.Context) *ParticipantMessage {
	msg, _ := c.Get(participantMessageKey)
	m, _ := msg.(*ParticipantMessage)
	return m
}
