// Package stellar provides Stellar blockchain integration for MPC treasury
package stellar

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/pkg/errors"
	"github.com/stellar/go/keypair"
	"github.com/stellar/go/network"
	"github.com/stellar/go/txnbuild"
	"github.com/stellaryield/mpc_nodes/tss"
)

// Config holds Stellar network configuration
type Config struct {
	// NetworkPassphrase is the Stellar network passphrase
	NetworkPassphrase string
	// HorizonURL is the Horizon API URL
	HorizonURL string
	// MPCPublicKey is the aggregated MPC public key
	MPCPublicKey *keypair.FromAddress
	// FeeMultiplier is the fee multiplier for transactions
	FeeMultiplier int64
}

// TreasuryClient provides Stellar treasury operations
type TreasuryClient struct {
	config *Config
}

// NewTreasuryClient creates a new Stellar treasury client
func NewTreasuryClient(config *Config) (*TreasuryClient, error) {
	if config.NetworkPassphrase == "" {
		return nil, errors.New("network passphrase required")
	}
	if config.HorizonURL == "" {
		return nil, errors.New("horizon URL required")
	}

	return &TreasuryClient{
		config: config,
	}, nil
}

// TreasuryOperation represents a treasury operation to be signed
type TreasuryOperation struct {
	// Type is the operation type
	Type string
	// SourceAccount is the source account (MPC treasury)
	SourceAccount string
	// Destination is the destination account (if applicable)
	Destination string
	// Amount is the amount (if applicable)
	Amount string
	// Asset is the asset (if applicable)
	Asset string
	// Data is additional operation data
	Data map[string]interface{}
}

// SigningRequest represents a request to sign a transaction
type SigningRequest struct {
	// TransactionXDR is the base64-encoded transaction XDR
	TransactionXDR string
	// MessageHash is the hash to sign
	MessageHash []byte
	// OperationType is the type of operation
	OperationType string
	// Metadata is additional metadata
	Metadata map[string]string
}

// SigningResult holds the result of a signing operation
type SigningResult struct {
	// Signature is the TSS signature
	Signature *tss.Signature
	// SignedTransactionXDR is the signed transaction XDR
	SignedTransactionXDR string
	// TransactionHash is the transaction hash
	TransactionHash string
}

// TransactionResult holds the result of a submitted transaction
type TransactionResult struct {
	// TransactionHash is the transaction hash
	TransactionHash string
	// Ledger is the ledger sequence
	Ledger int32
	// Success indicates if the transaction succeeded
	Success bool
	// ResultCodes contains operation result codes
	ResultCodes []string
	// EnvelopeXDR is the transaction envelope XDR
	EnvelopeXDR string
	// ResultXDR is the transaction result XDR
	ResultXDR string
}

// CreatePaymentTransaction creates a payment transaction
func (c *TreasuryClient) CreatePaymentTransaction(
	ctx context.Context,
	sourceAccount string,
	destination string,
	amount string,
	asset string,
	memo string,
) (string, error) {
	// In production, fetch account details from Horizon
	// For now, we create a template transaction

	publicKey := c.config.MPCPublicKey
	if publicKey == nil {
		// Create a placeholder for testing
		var err error
		publicKey, err = keypair.ParseAddress(sourceAccount)
		if err != nil {
			return "", errors.Wrap(err, "invalid source account")
		}
	}

	// Create payment operation
	paymentOp := &txnbuild.Payment{
		Destination: destination,
		Amount:      amount,
		Asset:       txnbuild.NativeAsset{},
	}

	if asset != "" && asset != "XLM" {
		// Parse custom asset
		// In production, implement proper asset parsing
		paymentOp.Asset = txnbuild.NativeAsset{}
	}

	// Build transaction
	tx, err := txnbuild.NewTransaction(
		txnbuild.TransactionParams{
			SourceAccount: &txnbuild.SimpleAccount{
				AccountID: sourceAccount,
				Sequence:  0, // Will be set during signing
			},
			Operations: []txnbuild.Operation{paymentOp},
			BaseFee:    txnbuild.MinBaseFee * c.config.FeeMultiplier,
			Memo:       txnbuild.MemoText(memo),
			Preconditions: txnbuild.Preconditions{
				TimeBounds: &txnbuild.Timebounds{
					MinTime: 0,
					MaxTime: uint64(time.Now().Add(5 * time.Minute).Unix()),
				},
			},
		},
	)
	if err != nil {
		return "", errors.Wrap(err, "failed to build transaction")
	}

	// Get transaction XDR for signing
	txXDR, err := tx.Base64()
	if err != nil {
		return "", errors.Wrap(err, "failed to encode transaction")
	}

	return txXDR, nil
}

// CreateSetConfigTransaction creates a set options transaction for treasury config
func (c *TreasuryClient) CreateSetConfigTransaction(
	ctx context.Context,
	sourceAccount string,
	setMasterWeight *int32,
	setLowThreshold *int32,
	setMedThreshold *int32,
	setHighThreshold *int32,
	setSigner *txnbuild.SetSigner,
) (string, error) {
	publicKey := c.config.MPCPublicKey
	if publicKey == nil {
		var err error
		publicKey, err = keypair.ParseAddress(sourceAccount)
		if err != nil {
			return "", errors.Wrap(err, "invalid source account")
		}
	}

	// Build set options operation
	setOptionsOp := &txnbuild.SetOptions{
		MasterWeight:    setMasterWeight,
		LowThreshold:    setLowThreshold,
		MediumThreshold: setMedThreshold,
		HighThreshold:   setHighThreshold,
		Signer:          setSigner,
	}

	tx, err := txnbuild.NewTransaction(
		txnbuild.TransactionParams{
			SourceAccount: &txnbuild.SimpleAccount{
				AccountID: sourceAccount,
				Sequence:  0,
			},
			Operations:  []txnbuild.Operation{setOptionsOp},
			BaseFee:     txnbuild.MinBaseFee * c.config.FeeMultiplier,
			Preconditions: txnbuild.Preconditions{
				TimeBounds: &txnbuild.Timebounds{
					MinTime: 0,
					MaxTime: uint64(time.Now().Add(5 * time.Minute).Unix()),
				},
			},
		},
	)
	if err != nil {
		return "", errors.Wrap(err, "failed to build transaction")
	}

	txXDR, err := tx.Base64()
	if err != nil {
		return "", errors.Wrap(err, "failed to encode transaction")
	}

	return txXDR, nil
}

// SignTransactionWithTSS signs a transaction using TSS
func (c *TreasuryClient) SignTransactionWithTSS(
	ctx context.Context,
	txXDR string,
	signature *tss.Signature,
) (string, error) {
	// Decode transaction XDR
	tx, err := txnbuild.TransactionFromXDR(txXDR)
	if err != nil {
		return "", errors.Wrap(err, "failed to decode transaction")
	}

	// Get the message hash to sign
	messageHash, err := network.HashTransactionInEnvelope(
		tx.Transaction,
		false,
		c.config.NetworkPassphrase,
	)
	if err != nil {
		return "", errors.Wrap(err, "failed to hash transaction")
	}

	// Verify signature matches message hash
	valid := tss.VerifySignature(
		c.config.MPCPublicKey.GetPublicKey().AsEd25519PublicKey(),
		messageHash[:],
		signature,
	)
	if !valid {
		return "", errors.New("TSS signature verification failed")
	}

	// In production, convert TSS signature to Ed25519 signature format
	// and attach to transaction

	// For now, return the original XDR
	// In production:
	// 1. Convert TSS (R, S) to Ed25519 signature bytes
	// 2. Create DecoratedSignature with MPC public key hint
	// 3. Add to transaction envelope

	return txXDR, nil
}

// SubmitTransaction submits a signed transaction to Stellar
func (c *TreasuryClient) SubmitTransaction(
	ctx context.Context,
	signedTxXDR string,
) (*TransactionResult, error) {
	// In production, submit to Horizon API
	// For now, return a mock result

	return &TransactionResult{
		TransactionHash: "mock_tx_hash",
		Ledger:          0,
		Success:         true,
		EnvelopeXDR:     signedTxXDR,
	}, nil
}

// BuildSigningRequest creates a signing request from a transaction
func (c *TreasuryClient) BuildSigningRequest(txXDR string, operationType string) (*SigningRequest, error) {
	// Decode and hash transaction
	tx, err := txnbuild.TransactionFromXDR(txXDR)
	if err != nil {
		return nil, errors.Wrap(err, "failed to decode transaction")
	}

	messageHash, err := network.HashTransactionInEnvelope(
		tx.Transaction,
		false,
		c.config.NetworkPassphrase,
	)
	if err != nil {
		return nil, errors.Wrap(err, "failed to hash transaction")
	}

	return &SigningRequest{
		TransactionXDR: txXDR,
		MessageHash:    messageHash[:],
		OperationType:  operationType,
		Metadata: map[string]string{
			"network": c.config.NetworkPassphrase,
		},
	}, nil
}

// VerifyTransactionSignature verifies a transaction signature
func (c *TreasuryClient) VerifyTransactionSignature(
	txXDR string,
	signature *tss.Signature,
) (bool, error) {
	tx, err := txnbuild.TransactionFromXDR(txXDR)
	if err != nil {
		return false, errors.Wrap(err, "failed to decode transaction")
	}

	messageHash, err := network.HashTransactionInEnvelope(
		tx.Transaction,
		false,
		c.config.NetworkPassphrase,
	)
	if err != nil {
		return false, errors.Wrap(err, "failed to hash transaction")
	}

	publicKey := c.config.MPCPublicKey
	if publicKey == nil {
		return false, errors.New("MPC public key not set")
	}

	return tss.VerifySignature(
		publicKey.GetPublicKey().AsEd25519PublicKey(),
		messageHash[:],
		signature,
	), nil
}

// GetNetworkPassphrase returns the configured network passphrase
func (c *TreasuryClient) GetNetworkPassphrase() string {
	return c.config.NetworkPassphrase
}

// GetHorizonURL returns the configured Horizon URL
func (c *TreasuryClient) GetHorizonURL() string {
	return c.config.HorizonURL
}

// ParseTransactionXDR parses a transaction XDR and returns details
func (c *TreasuryClient) ParseTransactionXDR(txXDR string) (map[string]interface{}, error) {
	tx, err := txnbuild.TransactionFromXDR(txXDR)
	if err != nil {
		return nil, errors.Wrap(err, "failed to decode transaction")
	}

	operations := make([]map[string]interface{}, 0, len(tx.Operations()))
	for _, op := range tx.Operations() {
		opMap := map[string]interface{}{
			"type": op.GetOp().Type.String(),
		}

		switch o := op.(type) {
		case *txnbuild.Payment:
			opMap["destination"] = o.Destination
			opMap["amount"] = o.Amount
			opMap["asset"] = o.Asset.GetCode()
		case *txnbuild.SetOptions:
			if o.MasterWeight != nil {
				opMap["master_weight"] = *o.MasterWeight
			}
			if o.LowThreshold != nil {
				opMap["low_threshold"] = *o.LowThreshold
			}
			if o.MediumThreshold != nil {
				opMap["medium_threshold"] = *o.MediumThreshold
			}
			if o.HighThreshold != nil {
				opMap["high_threshold"] = *o.HighThreshold
			}
		}

		operations = append(operations, opMap)
	}

	return map[string]interface{}{
		"source_account": tx.SourceAccount().AccountID,
		"sequence":       tx.Sequence(),
		"fee":            tx.Fee(),
		"operations":     operations,
		"memo":           tx.Memo(),
	}, nil
}

// EncodeSignature encodes a TSS signature for Stellar transaction
func EncodeSignature(signature *tss.Signature) ([]byte, error) {
	// Stellar/Ed25519 signatures are 64 bytes
	// TSS signature (R, S) needs to be converted

	rBytes := signature.R.Bytes()
	sBytes := signature.S.Bytes()

	// Pad to 32 bytes each
	rPadded := make([]byte, 32)
	sPadded := make([]byte, 32)
	copy(rPadded[32-len(rBytes):], rBytes)
	copy(sPadded[32-len(sBytes):], sBytes)

	// Concatenate R and S
	sigBytes := append(rPadded, sPadded...)

	return sigBytes, nil
}

// DecodeSignature decodes a Stellar signature to TSS format
func DecodeSignature(sigBytes []byte) (*tss.Signature, error) {
	if len(sigBytes) != 64 {
		return nil, errors.New("invalid signature length")
	}

	r := new(big.Int).SetBytes(sigBytes[:32])
	s := new(big.Int).SetBytes(sigBytes[32:])

	return &tss.Signature{R: r, S: s}, nil
}

// TreasuryOperationType represents types of treasury operations
type TreasuryOperationType string

const (
	OpPayment          TreasuryOperationType = "PAYMENT"
	OpSetOptions       TreasuryOperationType = "SET_OPTIONS"
	OpCreateAccount    TreasuryOperationType = "CREATE_ACCOUNT"
	OpManageData       TreasuryOperationType = "MANAGE_DATA"
	OpBumpSequence     TreasuryOperationType = "BUMP_SEQUENCE"
	OpManageSellOffer  TreasuryOperationType = "MANAGE_SELL_OFFER"
	OpManageBuyOffer   TreasuryOperationType = "MANAGE_BUY_OFFER"
)

// TreasuryRequest represents a treasury operation request
type TreasuryRequest struct {
	ID          string                `json:"id"`
	Type        TreasuryOperationType `json:"type"`
	Parameters  map[string]interface{} `json:"parameters"`
	RequesterID string                `json:"requester_id"`
	CreatedAt   time.Time             `json:"created_at"`
	Status      string                `json:"status"`
}

// Validate validates a treasury request
func (r *TreasuryRequest) Validate() error {
	if r.ID == "" {
		return errors.New("request ID required")
	}
	if r.Type == "" {
		return errors.New("operation type required")
	}
	if r.RequesterID == "" {
		return errors.New("requester ID required")
	}
	return nil
}
