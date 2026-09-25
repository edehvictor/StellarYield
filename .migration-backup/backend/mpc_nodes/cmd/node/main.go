// MPC Treasury Node - Main Entry Point
// This node implements a Threshold Signature Scheme (TSS) for secure treasury operations
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/stellaryield/mpc_nodes/api"
	"github.com/stellaryield/mpc_nodes/coordinator"
	"github.com/stellaryield/mpc_nodes/stellar"
	"github.com/stellaryield/mpc_nodes/storage"
	"github.com/stellaryield/mpc_nodes/tss"
)

// Config holds all configuration for the MPC node
type Config struct {
	// Node configuration
	PartyID      string
	Threshold    int
	TotalParties int

	// API configuration
	APIPort       int
	EnableMetrics bool
	EnableCORS    bool

	// Storage configuration
	StorageType        string
	MongoConnectionString string
	MongoDatabase      string
	MongoCollection    string
	EncryptionKey      string

	// Stellar configuration
	StellarNetworkPassphrase string
	StellarHorizonURL        string
	StellarMPCPublicKey      string

	// HSM configuration (optional)
	HSMProvider string
	HSMKeyURI   string
	HSMRegion   string
}

func main() {
	// Parse command-line flags
	config := parseFlags()

	// Validate configuration
	if err := validateConfig(config); err != nil {
		log.Fatalf("Invalid configuration: %v", err)
	}

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigChan
		log.Printf("Received signal %v, shutting down...", sig)
		cancel()
	}()

	// Initialize components
	log.Println("Initializing MPC Treasury Node...")

	// Initialize storage
	keyStorage, err := initializeStorage(config)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	log.Printf("Storage initialized: %s", config.StorageType)

	// Initialize audit logger
	auditLogger := storage.NewAuditLogger()
	log.Println("Audit logger initialized")

	// Initialize ceremony coordinator
	ceremonyConfig := &coordinator.CeremonyConfig{
		Threshold:    config.Threshold,
		TotalParties: config.TotalParties,
		PartyID:      config.PartyID,
		Timeout:      5 * time.Minute,
		Storage:      keyStorage,
	}

	ceremonyCoord, err := coordinator.NewCeremonyCoordinator(ceremonyConfig)
	if err != nil {
		log.Fatalf("Failed to create ceremony coordinator: %v", err)
	}
	log.Printf("Ceremony coordinator initialized (threshold: %d/%d)", config.Threshold, config.TotalParties)

	// Initialize Stellar client
	stellarConfig := &stellar.Config{
		NetworkPassphrase: config.StellarNetworkPassphrase,
		HorizonURL:        config.StellarHorizonURL,
		FeeMultiplier:     1,
	}

	if config.StellarMPCPublicKey != "" {
		stellarConfig.MPCPublicKey, _ = stellar.ParseAddress(config.StellarMPCPublicKey)
	}

	treasuryClient, err := stellar.NewTreasuryClient(stellarConfig)
	if err != nil {
		log.Fatalf("Failed to create Stellar client: %v", err)
	}
	log.Printf("Stellar client initialized: %s", config.StellarHorizonURL)

	// Create MPC service
	mpcService := api.NewMPCService(
		ceremonyCoord,
		treasuryClient,
		keyStorage,
		auditLogger,
	)

	// Create API server
	apiConfig := &api.APIConfig{
		Port:          config.APIPort,
		EnableMetrics: config.EnableMetrics,
		EnableCORS:    config.EnableCORS,
		AllowedOrigins: []string{"*"},
	}

	server := api.NewServer(apiConfig, mpcService)

	// Log startup information
	log.Printf("MPC Treasury Node starting...")
	log.Printf("  Party ID: %s", config.PartyID)
	log.Printf("  Threshold: %d of %d parties", config.Threshold, config.TotalParties)
	log.Printf("  API Port: %d", config.APIPort)
	log.Printf("  Network: %s", config.StellarNetworkPassphrase)

	// Start API server
	if err := server.Run(ctx); err != nil && err != context.Canceled {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("MPC Treasury Node stopped")
}

// parseFlags parses command-line flags
func parseFlags() *Config {
	config := &Config{}

	// Node configuration
	flag.StringVar(&config.PartyID, "party-id", "", "Unique party identifier")
	flag.IntVar(&config.Threshold, "threshold", 2, "Signature threshold (t)")
	flag.IntVar(&config.TotalParties, "total-parties", 3, "Total number of parties (n)")

	// API configuration
	flag.IntVar(&config.APIPort, "api-port", 8080, "HTTP API port")
	flag.BoolVar(&config.EnableMetrics, "metrics", true, "Enable Prometheus metrics")
	flag.BoolVar(&config.EnableCORS, "cors", true, "Enable CORS")

	// Storage configuration
	flag.StringVar(&config.StorageType, "storage", "memory", "Storage type (memory, mongodb, encrypted_file)")
	flag.StringVar(&config.MongoConnectionString, "mongo-uri", "", "MongoDB connection string")
	flag.StringVar(&config.MongoDatabase, "mongo-db", "mpc_treasury", "MongoDB database name")
	flag.StringVar(&config.MongoCollection, "mongo-collection", "key_shares", "MongoDB collection name")
	flag.StringVar(&config.EncryptionKey, "encryption-key", "", "AES-256 encryption key (hex)")

	// Stellar configuration
	flag.StringVar(&config.StellarNetworkPassphrase, "stellar-network", "Stellar Test Network ; September 2015", "Stellar network passphrase")
	flag.StringVar(&config.StellarHorizonURL, "stellar-horizon", "https://horizon-testnet.stellar.org", "Stellar Horizon URL")
	flag.StringVar(&config.StellarMPCPublicKey, "stellar-public-key", "", "MPC treasury public key")

	// HSM configuration
	flag.StringVar(&config.HSMProvider, "hsm-provider", "", "HSM provider (vault, aws, gcp, azure)")
	flag.StringVar(&config.HSMKeyURI, "hsm-key-uri", "", "HSM key URI")
	flag.StringVar(&config.HSMRegion, "hsm-region", "", "HSM region")

	flag.Parse()

	return config
}

// validateConfig validates the configuration
func validateConfig(config *Config) error {
	if config.PartyID == "" {
		return fmt.Errorf("party-id is required")
	}
	if config.Threshold <= 0 {
		return fmt.Errorf("threshold must be positive")
	}
	if config.TotalParties <= 0 {
		return fmt.Errorf("total-parties must be positive")
	}
	if config.Threshold > config.TotalParties {
		return fmt.Errorf("threshold cannot exceed total parties")
	}
	if config.EncryptionKey != "" && len(config.EncryptionKey) != 64 {
		return fmt.Errorf("encryption-key must be 64 hex characters (32 bytes)")
	}
	return nil
}

// initializeStorage initializes the key share storage
func initializeStorage(config *Config) (storage.KeyShareStorage, error) {
	var encryptionKey []byte
	var err error

	if config.EncryptionKey != "" {
		encryptionKey, err = storage.KeyFromHex(config.EncryptionKey)
		if err != nil {
			return nil, fmt.Errorf("invalid encryption key: %w", err)
		}
	} else {
		// Generate random key for testing (in production, use secure key management)
		encryptionKey, err = storage.GenerateEncryptionKey()
		if err != nil {
			return nil, fmt.Errorf("failed to generate encryption key: %w", err)
		}
		log.Printf("Generated encryption key: %s", storage.KeyToHex(encryptionKey))
	}

	storageConfig := &storage.StorageConfig{
		Type:             config.StorageType,
		ConnectionString: config.MongoConnectionString,
		Database:         config.MongoDatabase,
		Collection:       config.MongoCollection,
		EncryptionKey:    encryptionKey,
	}

	if config.HSMProvider != "" {
		storageConfig.HSM = &storage.HSMConfig{
			Provider: config.HSMProvider,
			KeyURI:   config.HSMKeyURI,
			Region:   config.HSMRegion,
		}
	}

	switch config.StorageType {
	case "memory":
		return storage.NewMemoryStorage(), nil
	case "mongodb":
		return storage.NewEncryptedStorage(storageConfig)
	case "encrypted_file":
		return storage.NewEncryptedStorage(storageConfig)
	default:
		return storage.NewMemoryStorage(), nil
	}
}

// Helper function to parse Stellar address
func stellar.ParseAddress(address string) (*keypair.FromAddress, error) {
	return keypair.ParseAddress(address)
}
