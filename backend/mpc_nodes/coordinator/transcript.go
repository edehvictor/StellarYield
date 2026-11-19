package coordinator

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
)

// transcriptDomain separates transcript hashes from every other hash the
// protocol produces, preventing cross-protocol collision or replay of a
// message digest as a transcript record.
const transcriptDomain = "stellaryield/mpc/ceremony-transcript/v1"

// zeroPrevHash seeds the hash chain for the first record in a transcript.
const zeroPrevHash = "0000000000000000000000000000000000000000000000000000000000000000"

// Transcript direction values.
const (
	TranscriptDirectionSent     = "SENT"
	TranscriptDirectionReceived = "RECEIVED"
)

// TranscriptRecord is one tamper-evident entry in the ceremony transcript.
//
// It deliberately carries NO payload bytes: the round message payload is
// represented only by its SHA-256 digest, so secret shares committed or
// revealed during the ceremony can never be reconstructed from an exported
// transcript (#1531).
type TranscriptRecord struct {
	Sequence      uint64        `json:"sequence"`
	Direction     string        `json:"direction"`
	Type          CeremonyType  `json:"type"`
	Phase         CeremonyPhase `json:"phase"`
	SessionID     string        `json:"session_id"`
	SenderID      string        `json:"sender_id"`
	Timestamp     int64         `json:"timestamp"`
	PayloadDigest string        `json:"payload_digest"`
	PrevHash      string        `json:"prev_hash"`
	RecordHash    string        `json:"record_hash"`
}

// TranscriptRecorder accumulates transcript records for one ceremony and
// maintains a SHA-256 hash chain over them. It is safe for concurrent use.
type TranscriptRecorder struct {
	records []TranscriptRecord
	mu      sync.RWMutex
}

// NewTranscriptRecorder creates an empty transcript recorder.
func NewTranscriptRecorder() *TranscriptRecorder {
	return &TranscriptRecorder{records: make([]TranscriptRecord, 0)}
}

// transcriptDigest computes the domain-separated digest of a round message
// payload. The payload itself is never retained — only this digest is.
func transcriptDigest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// computeRecordHash deterministically encodes a record's fields together with
// the previous chain hash and returns the SHA-256 of that encoding. Field
// order and separators are fixed so identical inputs always hash identically.
func computeRecordHash(rec TranscriptRecord) string {
	encoding := fmt.Sprintf(
		"%s\nseq=%d\ndir=%s\ntype=%s\nphase=%s\nsession=%s\nsender=%s\nts=%d\npayload=%s\nprev=%s",
		transcriptDomain,
		rec.Sequence,
		rec.Direction,
		rec.Type,
		rec.Phase,
		rec.SessionID,
		rec.SenderID,
		rec.Timestamp,
		rec.PayloadDigest,
		rec.PrevHash,
	)
	sum := sha256.Sum256([]byte(encoding))
	return hex.EncodeToString(sum[:])
}

// Record appends a transcript entry for the given round message in the given
// direction. Only metadata and the payload digest are stored; the payload is
// never retained.
func (t *TranscriptRecorder) Record(msg *CeremonyMessage, direction string) TranscriptRecord {
	t.mu.Lock()
	defer t.mu.Unlock()

	prevHash := zeroPrevHash
	if n := len(t.records); n > 0 {
		prevHash = t.records[n-1].RecordHash
	}

	rec := TranscriptRecord{
		Sequence:      uint64(len(t.records)),
		Direction:     direction,
		Type:          msg.Type,
		Phase:         msg.Phase,
		SessionID:     msg.SessionID,
		SenderID:      msg.SenderID,
		Timestamp:     msg.Timestamp,
		PayloadDigest: transcriptDigest(msg.Payload),
		PrevHash:      prevHash,
	}
	rec.RecordHash = computeRecordHash(rec)

	t.records = append(t.records, rec)
	return rec
}

// Records returns a copy of the transcript records recorded so far.
func (t *TranscriptRecorder) Records() []TranscriptRecord {
	t.mu.RLock()
	defer t.mu.RUnlock()

	out := make([]TranscriptRecord, len(t.records))
	copy(out, t.records)
	return out
}

// TranscriptHash returns the hash-chain tip, i.e. the RecordHash of the most
// recent entry (or the zero seed for an empty transcript). Auditors can pin
// this single value to detect any later alteration of the transcript.
func (t *TranscriptRecorder) TranscriptHash() string {
	t.mu.RLock()
	defer t.mu.RUnlock()

	if n := len(t.records); n > 0 {
		return t.records[n-1].RecordHash
	}
	return zeroPrevHash
}

// Verify recomputes the hash chain over all records and reports the first
// inconsistency, giving auditors a self-contained integrity check.
func (t *TranscriptRecorder) Verify() error {
	t.mu.RLock()
	defer t.mu.RUnlock()

	prevHash := zeroPrevHash
	for i, rec := range t.records {
		if rec.PrevHash != prevHash {
			return fmt.Errorf("transcript record %d: broken chain link (prev hash mismatch)", i)
		}
		if rec.PayloadDigest == "" || len(rec.PayloadDigest) != 64 {
			return fmt.Errorf("transcript record %d: malformed payload digest", i)
		}
		if computeRecordHash(rec) != rec.RecordHash {
			return fmt.Errorf("transcript record %d: record hash mismatch (tampered?)", i)
		}
		prevHash = rec.RecordHash
	}
	return nil
}

// ExportJSON renders the transcript as indented JSON suitable for audit
// export. The output contains no payload bytes or secret material — only
// metadata, digests, and chain hashes.
func (t *TranscriptRecorder) ExportJSON() (string, error) {
	records := t.Records()

	export := struct {
		Domain         string             `json:"domain"`
		EventCount     int                `json:"event_count"`
		TranscriptHash string             `json:"transcript_hash"`
		Records        []TranscriptRecord `json:"records"`
	}{
		Domain:         transcriptDomain,
		EventCount:     len(records),
		TranscriptHash: t.TranscriptHash(),
		Records:        records,
	}

	data, err := json.MarshalIndent(export, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal transcript: %w", err)
	}
	return string(data), nil
}
