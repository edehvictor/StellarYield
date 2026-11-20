package storage

import (
	"os"
	"strings"

	"github.com/pkg/errors"
)

// EncryptionKeyEnv is the environment variable holding the hex-encoded
// AES-256 key used to seal persisted key shares.
const EncryptionKeyEnv = "MPC_KEYSHARE_ENCRYPTION_KEY"

// EncryptionKeySource describes where the key share encryption key may come
// from. Sources are checked in order: KeyFile, then Env, then FlagHex.
type EncryptionKeySource struct {
	// KeyFile is a path to a file containing the hex-encoded key
	// (e.g. a mounted secret).
	KeyFile string
	// Env is the value of EncryptionKeyEnv, if set.
	Env string
	// FlagHex is a hex key passed directly on the command line.
	FlagHex string
}

// ResolveEncryptionKey loads the 32-byte key share encryption key from
// external configuration. It never generates a key: when no source is set it
// returns ErrEncryptionKeyMissing so the node refuses to start rather than
// sealing shares with a key nobody can recover.
func ResolveEncryptionKey(src EncryptionKeySource) ([]byte, error) {
	var (
		hexKey string
		origin string
	)
	switch {
	case src.KeyFile != "":
		data, err := os.ReadFile(src.KeyFile)
		if err != nil {
			return nil, errors.Wrap(err, "failed to read encryption key file")
		}
		hexKey, origin = string(data), "key file"
	case src.Env != "":
		hexKey, origin = src.Env, EncryptionKeyEnv
	case src.FlagHex != "":
		hexKey, origin = src.FlagHex, "encryption-key flag"
	default:
		return nil, ErrEncryptionKeyMissing
	}

	key, err := KeyFromHex(strings.TrimSpace(hexKey))
	if err != nil {
		return nil, errors.Wrapf(err, "invalid encryption key from %s", origin)
	}
	if len(key) != 32 {
		return nil, errors.Errorf("encryption key from %s must be 32 bytes (64 hex characters), got %d bytes", origin, len(key))
	}
	return key, nil
}
