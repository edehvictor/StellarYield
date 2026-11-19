package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stellar/go/keypair"
	"github.com/stellaryield/mpc_nodes/storage"
)

const (
	keygenCommitRoute  = "/api/v1/ceremony/keygen/commit"
	keygenRevealRoute  = "/api/v1/ceremony/keygen/reveal"
	signingCommitRoute = "/api/v1/ceremony/signing/commit"
	signingRevealRoute = "/api/v1/ceremony/signing/reveal"
)

type participantFixture struct {
	server  *Server
	alice   *keypair.Full
	bob     *keypair.Full
	mallory *keypair.Full
	reg     *ParticipantRegistry
}

func newParticipantFixture(t *testing.T) *participantFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)

	f := &participantFixture{
		alice:   keypair.MustRandom(),
		bob:     keypair.MustRandom(),
		mallory: keypair.MustRandom(),
	}
	reg, err := NewParticipantRegistry([]Participant{
		{ID: "alice", PublicKey: f.alice.Address()},
		{ID: "bob", PublicKey: f.bob.Address(), Revoked: true},
	})
	if err != nil {
		t.Fatalf("NewParticipantRegistry: %v", err)
	}
	f.reg = reg

	service := &MPCService{audit: storage.NewAuditLogger()}
	f.server = NewServer(&APIConfig{Participants: reg}, service)
	return f
}

func signedMessage(t *testing.T, kp *keypair.Full, sender, route string, ts time.Time) *ParticipantMessage {
	t.Helper()
	msg := &ParticipantMessage{
		SessionID: "session-1",
		SenderID:  sender,
		Timestamp: ts.Unix(),
		Payload:   json.RawMessage(`{"commitment":"abc123"}`),
	}
	if err := SignParticipantMessage(kp, route, msg); err != nil {
		t.Fatalf("SignParticipantMessage: %v", err)
	}
	return msg
}

func post(t *testing.T, s *Server, route string, body interface{}) (int, APIResponse) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)

	var resp APIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return rec.Code, resp
}

func TestKnownParticipantAccepted(t *testing.T) {
	f := newParticipantFixture(t)

	for _, route := range []string{keygenCommitRoute, keygenRevealRoute, signingCommitRoute, signingRevealRoute} {
		code, resp := post(t, f.server, route, signedMessage(t, f.alice, "alice", route, time.Now()))
		if code != http.StatusOK || !resp.Success {
			t.Fatalf("%s: expected 200, got %d %+v", route, code, resp)
		}
		data := resp.Data.(map[string]interface{})
		if data["sender_id"] != "alice" || data["session_id"] != "session-1" {
			t.Fatalf("%s: unexpected data %+v", route, data)
		}
	}
}

func TestUnknownParticipantRejected(t *testing.T) {
	f := newParticipantFixture(t)

	code, resp := post(t, f.server, keygenCommitRoute, signedMessage(t, f.mallory, "mallory", keygenCommitRoute, time.Now()))
	if code != http.StatusForbidden || resp.Code != "UNKNOWN_PARTICIPANT" {
		t.Fatalf("expected 403 UNKNOWN_PARTICIPANT, got %d %+v", code, resp)
	}
}

func TestImpersonationRejected(t *testing.T) {
	f := newParticipantFixture(t)

	// Mallory claims to be alice but signs with her own key.
	code, resp := post(t, f.server, keygenCommitRoute, signedMessage(t, f.mallory, "alice", keygenCommitRoute, time.Now()))
	if code != http.StatusUnauthorized || resp.Code != "INVALID_SIGNATURE" {
		t.Fatalf("expected 401 INVALID_SIGNATURE, got %d %+v", code, resp)
	}
}

func TestRevokedParticipantRejected(t *testing.T) {
	f := newParticipantFixture(t)

	code, resp := post(t, f.server, signingCommitRoute, signedMessage(t, f.bob, "bob", signingCommitRoute, time.Now()))
	if code != http.StatusForbidden || resp.Code != "PARTICIPANT_REVOKED" {
		t.Fatalf("expected 403 PARTICIPANT_REVOKED for configured revocation, got %d %+v", code, resp)
	}

	// Runtime revocation takes effect on the next message.
	if err := f.reg.Revoke("alice"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	code, resp = post(t, f.server, signingCommitRoute, signedMessage(t, f.alice, "alice", signingCommitRoute, time.Now()))
	if code != http.StatusForbidden || resp.Code != "PARTICIPANT_REVOKED" {
		t.Fatalf("expected 403 PARTICIPANT_REVOKED after runtime revoke, got %d %+v", code, resp)
	}

	if err := f.reg.Revoke("mallory"); err != ErrUnknownParticipant {
		t.Fatalf("expected ErrUnknownParticipant revoking unknown id, got %v", err)
	}
}

func TestTamperedMessageRejected(t *testing.T) {
	f := newParticipantFixture(t)

	tampered := signedMessage(t, f.alice, "alice", keygenCommitRoute, time.Now())
	tampered.Payload = json.RawMessage(`{"commitment":"evil"}`)
	if code, resp := post(t, f.server, keygenCommitRoute, tampered); code != http.StatusUnauthorized || resp.Code != "INVALID_SIGNATURE" {
		t.Fatalf("tampered payload: expected 401 INVALID_SIGNATURE, got %d %+v", code, resp)
	}

	session := signedMessage(t, f.alice, "alice", keygenCommitRoute, time.Now())
	session.SessionID = "session-2"
	if code, resp := post(t, f.server, keygenCommitRoute, session); code != http.StatusUnauthorized || resp.Code != "INVALID_SIGNATURE" {
		t.Fatalf("changed session: expected 401 INVALID_SIGNATURE, got %d %+v", code, resp)
	}

	// A commit signature cannot be replayed against the reveal route.
	replayed := signedMessage(t, f.alice, "alice", keygenCommitRoute, time.Now())
	if code, resp := post(t, f.server, keygenRevealRoute, replayed); code != http.StatusUnauthorized || resp.Code != "INVALID_SIGNATURE" {
		t.Fatalf("cross-route replay: expected 401 INVALID_SIGNATURE, got %d %+v", code, resp)
	}

	garbage := signedMessage(t, f.alice, "alice", keygenCommitRoute, time.Now())
	garbage.Signature = "not base64!"
	if code, resp := post(t, f.server, keygenCommitRoute, garbage); code != http.StatusUnauthorized || resp.Code != "INVALID_SIGNATURE" {
		t.Fatalf("garbage signature: expected 401 INVALID_SIGNATURE, got %d %+v", code, resp)
	}
}

func TestStaleMessageRejected(t *testing.T) {
	f := newParticipantFixture(t)

	for _, ts := range []time.Time{time.Now().Add(-10 * time.Minute), time.Now().Add(10 * time.Minute)} {
		code, resp := post(t, f.server, keygenCommitRoute, signedMessage(t, f.alice, "alice", keygenCommitRoute, ts))
		if code != http.StatusUnauthorized || resp.Code != "STALE_MESSAGE" {
			t.Fatalf("expected 401 STALE_MESSAGE for %v, got %d %+v", ts, code, resp)
		}
	}
}

func TestMissingFieldsRejected(t *testing.T) {
	f := newParticipantFixture(t)

	code, resp := post(t, f.server, keygenCommitRoute, map[string]string{"session_id": "session-1"})
	if code != http.StatusBadRequest || resp.Code != "INVALID_REQUEST" {
		t.Fatalf("expected 400 INVALID_REQUEST, got %d %+v", code, resp)
	}
}

func TestCeremonyMessagesFailClosedWithoutParticipants(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s := NewServer(&APIConfig{}, &MPCService{audit: storage.NewAuditLogger()})
	kp := keypair.MustRandom()

	code, resp := post(t, s, keygenCommitRoute, signedMessage(t, kp, "alice", keygenCommitRoute, time.Now()))
	if code != http.StatusServiceUnavailable || resp.Code != "PARTICIPANTS_NOT_CONFIGURED" {
		t.Fatalf("expected 503 PARTICIPANTS_NOT_CONFIGURED, got %d %+v", code, resp)
	}
}

func TestNewParticipantRegistryValidation(t *testing.T) {
	kp := keypair.MustRandom()
	cases := map[string][]Participant{
		"empty":        nil,
		"missing id":   {{PublicKey: kp.Address()}},
		"bad key":      {{ID: "a", PublicKey: "GNOTAKEY"}},
		"secret seed":  {{ID: "a", PublicKey: kp.Seed()}},
		"duplicate id": {{ID: "a", PublicKey: kp.Address()}, {ID: "a", PublicKey: keypair.MustRandom().Address()}},
	}
	for name, participants := range cases {
		if _, err := NewParticipantRegistry(participants); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
}

func TestLoadParticipantRegistry(t *testing.T) {
	alice := keypair.MustRandom()
	path := filepath.Join(t.TempDir(), "participants.json")
	data, _ := json.Marshal([]Participant{{ID: "alice", PublicKey: alice.Address()}})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	reg, err := LoadParticipantRegistry(path)
	if err != nil {
		t.Fatalf("LoadParticipantRegistry: %v", err)
	}
	msg := signedMessage(t, alice, "alice", keygenCommitRoute, time.Now())
	if err := reg.Verify(keygenCommitRoute, msg, time.Now(), DefaultMaxMessageAge); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}
