// Package storage implements secure storage for MPC key shards
package storage

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/stellaryield/mpc_nodes/tss"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// KeyShareStorage defines the interface for storing key shares
type KeyShareStorage interface {
	// StoreKeyShare stores a key share securely
	StoreKeyShare(ctx context.Context, sessionID string, share *tss.LocalSecretShare) error
	// GetKeyShare retrieves a key share
	GetKeyShare(ctx context.Context, sessionID string) (*tss.LocalSecretShare, error)
	// DeleteKeyShare deletes a key share
	DeleteKeyShare(ctx context.Context, sessionID string) error
	// ListKeyShares lists all stored key shares
	ListKeyShares(ctx context.Context) ([]string, error)
}

// EncryptedKeyShare represents an encrypted key share for storage
type EncryptedKeyShare struct {
	SessionID       string `bson:"session_id" json:"session_id"`
	PartyID         string `bson:"party_id" json:"party_id"`
	EncryptedShare  string `bson:"encrypted_share" json:"encrypted_share"`
	EncryptedCommit string `bson:"encrypted_commit" json:"encrypted_commit"`
	IV              string `bson:"iv" json:"iv"`
	// Version is the at-rest encryption format version (see shareFormatVersion).
	Version int `bson:"version" json:"version"`
	// KeyID fingerprints the encryption key that sealed this record so a
	// misconfigured key is reported clearly instead of as a generic failure.
	KeyID        string    `bson:"key_id" json:"key_id"`
	CreatedAt    time.Time `bson:"created_at" json:"created_at"`
	ExpiresAt    time.Time `bson:"expires_at" json:"expires_at"`
	AccessCount  int       `bson:"access_count" json:"access_count"`
	LastAccessed time.Time `bson:"last_accessed" json:"last_accessed"`
}

// HSMConfig holds HSM configuration
type HSMConfig struct {
	// Provider is the HSM provider (e.g., "vault", "aws", "gcp", "azure")
	Provider string
	// KeyURI is the URI to the HSM key
	KeyURI string
	// Region is the cloud region (for cloud HSMs)
	Region string
	// CredentialsPath is the path to credentials file
	CredentialsPath string
}

// StorageConfig holds storage configuration
type StorageConfig struct {
	// Type is the storage type ("memory", "mongodb", "encrypted_file")
	Type string
	// ConnectionString is the database connection string
	ConnectionString string
	// Database is the database name
	Database string
	// Collection is the collection name
	Collection string
	// Directory is where the "encrypted_file" backend persists sealed shares
	Directory string
	// EncryptionKey is the AES-256 encryption key (32 bytes). It must come
	// from external configuration (see ResolveEncryptionKey); it is never
	// generated or persisted by the node.
	EncryptionKey []byte
	// HSM is the HSM configuration
	HSM *HSMConfig
	// KeyTTL is the time-to-live for key shares
	KeyTTL time.Duration
}

// Validate checks if the configuration is valid
func (c *StorageConfig) Validate() error {
	if c.Type == "" {
		return errors.New("storage type cannot be empty")
	}
	if c.Type == "mongodb" && c.ConnectionString == "" {
		return errors.New("mongodb connection string required")
	}
	if c.Type == "encrypted_file" && c.Directory == "" {
		return errors.New("encrypted_file storage requires a directory")
	}
	if len(c.EncryptionKey) == 0 {
		return ErrEncryptionKeyMissing
	}
	if len(c.EncryptionKey) != 32 {
		return errors.New("encryption key must be 32 bytes (AES-256)")
	}
	return nil
}

// MemoryStorage implements in-memory key share storage
type MemoryStorage struct {
	shares map[string]*tss.LocalSecretShare
	mu     sync.RWMutex
}

// NewMemoryStorage creates a new in-memory storage
func NewMemoryStorage() *MemoryStorage {
	return &MemoryStorage{
		shares: make(map[string]*tss.LocalSecretShare),
	}
}

// StoreKeyShare stores a key share in memory
func (s *MemoryStorage) StoreKeyShare(ctx context.Context, sessionID string, share *tss.LocalSecretShare) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.shares[sessionID] = share
	return nil
}

// GetKeyShare retrieves a key share from memory
func (s *MemoryStorage) GetKeyShare(ctx context.Context, sessionID string) (*tss.LocalSecretShare, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	share, exists := s.shares[sessionID]
	if !exists {
		return nil, errors.New("key share not found")
	}

	return share, nil
}

// DeleteKeyShare deletes a key share from memory
func (s *MemoryStorage) DeleteKeyShare(ctx context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.shares, sessionID)
	return nil
}

// ListKeyShares lists all stored key share session IDs
func (s *MemoryStorage) ListKeyShares(ctx context.Context) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ids := make([]string, 0, len(s.shares))
	for id := range s.shares {
		ids = append(ids, id)
	}
	return ids, nil
}

// shareFormatVersion is the current at-rest format. Version 1 seals the share
// with AES-256-GCM and binds it to its session and party via associated data.
const shareFormatVersion = 1

var (
	// ErrEncryptionKeyMissing is returned when a persistent backend is
	// configured without an external encryption key.
	ErrEncryptionKeyMissing = errors.New("key share encryption key is not configured")
	// ErrEncryptionKeyMismatch is returned when a stored share was sealed
	// with a different key than the one currently configured.
	ErrEncryptionKeyMismatch = errors.New("key share was encrypted with a different key")
	// ErrShareIntegrity is returned when a stored share fails authentication
	// (tampered ciphertext, nonce, or metadata).
	ErrShareIntegrity = errors.New("key share failed integrity check")
	// ErrKeyShareNotFound is returned when no share exists for a session.
	ErrKeyShareNotFound = errors.New("key share not found")
)

// shareRecordStore persists sealed key share records. Implementations never
// see plaintext share material.
type shareRecordStore interface {
	insert(ctx context.Context, rec *EncryptedKeyShare) error
	find(ctx context.Context, sessionID string) (*EncryptedKeyShare, error)
	remove(ctx context.Context, sessionID string) error
	list(ctx context.Context) ([]string, error)
	touch(ctx context.Context, sessionID string, at time.Time) error
}

// EncryptedStorage implements encrypted key share storage
type EncryptedStorage struct {
	config *StorageConfig
	gcm    cipher.AEAD
	keyID  string
	store  shareRecordStore
	mu     sync.RWMutex
}

// NewEncryptedStorage creates a new encrypted storage. It fails when no
// encryption key is configured so a node never persists shares in a form
// it cannot later authenticate.
func NewEncryptedStorage(config *StorageConfig) (*EncryptedStorage, error) {
	if err := config.Validate(); err != nil {
		return nil, errors.Wrap(err, "invalid storage config")
	}

	gcm, err := newShareAEAD(config.EncryptionKey)
	if err != nil {
		return nil, err
	}

	var store shareRecordStore
	switch config.Type {
	case "mongodb":
		store, err = newMongoRecordStore(config)
	case "encrypted_file":
		store, err = newFileRecordStore(config.Directory)
	default:
		return nil, errors.Errorf("unsupported encrypted storage type %q", config.Type)
	}
	if err != nil {
		return nil, err
	}

	return &EncryptedStorage{
		config: config,
		gcm:    gcm,
		keyID:  encryptionKeyID(config.EncryptionKey),
		store:  store,
	}, nil
}

func newShareAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create cipher")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create GCM")
	}
	return gcm, nil
}

// encryptionKeyID derives a non-secret fingerprint of the key so records can
// be matched to the key that sealed them.
func encryptionKeyID(key []byte) string {
	sum := sha256.Sum256(append([]byte("stellaryield/mpc-keyshare/key-id"), key...))
	return hex.EncodeToString(sum[:8])
}

// shareAAD binds a ciphertext to the record it belongs to, so a sealed share
// cannot be swapped between sessions or parties without detection.
func shareAAD(version int, sessionID, partyID string) []byte {
	return []byte(fmt.Sprintf("stellaryield/mpc-keyshare/v%d\x00%s\x00%s", version, sessionID, partyID))
}

// encrypt encrypts data using AES-GCM
func (s *EncryptedStorage) encrypt(plaintext, aad []byte) (ciphertext []byte, iv []byte, err error) {
	iv = make([]byte, s.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return nil, nil, err
	}

	ciphertext = s.gcm.Seal(nil, iv, plaintext, aad)
	return ciphertext, iv, nil
}

// decrypt decrypts data using AES-GCM
func (s *EncryptedStorage) decrypt(ciphertext, iv, aad []byte) (plaintext []byte, err error) {
	if len(iv) != s.gcm.NonceSize() {
		return nil, ErrShareIntegrity
	}
	plaintext, err = s.gcm.Open(nil, iv, ciphertext, aad)
	if err != nil {
		return nil, ErrShareIntegrity
	}
	return plaintext, nil
}

// StoreKeyShare stores an encrypted key share
func (s *EncryptedStorage) StoreKeyShare(ctx context.Context, sessionID string, share *tss.LocalSecretShare) error {
	if share == nil || share.SecretShare == nil || share.Commitment == nil {
		return errors.New("key share is incomplete")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Serialize share data
	shareData := map[string]interface{}{
		"party_id": share.PartyID,
		"share":    share.SecretShare.String(),
		"commit":   share.Commitment.String(),
	}

	shareJSON, err := json.Marshal(shareData)
	if err != nil {
		return errors.Wrap(err, "failed to marshal share")
	}

	// Encrypt share
	encryptedShare, iv, err := s.encrypt(shareJSON, shareAAD(shareFormatVersion, sessionID, share.PartyID))
	if err != nil {
		return errors.Wrap(err, "failed to encrypt share")
	}

	now := time.Now()
	encrypted := &EncryptedKeyShare{
		SessionID:      sessionID,
		PartyID:        share.PartyID,
		EncryptedShare: base64.StdEncoding.EncodeToString(encryptedShare),
		IV:             base64.StdEncoding.EncodeToString(iv),
		Version:        shareFormatVersion,
		KeyID:          s.keyID,
		CreatedAt:      now,
		LastAccessed:   now,
	}

	if s.config.KeyTTL > 0 {
		encrypted.ExpiresAt = now.Add(s.config.KeyTTL)
	}

	return s.store.insert(ctx, encrypted)
}

// GetKeyShare retrieves and decrypts a key share
func (s *EncryptedStorage) GetKeyShare(ctx context.Context, sessionID string) (*tss.LocalSecretShare, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	encrypted, err := s.store.find(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Check expiration
	if !encrypted.ExpiresAt.IsZero() && time.Now().After(encrypted.ExpiresAt) {
		return nil, errors.New("key share expired")
	}

	if encrypted.Version != shareFormatVersion {
		return nil, errors.Errorf("unsupported key share format version %d", encrypted.Version)
	}
	if encrypted.KeyID != s.keyID {
		return nil, ErrEncryptionKeyMismatch
	}
	if encrypted.SessionID != sessionID {
		return nil, ErrShareIntegrity
	}

	// Decrypt share
	encryptedShare, err := base64.StdEncoding.DecodeString(encrypted.EncryptedShare)
	if err != nil {
		return nil, ErrShareIntegrity
	}

	iv, err := base64.StdEncoding.DecodeString(encrypted.IV)
	if err != nil {
		return nil, ErrShareIntegrity
	}

	shareJSON, err := s.decrypt(encryptedShare, iv, shareAAD(encrypted.Version, sessionID, encrypted.PartyID))
	if err != nil {
		return nil, err
	}

	var shareData map[string]string
	if err := json.Unmarshal(shareJSON, &shareData); err != nil {
		return nil, errors.Wrap(err, "failed to unmarshal share")
	}

	share := &tss.LocalSecretShare{
		PartyID: shareData["party_id"],
	}

	var ok bool
	if share.SecretShare, ok = new(big.Int).SetString(shareData["share"], 10); !ok {
		return nil, ErrShareIntegrity
	}
	if share.Commitment, ok = new(big.Int).SetString(shareData["commit"], 10); !ok {
		return nil, ErrShareIntegrity
	}

	// Update access metadata
	if err := s.store.touch(ctx, sessionID, time.Now()); err != nil {
		// Log but don't fail the operation
		fmt.Printf("failed to update access count: %v\n", err)
	}

	return share, nil
}

// DeleteKeyShare deletes a key share
func (s *EncryptedStorage) DeleteKeyShare(ctx context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.store.remove(ctx, sessionID)
}

// ListKeyShares lists all stored key share session IDs
func (s *EncryptedStorage) ListKeyShares(ctx context.Context) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.store.list(ctx)
}

// mongoRecordStore persists sealed shares in a MongoDB collection.
type mongoRecordStore struct {
	collection *mongo.Collection
}

func newMongoRecordStore(config *StorageConfig) (*mongoRecordStore, error) {
	client, err := mongo.Connect(context.TODO(), options.Client().ApplyURI(config.ConnectionString))
	if err != nil {
		return nil, errors.Wrap(err, "failed to connect to mongodb")
	}

	collection := client.Database(config.Database).Collection(config.Collection)

	// Create index on session_id
	indexModel := mongo.IndexModel{
		Keys:    bson.D{{Key: "session_id", Value: 1}},
		Options: options.Index().SetUnique(true),
	}
	if _, err := collection.Indexes().CreateOne(context.TODO(), indexModel); err != nil {
		return nil, errors.Wrap(err, "failed to create index")
	}

	return &mongoRecordStore{collection: collection}, nil
}

func (m *mongoRecordStore) insert(ctx context.Context, rec *EncryptedKeyShare) error {
	if _, err := m.collection.InsertOne(ctx, rec); err != nil {
		return errors.Wrap(err, "failed to insert into database")
	}
	return nil
}

func (m *mongoRecordStore) find(ctx context.Context, sessionID string) (*EncryptedKeyShare, error) {
	var rec EncryptedKeyShare
	err := m.collection.FindOne(ctx, bson.M{"session_id": sessionID}).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		return nil, ErrKeyShareNotFound
	}
	if err != nil {
		return nil, errors.Wrap(err, "failed to load key share")
	}
	return &rec, nil
}

func (m *mongoRecordStore) remove(ctx context.Context, sessionID string) error {
	if _, err := m.collection.DeleteOne(ctx, bson.M{"session_id": sessionID}); err != nil {
		return errors.Wrap(err, "failed to delete from database")
	}
	return nil
}

func (m *mongoRecordStore) list(ctx context.Context) ([]string, error) {
	cursor, err := m.collection.Find(ctx, bson.M{})
	if err != nil {
		return nil, errors.Wrap(err, "failed to query database")
	}
	defer cursor.Close(ctx)

	var ids []string
	for cursor.Next(ctx) {
		var encrypted EncryptedKeyShare
		if err := cursor.Decode(&encrypted); err != nil {
			return nil, errors.Wrap(err, "failed to decode document")
		}
		ids = append(ids, encrypted.SessionID)
	}

	if err := cursor.Err(); err != nil {
		return nil, errors.Wrap(err, "cursor error")
	}
	return ids, nil
}

func (m *mongoRecordStore) touch(ctx context.Context, sessionID string, at time.Time) error {
	_, err := m.collection.UpdateOne(ctx,
		bson.M{"session_id": sessionID},
		bson.M{
			"$inc": bson.M{"access_count": 1},
			"$set": bson.M{"last_accessed": at},
		},
	)
	return err
}

// VaultStorage implements HashiCorp Vault-backed storage
type VaultStorage struct {
	config     *StorageConfig
	vaultAddr  string
	vaultToken string
	mu         sync.RWMutex
}

// NewVaultStorage creates a new Vault-backed storage
func NewVaultStorage(config *StorageConfig, vaultAddr, vaultToken string) (*VaultStorage, error) {
	// In production, initialize Vault client here
	return &VaultStorage{
		config:     config,
		vaultAddr:  vaultAddr,
		vaultToken: vaultToken,
	}, nil
}

// StoreKeyShare stores a key share in Vault
func (s *VaultStorage) StoreKeyShare(ctx context.Context, sessionID string, share *tss.LocalSecretShare) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// In production, store in Vault's secret engine
	// Path: secret/data/mpc/shares/{session_id}
	return nil
}

// GetKeyShare retrieves a key share from Vault
func (s *VaultStorage) GetKeyShare(ctx context.Context, sessionID string) (*tss.LocalSecretShare, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// In production, retrieve from Vault
	return nil, errors.New("not implemented")
}

// DeleteKeyShare deletes a key share from Vault
func (s *VaultStorage) DeleteKeyShare(ctx context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// In production, delete from Vault
	return nil
}

// ListKeyShares lists all stored key share session IDs
func (s *VaultStorage) ListKeyShares(ctx context.Context) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// In production, list from Vault
	return []string{}, nil
}

// AuditLogEntry represents an audit log entry
type AuditLogEntry struct {
	Timestamp    time.Time `json:"timestamp"`
	Action       string    `json:"action"`
	SessionID    string    `json:"session_id"`
	PartyID      string    `json:"party_id"`
	IPAddress    string    `json:"ip_address"`
	UserAgent    string    `json:"user_agent"`
	Success      bool      `json:"success"`
	ErrorMessage string    `json:"error_message,omitempty"`
}

// AuditLogger handles audit logging for key operations
type AuditLogger struct {
	logChan chan *AuditLogEntry
}

// NewAuditLogger creates a new audit logger
func NewAuditLogger() *AuditLogger {
	logger := &AuditLogger{
		logChan: make(chan *AuditLogEntry, 1000),
	}

	// Start background writer
	go logger.writeLoop()

	return logger
}

// Log logs an audit event
func (l *AuditLogger) Log(entry *AuditLogEntry) {
	select {
	case l.logChan <- entry:
	default:
		// Channel full, drop log (in production, handle this better)
	}
}

func (l *AuditLogger) writeLoop() {
	for entry := range l.logChan {
		// In production, write to secure audit log storage
		logJSON, _ := json.Marshal(entry)
		fmt.Printf("[AUDIT] %s\n", string(logJSON))
	}
}

// KeyRotationManager handles key share rotation
type KeyRotationManager struct {
	storage KeyShareStorage
	audit   *AuditLogger
}

// NewKeyRotationManager creates a new key rotation manager
func NewKeyRotationManager(storage KeyShareStorage, audit *AuditLogger) *KeyRotationManager {
	return &KeyRotationManager{
		storage: storage,
		audit:   audit,
	}
}

// RotateKeyShare rotates a key share
func (m *KeyRotationManager) RotateKeyShare(ctx context.Context, oldSessionID, newSessionID string, newShare *tss.LocalSecretShare) error {
	// Store new share
	if err := m.storage.StoreKeyShare(ctx, newSessionID, newShare); err != nil {
		m.audit.Log(&AuditLogEntry{
			Timestamp:    time.Now(),
			Action:       "ROTATE_KEY_FAILED",
			SessionID:    newSessionID,
			Success:      false,
			ErrorMessage: err.Error(),
		})
		return err
	}

	// Delete old share
	if err := m.storage.DeleteKeyShare(ctx, oldSessionID); err != nil {
		m.audit.Log(&AuditLogEntry{
			Timestamp:    time.Now(),
			Action:       "DELETE_OLD_KEY_FAILED",
			SessionID:    oldSessionID,
			Success:      false,
			ErrorMessage: err.Error(),
		})
		// Don't fail the rotation, just log
	}

	m.audit.Log(&AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "ROTATE_KEY_SUCCESS",
		SessionID: newSessionID,
		Success:   true,
	})

	return nil
}

// GenerateEncryptionKey generates a random 32-byte encryption key
func GenerateEncryptionKey() ([]byte, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, nil
}

// KeyToHex converts an encryption key to hex string
func KeyToHex(key []byte) string {
	return hex.EncodeToString(key)
}

// KeyFromHex converts a hex string to encryption key
func KeyFromHex(hexKey string) ([]byte, error) {
	return hex.DecodeString(hexKey)
}
