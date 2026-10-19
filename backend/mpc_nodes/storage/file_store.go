package storage

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/errors"
)

const sealedShareExt = ".share.json"

// fileRecordStore persists sealed shares as one JSON file per session in a
// private directory. File names are hex-encoded session IDs so untrusted IDs
// can never escape the directory.
type fileRecordStore struct {
	dir string
}

func newFileRecordStore(dir string) (*fileRecordStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, errors.Wrap(err, "failed to create key share directory")
	}
	return &fileRecordStore{dir: dir}, nil
}

func (f *fileRecordStore) path(sessionID string) string {
	return filepath.Join(f.dir, hex.EncodeToString([]byte(sessionID))+sealedShareExt)
}

func (f *fileRecordStore) write(rec *EncryptedKeyShare) error {
	data, err := json.Marshal(rec)
	if err != nil {
		return errors.Wrap(err, "failed to marshal sealed share")
	}

	tmp, err := os.CreateTemp(f.dir, ".tmp-share-*")
	if err != nil {
		return errors.Wrap(err, "failed to create temp file")
	}
	defer os.Remove(tmp.Name())

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return errors.Wrap(err, "failed to restrict share file permissions")
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return errors.Wrap(err, "failed to write sealed share")
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return errors.Wrap(err, "failed to sync sealed share")
	}
	if err := tmp.Close(); err != nil {
		return errors.Wrap(err, "failed to close sealed share")
	}
	return os.Rename(tmp.Name(), f.path(rec.SessionID))
}

func (f *fileRecordStore) insert(ctx context.Context, rec *EncryptedKeyShare) error {
	if _, err := os.Stat(f.path(rec.SessionID)); err == nil {
		return errors.Errorf("key share for session %q already exists", rec.SessionID)
	}
	return f.write(rec)
}

func (f *fileRecordStore) find(ctx context.Context, sessionID string) (*EncryptedKeyShare, error) {
	data, err := os.ReadFile(f.path(sessionID))
	if os.IsNotExist(err) {
		return nil, ErrKeyShareNotFound
	}
	if err != nil {
		return nil, errors.Wrap(err, "failed to read sealed share")
	}

	var rec EncryptedKeyShare
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, ErrShareIntegrity
	}
	return &rec, nil
}

func (f *fileRecordStore) remove(ctx context.Context, sessionID string) error {
	if err := os.Remove(f.path(sessionID)); err != nil && !os.IsNotExist(err) {
		return errors.Wrap(err, "failed to delete sealed share")
	}
	return nil
}

func (f *fileRecordStore) list(ctx context.Context) ([]string, error) {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return nil, errors.Wrap(err, "failed to list key share directory")
	}

	var ids []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, sealedShareExt) {
			continue
		}
		id, err := hex.DecodeString(strings.TrimSuffix(name, sealedShareExt))
		if err != nil {
			continue
		}
		ids = append(ids, string(id))
	}
	return ids, nil
}

func (f *fileRecordStore) touch(ctx context.Context, sessionID string, at time.Time) error {
	rec, err := f.find(ctx, sessionID)
	if err != nil {
		return err
	}
	rec.AccessCount++
	rec.LastAccessed = at
	return f.write(rec)
}
