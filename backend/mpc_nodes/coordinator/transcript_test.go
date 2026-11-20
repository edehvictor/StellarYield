package coordinator

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/stellaryield/mpc_nodes/storage"
)

// fixedRevealMessage builds a key-gen reveal round message whose payload
// embeds a known secret share, at a fixed timestamp so hashes are stable.
func fixedRevealMessage(t *testing.T, partyID string, secret *big.Int) *CeremonyMessage {
	t.Helper()

	payload := mustMarshal(KeyGenRevealPayload{
		PartyID:   partyID,
		Share:     secret,
		Nonce:     []byte{0x01, 0x02, 0x03, 0x04},
		PublicKey: []byte{0x09, 0x0a},
	})

	return &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseReveal,
		SessionID: "session-fixed-0001",
		SenderID:  partyID,
		Payload:   payload,
		Timestamp: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC).Unix(),
	}
}

func fixedCommitMessage(partyID string) *CeremonyMessage {
	return &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseCommit,
		SessionID: "session-fixed-0001",
		SenderID:  partyID,
		Payload:   mustMarshal(KeyGenCommitPayload{PartyID: partyID, Commitment: []byte{0xaa, 0xbb}}),
		Timestamp: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC).Unix(),
	}
}

func testSecretShare() *big.Int {
	return new(big.Int).SetBytes(bytes.Repeat([]byte{0xab, 0xcd}, 16))
}

func TestTranscriptDeterminism(t *testing.T) {
	secret := testSecretShare()

	build := func() *TranscriptRecorder {
		rec := NewTranscriptRecorder()
		rec.Record(fixedCommitMessage("party-1"), TranscriptDirectionSent)
		rec.Record(fixedRevealMessage(t, "party-1", secret), TranscriptDirectionReceived)
		rec.Record(fixedCommitMessage("party-2"), TranscriptDirectionReceived)
		return rec
	}

	first := build()
	second := build()

	if first.TranscriptHash() != second.TranscriptHash() {
		t.Fatalf("identical round messages produced different transcript hashes:\n%s\n%s",
			first.TranscriptHash(), second.TranscriptHash())
	}

	firstRecords := first.Records()
	secondRecords := second.Records()
	if len(firstRecords) != 3 || len(secondRecords) != 3 {
		t.Fatalf("expected 3 records in each transcript, got %d and %d",
			len(firstRecords), len(secondRecords))
	}

	firstJSON, err := json.Marshal(firstRecords)
	if err != nil {
		t.Fatalf("failed to marshal records: %v", err)
	}
	secondJSON, err := json.Marshal(secondRecords)
	if err != nil {
		t.Fatalf("failed to marshal records: %v", err)
	}
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("record contents differ across identical inputs:\n%s\n%s", firstJSON, secondJSON)
	}
}

func TestTranscriptDiffersForDifferentMessages(t *testing.T) {
	secret := testSecretShare()

	recA := NewTranscriptRecorder()
	recA.Record(fixedRevealMessage(t, "party-1", secret), TranscriptDirectionReceived)

	recB := NewTranscriptRecorder()
	recB.Record(fixedRevealMessage(t, "party-2", secret), TranscriptDirectionReceived)

	if recA.TranscriptHash() == recB.TranscriptHash() {
		t.Fatal("different senders must produce different transcript hashes")
	}

	recC := NewTranscriptRecorder()
	recC.Record(fixedRevealMessage(t, "party-1", big.NewInt(42)), TranscriptDirectionReceived)
	if recA.TranscriptHash() == recC.TranscriptHash() {
		t.Fatal("different secret shares must produce different transcript hashes")
	}
}

func TestTranscriptRedactsSecretShares(t *testing.T) {
	secret := testSecretShare()
	secretDecimal := secret.String()
	secretHex := hex.EncodeToString(secret.Bytes())

	rec := NewTranscriptRecorder()
	rec.Record(fixedRevealMessage(t, "party-1", secret), TranscriptDirectionReceived)

	exported, err := rec.ExportJSON()
	if err != nil {
		t.Fatalf("failed to export transcript: %v", err)
	}

	if strings.Contains(exported, secretDecimal) {
		t.Fatal("exported transcript leaks the secret share in decimal form")
	}
	if strings.Contains(exported, secretHex) {
		t.Fatal("exported transcript leaks the secret share in hex form")
	}

	// The digest of the full payload must be present so auditors can still
	// verify that two observations saw the identical round message.
	records := rec.Records()
	payloadDigest := transcriptDigest(fixedRevealMessage(t, "party-1", secret).Payload)
	if records[0].PayloadDigest != payloadDigest {
		t.Fatalf("payload digest mismatch: got %s want %s", records[0].PayloadDigest, payloadDigest)
	}
	if !strings.Contains(exported, payloadDigest) {
		t.Fatal("exported transcript should contain the payload digest")
	}
}

func TestTranscriptHashChain(t *testing.T) {
	rec := NewTranscriptRecorder()
	rec.Record(fixedCommitMessage("party-1"), TranscriptDirectionSent)
	rec.Record(fixedCommitMessage("party-2"), TranscriptDirectionReceived)
	rec.Record(fixedCommitMessage("party-3"), TranscriptDirectionSent)

	if err := rec.Verify(); err != nil {
		t.Fatalf("fresh transcript failed verification: %v", err)
	}

	records := rec.Records()
	if records[0].PrevHash != zeroPrevHash {
		t.Fatalf("first record must chain from the zero seed, got %s", records[0].PrevHash)
	}
	for i := 1; i < len(records); i++ {
		if records[i].PrevHash != records[i-1].RecordHash {
			t.Fatalf("record %d does not chain from record %d", i, i-1)
		}
	}
	if rec.TranscriptHash() != records[len(records)-1].RecordHash {
		t.Fatal("transcript hash must equal the chain tip")
	}
}

func TestTranscriptVerifyDetectsTampering(t *testing.T) {
	rec := NewTranscriptRecorder()
	rec.Record(fixedCommitMessage("party-1"), TranscriptDirectionSent)
	rec.Record(fixedCommitMessage("party-2"), TranscriptDirectionReceived)

	// Tamper with a record inside the recorder (same-package access).
	rec.records[1].SenderID = "party-evil"

	if err := rec.Verify(); err == nil {
		t.Fatal("verification must fail after a record is tampered with")
	}
}

func TestTranscriptEmptyRecorder(t *testing.T) {
	rec := NewTranscriptRecorder()
	if got := rec.TranscriptHash(); got != zeroPrevHash {
		t.Fatalf("empty transcript hash must be the zero seed, got %s", got)
	}
	if err := rec.Verify(); err != nil {
		t.Fatalf("empty transcript must verify: %v", err)
	}
}

func TestCoordinatorRecordsTranscriptWithoutSecrets(t *testing.T) {
	coord, err := NewCeremonyCoordinator(&CeremonyConfig{
		Threshold:    2,
		TotalParties: 3,
		PartyID:      "party-1",
		Timeout:      time.Second,
		Storage:      storage.NewMemoryStorage(),
	})
	if err != nil {
		t.Fatalf("failed to create coordinator: %v", err)
	}

	secret := testSecretShare()
	commitMsg := fixedCommitMessage("party-2")
	revealMsg := fixedRevealMessage(t, "party-2", secret)

	if err := coord.HandleMessage(commitMsg); err != nil {
		t.Fatalf("HandleMessage failed: %v", err)
	}
	if err := coord.HandleMessage(revealMsg); err != nil {
		t.Fatalf("HandleMessage failed: %v", err)
	}
	coord.broadcastMessage(fixedCommitMessage("party-1"))

	records := coord.GetTranscript().Records()
	if len(records) != 3 {
		t.Fatalf("expected 3 transcript records, got %d", len(records))
	}
	if records[0].Direction != TranscriptDirectionReceived {
		t.Fatalf("HandleMessage must record RECEIVED, got %s", records[0].Direction)
	}
	if records[2].Direction != TranscriptDirectionSent {
		t.Fatalf("broadcastMessage must record SENT, got %s", records[2].Direction)
	}

	exported, err := coord.GetTranscript().ExportJSON()
	if err != nil {
		t.Fatalf("failed to export transcript: %v", err)
	}
	if strings.Contains(exported, secret.String()) {
		t.Fatal("coordinator transcript leaks a secret share")
	}

	if err := coord.GetTranscript().Verify(); err != nil {
		t.Fatalf("coordinator transcript failed verification: %v", err)
	}
}
