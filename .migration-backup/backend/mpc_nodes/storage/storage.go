// Package storage implements secure storage for MPC key shards
package storage

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
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
	SessionID       string    `bson:"session_id" json:"session_id"`
	PartyID         string    `bson:"party_id" json:"party_id"`
	EncryptedShare  string    `bson:"encrypted_share" json:"encrypted_share"`
	EncryptedCommit string    `bson:"encrypted_commit" json:"encrypted_commit"`
	IV              string    `bson:"iv" json:"iv"`
	CreatedAt       time.Time `bson:"created_at" json:"created_at"`
	ExpiresAt       time.Time `bson:"expires_at" json:"expires_at"`
	AccessCount     int       `bson:"access_count" json:"access_count"`
	LastAccessed    time.Time `bson:"last_accessed" json:"last_accessed"`
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
	// EncryptionKey is the AES-256 encryption key (32 bytes)
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

// EncryptedStorage implements encrypted key share storage
type EncryptedStorage struct {
	config    *StorageConfig
	cipher    cipher.Block
	gcm       cipher.AEAD
	db        *mongo.Database
	collection *mongo.Collection
	mu        sync.RWMutex
}

// NewEncryptedStorage creates a new encrypted storage
func NewEncryptedStorage(config *StorageConfig) (*EncryptedStorage, error) {
	if err := config.Validate(); err != nil {
		return nil, errors.Wrap(err, "invalid storage config")
	}

	block, err := aes.NewCipher(config.EncryptionKey)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create cipher")
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create GCM")
	}

	storage := &EncryptedStorage{
		config: config,
		cipher: block,
		gcm:    gcm,
	}

	if config.Type == "mongodb" {
		client, err := mongo.Connect(context.TODO(), options.Client().ApplyURI(config.ConnectionString))
		if err != nil {
			return nil, errors.Wrap(err, "failed to connect to mongodb")
		}

		storage.db = client.Database(config.Database)
		storage.collection = storage.db.Collection(config.Collection)

		// Create index on session_id
		indexModel := mongo.IndexModel{
			Keys:    bson.D{{Key: "session_id", Value: 1}},
			Options: options.Index().SetUnique(true),
		}
		_, err = storage.collection.Indexes().CreateOne(context.TODO(), indexModel)
		if err != nil {
			return nil, errors.Wrap(err, "failed to create index")
		}
	}

	return storage, nil
}

// encrypt encrypts data using AES-GCM
func (s *EncryptedStorage) encrypt(plaintext []byte) (ciphertext []byte, iv []byte, err error) {
	iv = make([]byte, s.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return nil, nil, err
	}

	ciphertext = s.gcm.Seal(nil, iv, plaintext, nil)
	return ciphertext, iv, nil
}

// decrypt decrypts data using AES-GCM
func (s *EncryptedStorage) decrypt(ciphertext []byte, iv []byte) (plaintext []byte, err error) {
	plaintext, err = s.gcm.Open(nil, iv, ciphertext, nil)
	return plaintext, err
}

// StoreKeyShare stores an encrypted key share
func (s *EncryptedStorage) StoreKeyShare(ctx context.Context, sessionID string, share *tss.LocalSecretShare) error {
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
	encryptedShare, iv, err := s.encrypt(shareJSON)
	if err != nil {
		return errors.Wrap(err, "failed to encrypt share")
	}

	encrypted := &EncryptedKeyShare{
		SessionID:      sessionID,
		PartyID:        share.PartyID,
		EncryptedShare: base64.StdEncoding.EncodeToString(encryptedShare),
		IV:             base64.StdEncoding.EncodeToString(iv),
		CreatedAt:      time.Now(),
		LastAccessed:   time.Now(),
	}

	if s.config.KeyTTL > 0 {
		encrypted.ExpiresAt = time.Now().Add(s.config.KeyTTL)
	}

	if s.collection != nil {
		_, err = s.collection.InsertOne(ctx, encrypted)
		if err != nil {
			return errors.Wrap(err, "failed to insert into database")
		}
	}

	return nil
}

// GetKeyShare retrieves and decrypts a key share
func (s *EncryptedStorage) GetKeyShare(ctx context.Context, sessionID string) (*tss.LocalSecretShare, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var encrypted EncryptedKeyShare
	var err error

	if s.collection != nil {
		err = s.collection.FindOne(ctx, bson.M{"session_id": sessionID}).Decode(&encrypted)
	}

	if err != nil {
		return nil, errors.Wrap(err, "key share not found")
	}

	// Check expiration
	if !encrypted.ExpiresAt.IsZero() && time.Now().After(encrypted.ExpiresAt) {
		return nil, errors.New("key share expired")
	}

	// Decrypt share
	encryptedShare, err := base64.StdEncoding.DecodeString(encrypted.EncryptedShare)
	if err != nil {
		return nil, errors.Wrap(err, "failed to decode encrypted share")
	}

	iv, err := base64.StdEncoding.DecodeString(encrypted.IV)
	if err != nil {
		return nil, errors.Wrap(err, "failed to decode IV")
	}

	shareJSON, err := s.decrypt(encryptedShare, iv)
	if err != nil {
		return nil, errors.Wrap(err, "failed to decrypt share")
	}

	var shareData map[string]string
	if err := json.Unmarshal(shareJSON, &shareData); err != nil {
		return nil, errors.Wrap(err, "failed to unmarshal share")
	}

	share := &tss.LocalSecretShare{
		PartyID: shareData["party_id"],
	}

	share.SecretShare = new(big.Int)
	share.SecretShare.SetString(shareData["share"], 10)

	share.Commitment = new(big.Int)
	share.Commitment.SetString(shareData["commit"], 10)

	// Update access count
	if s.collection != nil {
		_, err = s.collection.UpdateOne(ctx,
			bson.M{"session_id": sessionID},
			bson.M{
				"$inc": bson.M{"access_count": 1},
				"$set": bson.M{"last_accessed": time.Now()},
			},
		)
		if err != nil {
			// Log but don't fail the operation
			fmt.Printf("failed to update access count: %v\n", err)
		}
	}

	return share, nil
}

// DeleteKeyShare deletes a key share
func (s *EncryptedStorage) DeleteKeyShare(ctx context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.collection != nil {
		_, err := s.collection.DeleteOne(ctx, bson.M{"session_id": sessionID})
		if err != nil {
			return errors.Wrap(err, "failed to delete from database")
		}
	}

	return nil
}

// ListKeyShares lists all stored key share session IDs
func (s *EncryptedStorage) ListKeyShares(ctx context.Context) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var ids []string

	if s.collection != nil {
		cursor, err := s.collection.Find(ctx, bson.M{})
		if err != nil {
			return nil, errors.Wrap(err, "failed to query database")
		}
		defer cursor.Close(ctx)

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
	}

	return ids, nil
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
	Timestamp   time.Time `json:"timestamp"`
	Action      string    `json:"action"`
	SessionID   string    `json:"session_id"`
	PartyID     string    `json:"party_id"`
	IPAddress   string    `json:"ip_address"`
	UserAgent   string    `json:"user_agent"`
	Success     bool      `json:"success"`
	ErrorMessage string   `json:"error_message,omitempty"`
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
			Timestamp:   time.Now(),
			Action:      "ROTATE_KEY_FAILED",
			SessionID:   newSessionID,
			Success:     false,
			ErrorMessage: err.Error(),
		})
		return err
	}

	// Delete old share
	if err := m.storage.DeleteKeyShare(ctx, oldSessionID); err != nil {
		m.audit.Log(&AuditLogEntry{
			Timestamp:   time.Now(),
			Action:      "DELETE_OLD_KEY_FAILED",
			SessionID:   oldSessionID,
			Success:     false,
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
