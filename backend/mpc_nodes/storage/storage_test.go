package storage

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pkg/errors"
	"github.com/stellaryield/mpc_nodes/tss"
)

func testKey(fill byte) []byte {
	return bytes.Repeat([]byte{fill}, 32)
}

func newFileStorage(t *testing.T, dir string, key []byte) *EncryptedStorage {
	t.Helper()
	s, err := NewEncryptedStorage(&StorageConfig{
		Type:          "encrypted_file",
		Directory:     dir,
		EncryptionKey: key,
	})
	if err != nil {
		t.Fatalf("NewEncryptedStorage: %v", err)
	}
	return s
}

func sampleShare() *tss.LocalSecretShare {
	secret, _ := new(big.Int).SetString("115792089237316195423570985008687907852837564279074904382605163141518161494337", 10)
	return &tss.LocalSecretShare{
		PartyID:     "party-1",
		SecretShare: secret,
		Commitment:  big.NewInt(987654321),
	}
}

// rewriteRecord edits the sealed record on disk to simulate tampering.
func rewriteRecord(t *testing.T, dir, sessionID string, mutate func(*EncryptedKeyShare)) {
	t.Helper()
	store := &fileRecordStore{dir: dir}
	rec, err := store.find(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	mutate(rec)
	if err := store.write(rec); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestEncryptedStorageRoundTrip(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := newFileStorage(t, dir, testKey(1))
	share := sampleShare()

	if err := s.StoreKeyShare(ctx, "session-a", share); err != nil {
		t.Fatalf("StoreKeyShare: %v", err)
	}

	// A fresh instance with the same key (e.g. after restart) can read it back.
	got, err := newFileStorage(t, dir, testKey(1)).GetKeyShare(ctx, "session-a")
	if err != nil {
		t.Fatalf("GetKeyShare: %v", err)
	}
	if got.PartyID != share.PartyID || got.SecretShare.Cmp(share.SecretShare) != 0 || got.Commitment.Cmp(share.Commitment) != 0 {
		t.Fatalf("round trip mismatch: got %+v want %+v", got, share)
	}

	ids, err := s.ListKeyShares(ctx)
	if err != nil || len(ids) != 1 || ids[0] != "session-a" {
		t.Fatalf("ListKeyShares = %v, %v", ids, err)
	}

	if err := s.DeleteKeyShare(ctx, "session-a"); err != nil {
		t.Fatalf("DeleteKeyShare: %v", err)
	}
	if _, err := s.GetKeyShare(ctx, "session-a"); !errors.Is(err, ErrKeyShareNotFound) {
		t.Fatalf("expected ErrKeyShareNotFound after delete, got %v", err)
	}
}

func TestEncryptedStorageDoesNotPersistPlaintext(t *testing.T) {
	dir := t.TempDir()
	s := newFileStorage(t, dir, testKey(1))
	share := sampleShare()
	if err := s.StoreKeyShare(context.Background(), "session-a", share); err != nil {
		t.Fatalf("StoreKeyShare: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one sealed file, got %v (%v)", entries, err)
	}
	path := filepath.Join(dir, entries[0].Name())
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), share.SecretShare.String()) {
		t.Fatal("secret share was persisted in plaintext")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("sealed share permissions = %v, want 0600", info.Mode().Perm())
	}
}

func TestEncryptedStorageWrongKey(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := newFileStorage(t, dir, testKey(1)).StoreKeyShare(ctx, "session-a", sampleShare()); err != nil {
		t.Fatalf("StoreKeyShare: %v", err)
	}

	_, err := newFileStorage(t, dir, testKey(2)).GetKeyShare(ctx, "session-a")
	if !errors.Is(err, ErrEncryptionKeyMismatch) {
		t.Fatalf("expected ErrEncryptionKeyMismatch, got %v", err)
	}

	// Even if the key fingerprint is forged, GCM authentication rejects it.
	rewriteRecord(t, dir, "session-a", func(rec *EncryptedKeyShare) {
		rec.KeyID = encryptionKeyID(testKey(2))
	})
	_, err = newFileStorage(t, dir, testKey(2)).GetKeyShare(ctx, "session-a")
	if !errors.Is(err, ErrShareIntegrity) {
		t.Fatalf("expected ErrShareIntegrity with forged key id, got %v", err)
	}
}

func TestEncryptedStorageTamperedCiphertext(t *testing.T) {
	ctx := context.Background()

	cases := map[string]func(*EncryptedKeyShare){
		"flipped ciphertext bit": func(rec *EncryptedKeyShare) {
			ct, _ := base64.StdEncoding.DecodeString(rec.EncryptedShare)
			ct[0] ^= 0x01
			rec.EncryptedShare = base64.StdEncoding.EncodeToString(ct)
		},
		"truncated ciphertext": func(rec *EncryptedKeyShare) {
			ct, _ := base64.StdEncoding.DecodeString(rec.EncryptedShare)
			rec.EncryptedShare = base64.StdEncoding.EncodeToString(ct[:len(ct)-1])
		},
		"modified nonce": func(rec *EncryptedKeyShare) {
			iv, _ := base64.StdEncoding.DecodeString(rec.IV)
			iv[0] ^= 0x01
			rec.IV = base64.StdEncoding.EncodeToString(iv)
		},
		"short nonce": func(rec *EncryptedKeyShare) {
			rec.IV = base64.StdEncoding.EncodeToString([]byte{1, 2, 3})
		},
		"rebound party id": func(rec *EncryptedKeyShare) {
			rec.PartyID = "party-2"
		},
		"invalid base64": func(rec *EncryptedKeyShare) {
			rec.EncryptedShare = "!!not-base64!!"
		},
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			s := newFileStorage(t, dir, testKey(1))
			if err := s.StoreKeyShare(ctx, "session-a", sampleShare()); err != nil {
				t.Fatalf("StoreKeyShare: %v", err)
			}
			rewriteRecord(t, dir, "session-a", mutate)

			if _, err := s.GetKeyShare(ctx, "session-a"); !errors.Is(err, ErrShareIntegrity) {
				t.Fatalf("expected ErrShareIntegrity, got %v", err)
			}
		})
	}
}

func TestEncryptedStorageRejectsShareMovedToAnotherSession(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := newFileStorage(t, dir, testKey(1))
	if err := s.StoreKeyShare(ctx, "session-a", sampleShare()); err != nil {
		t.Fatalf("StoreKeyShare: %v", err)
	}

	// Copy session-a's sealed blob into session-b's slot.
	store := &fileRecordStore{dir: dir}
	rec, _ := store.find(ctx, "session-a")
	rec.SessionID = "session-b"
	if err := store.write(rec); err != nil {
		t.Fatal(err)
	}

	if _, err := s.GetKeyShare(ctx, "session-b"); !errors.Is(err, ErrShareIntegrity) {
		t.Fatalf("expected ErrShareIntegrity for relocated share, got %v", err)
	}
}

func TestEncryptedStorageRequiresKey(t *testing.T) {
	_, err := NewEncryptedStorage(&StorageConfig{Type: "encrypted_file", Directory: t.TempDir()})
	if !errors.Is(err, ErrEncryptionKeyMissing) {
		t.Fatalf("expected ErrEncryptionKeyMissing, got %v", err)
	}

	_, err = NewEncryptedStorage(&StorageConfig{Type: "encrypted_file", Directory: t.TempDir(), EncryptionKey: []byte("short")})
	if err == nil {
		t.Fatal("expected error for short key")
	}
}

func TestEncryptedStorageSessionIDCannotEscapeDirectory(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dir := filepath.Join(root, "shares")
	s := newFileStorage(t, dir, testKey(1))

	if err := s.StoreKeyShare(ctx, "../../escape", sampleShare()); err != nil {
		t.Fatalf("StoreKeyShare: %v", err)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != "shares" {
		t.Fatalf("share escaped the storage directory: %v", entries)
	}
	if _, err := s.GetKeyShare(ctx, "../../escape"); err != nil {
		t.Fatalf("GetKeyShare: %v", err)
	}
}

func TestResolveEncryptionKey(t *testing.T) {
	hexKey := KeyToHex(testKey(7))

	if _, err := ResolveEncryptionKey(EncryptionKeySource{}); !errors.Is(err, ErrEncryptionKeyMissing) {
		t.Fatalf("expected ErrEncryptionKeyMissing, got %v", err)
	}

	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte(hexKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	key, err := ResolveEncryptionKey(EncryptionKeySource{KeyFile: keyFile, Env: KeyToHex(testKey(8))})
	if err != nil || !bytes.Equal(key, testKey(7)) {
		t.Fatalf("key file should take precedence: %x, %v", key, err)
	}

	key, err = ResolveEncryptionKey(EncryptionKeySource{Env: hexKey, FlagHex: KeyToHex(testKey(9))})
	if err != nil || !bytes.Equal(key, testKey(7)) {
		t.Fatalf("env should take precedence over flag: %x, %v", key, err)
	}

	for _, bad := range []string{"zz", "abcd", hexKey + "00"} {
		if _, err := ResolveEncryptionKey(EncryptionKeySource{Env: bad}); err == nil {
			t.Fatalf("expected error for key %q", bad)
		}
	}

	if _, err := ResolveEncryptionKey(EncryptionKeySource{KeyFile: filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("expected error for missing key file")
	}
}

func TestSealedRecordIsVersioned(t *testing.T) {
	dir := t.TempDir()
	s := newFileStorage(t, dir, testKey(1))
	if err := s.StoreKeyShare(context.Background(), "session-a", sampleShare()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile((&fileRecordStore{dir: dir}).path("session-a"))
	var rec EncryptedKeyShare
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Version != shareFormatVersion || rec.KeyID != encryptionKeyID(testKey(1)) {
		t.Fatalf("unexpected record metadata: version=%d key_id=%s", rec.Version, rec.KeyID)
	}
}
