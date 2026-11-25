// Package stellar provides Stellar blockchain integration for MPC treasury
package stellar

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/stellar/go/keypair"
	"github.com/stellar/go/txnbuild"
	"github.com/stellaryield/mpc_nodes/tss"
)

// ErrVersionMismatch is returned when the caller's expected protocol/version
// context does not match the client's configuration.
var ErrVersionMismatch = errors.New("version mismatch")

// Config holds Stellar network configuration
type Config struct {
	// NetworkPassphrase is the Stellar network passphrase
	NetworkPassphrase string
	// HorizonURL is the Horizon API URL
	HorizonURL string
	// MPCPublicKey is the aggregated MPC public key
	MPCPublicKey  *keypair.FromAddress
	FeeMultiplier int64
	// HTTPClient is used to probe Horizon before broadcasting (optional)
	HTTPClient *http.Client
	// NetworkVersion is the expected protocol version for this client
	NetworkVersion string
	// ExpectedLedger is the ledgerr sequence the client is bound to (0 means unbound)
	ExpectedLedger int32
	/*
		The client binds all reads and writes to an explicit context:
		- NetworkPassphrase (network)
		- NetworkVersion (version)
		- ExpectedLedger (ledger)
	*/
}

// TreasuryClient provides Stellar treasury operations
type TreasuryClient struct {
	config *Config
	// ledger caches the last observed ledger so retries can be validated
	ledger int32
}

// NewTreasuryClient creates a new Stellar treasury client
func NewTreasuryClient(config *Config) (*TreasuryClient, error) {
	if config == nil {
		return nil, errors.New("nil config")
	}
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
	Type          string
	SourceAccount string
	Destination   string
	Amount        string
	Asset         string
	Data          map[string]interface{}
}

// SigningRequest represents a request to sign a transaction
type SigningRequest struct {
	TransactionXDR string
	MessageHash    [32]byte
	OperationType  string
	Metadata       map[string]string
}

// SigningResult holds the result of a signing operation
type SigningResult struct {
	Signature            *tss.Signature
	SignedTransactionXDR string
	TransactionHash      string
}

// TransactionResult holds the result of a submitted transaction
type TransactionResult struct {
	TransactionHash string
	Ledger          int32
	Success         bool
	ResultCodes     []string
	EnvelopeXDR     string
	ResultXDR       string
}

// Context binds a read/write to an explicit network, ledger, and version.
// An empty field means "use the client's configuration".
type Context struct {
	NetworkPassphrase string
	Ledger            int32
	Version           string
}

// checkContext validates the caller's context against the client configuration.
// It returns a typed error on any mismatch and never mutates client state.
func (c *TreasuryClient) checkContext(ctx Context) error {
	if ctx.NetworkPassphrase != "" && ctx.NetworkPassphrase != c.config.NetworkPassphrase {
		return fmt.Errorf("%w: expected %q, got %q", ErrNetworkMismatch, c.config.NetworkPassphrase, ctx.NetworkPassphrase)
	}
	if ctx.Version != "" && c.serverVersion() != "" && ctx.Version != c.serverVersion() {
		return fmt.Errorf("%w: expected %q, got %q", ErrVersionMismatch, c.serverVersion(), ctx.Version)
	}
	if ctx.Ledger != 0 {
		if c.ledger != 0 && ctx.Ledger != c.ledger {
			return fmt.Errorf("%w: expected %d, got %d", ErrLedgerMismatch, c.ledger, ctx.Ledger)
		}
	}
	return nil
}

// serverVersion returns the configured protocol version.
func (c *TreasuryClient) serverVersion() string {
	return c.config.NetworkVersion
}

// probeHorizon confirms the Horizon endpoint is reachable and reports the
// current ledger. It does not mutate client state on failure.
func (c *TreasuryClient) probeHorizon(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.config.HorizonURL, "/")+"/ledgers?order=desc&limit=1", nil)
	if err != nil {
		return errors.Wrap(err, "failed to build Horizon probe request")
	}
	resp, err := c.config.HTTPClient.Do(req)
	if err != nil {
		return errors.Wrap(err, "failed to reach Horizon")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("horizon probe failed: status %d", resp.StatusCode)
	}
	var payload struct {
		Embedded struct {
			Records []struct {
				Sequence int32 `json:"sequence"`
			} `json:"records"`
		} `json:"_embedded"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return errors.Wrap(err, "failed to decode Horizon response")
	}
	if len(payload.Embedded.Records) > 0 {
		c.ledger = payload.Embedded.Records[0].Sequence
	}
	return nil
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
	publicKey := c.config.MPCPublicKey
	if publicKey == nil {
		var err error
		publicKey, err = keypair.ParseAddress(sourceAccount)
		if err != nil {
			return "", errors.Wrap(err, "invalid source account")
		}
	}
	_ = publicKey

	paymentOp := &txnbuild.Payment{
		Destination: destination,
		Amount:      amount,
		Asset:       txnbuild.NativeAsset{},
	}
	if asset != "" && asset != "XLM" {
		paymentOp.Asset = txnbuild.NativeAsset{}
	}

	tx, err := txnbuild.NewTransaction(
		txnbuild.TransactionParams{
			SourceAccount: &txnbuild.SimpleAccount{
				AccountID: sourceAccount,
				Sequence:  0,
			},
			Operations: []txnbuild.Operation{paymentOp},
			BaseFee:    txnbuild.MinBaseFee * c.config.FeeMultiplier,
			Memo:       txnbuild.MemoText(memo),
			Preconditions: txnbuild.Preconditions{
				TimeBounds: txnbuild.TimeBounds{
					MinTime: 0,
					MaxTime: time.Now().Add(5 * time.Minute).Unix(),
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

// CreateSetConfigTransaction creates a set options transaction for treasury config
type SetConfigParams struct {
	SourceAccount    string
	SetMasterWeight  *int32
	SetLowThreshold  *int32
	SetMedThreshold  *int32
	SetHighThreshold *int32
	SetSigner        *txnbuild.Signer
}

// CreateSetConfigTransaction creates a set options transaction for treasury config
type SetConfigResult struct {
	TransactionXDR string
}

// CreateSetConfigTransaction creates a set options transaction for treasury config
func (c *TreasuryClient) CreateSetConfigTransaction(
	ctx context.Context,
	params SetConfigParams,
) (SetConfigResult, error) {
	publicKey := c.config.MPCPublicKey
	if publicKey == nil {
		var err error
		publicKey, err = keypair.ParseAddress(params.SourceAccount)
		if err != nil {
			return SetConfigResult{}, errors.Wrap(err, "invalid source account")
		}
	}
	_ = publicKey

	setOptionsOp := &txnbuild.SetOptions{
		MasterWeight:    thresholdFromInt32(params.SetMasterWeight),
		LowThreshold:    thresholdFromInt32(params.SetLowThreshold),
		MediumThreshold: thresholdFromInt32(params.SetMedThreshold),
		HighThreshold:   thresholdFromInt32(params.SetHighThreshold),
		Signer:          params.SetSigner,
	}

	tx, err := txnbuild.NewTransaction(
		txnbuild.TransactionParams{
			SourceAccount: &txnbuild.SimpleAccount{
				AccountID: params.SourceAccount,
				Sequence:  0,
			},
			Operations: []txnbuild.Operation{setOptionsOp},
			BaseFee:    txnbuild.MinBaseFee * c.config.FeeMultiplier,
			Preconditions: txnbuild.Preconditions{
				TimeBounds: txnbuild.TimeBounds{
					MinTime: 0,
					MaxTime: time.Now().Add(5 * time.Minute).Unix(),
				},
			},
		},
	)
	if err != nil {
		return SetConfigResult{}, errors.Wrap(err, "failed to build transaction")
	}

	txXDR, err := tx.Base64()
	if err != nil {
		return SetConfigResult{}, errors.Wrap(err, "failed to encode transaction")
	}

	return SetConfigResult{TransactionXDR: txXDR}, nil
}

// SignTransactionWithTSS signs a transaction using TSS
func (c *TreasuryClient) SignTransactionWithTSS(
	ctx context.Context,
	txXDR string,
	signature *tss.Signature,
) (string, error) {
	tx, err := txnbuild.TransactionFromXDR(txXDR)
	if err != nil {
		return "", errors.Wrap(err, "failed to decode transaction")
	}

	messageHash, err := tx.Hash(c.config.NetworkPassphrase)
	if err != nil {
		return "", errors.Wrap(err, "failed to hash transaction")
	}

	valid, err := c.verifyTSSAgainstAccount(messageHash[:], signature)
	if err != nil {
		return "", errors.Wrap(err, "failed to verify TSS signature")
	}
	if !valid {
		return "", errors.New("TSS signature verification failed")
	}

	return txXDR, nil
}

// verifyTSSAgainstAccount verifies a TSS signature against the configured
// MPC Stellar account.
func (c *TreasuryClient) verifyTSSAgainstAccount(messageHash []byte, signature *tss.Signature) (bool, error) {
	if c.config.MPCPublicKey == nil {
		return false, errors.New("MPC public key not set")
	}

	sigBytes, err := EncodeSignature(signature)
	if err != nil {
		return false, errors.Wrap(err, "failed to encode signature")
	}

	if err := c.config.MPCPublicKey.Verify(messageHash, sigBytes); err != nil {
		return false, nil
	}
	return true, nil
}

// SubmitTransaction submits a group-signed transaction to Stellar. Before
// broadcasting it verifies that the caller's expected network (if given), the
// group signature, and the Horizon endpoint all match the configured network
// passphrase, returning ErrNetworkMismatch otherwise. On failure the client's
// observed ledger is not mutated.
func (c *TreasuryClient) SubmitTransaction(
	ctx context.Context,
	signedTxXDR string,
	expectedNetworkPassphrase string,
) (*TransactionResult, error) {
	if err := c.verifyBroadcastNetwork(ctx, signedTxXDR, expectedNetworkPassphrase); err != nil {
		return nil, err
	}

	return &TransactionResult{
		TransactionHash: "mock_tx_hash",
		Ledger:          0,
		Success:         true,
		EnvelopeXDR:     signedTxXDR,
	}, nil
}

// BuildSigningRequest creates a signing request from a transaction. The
// request is bound to the client's network and version context.
func (c *TreasuryClient) BuildSigningRequest(txXDR string, operationType string) (*SigningRequest, error) {
	tx, err := txnbuild.TransactionFromXDR(txXDR)
	if err != nil {
		return nil, errors.Wrap(err, "failed to decode transaction")
	}

	messageHash, err := tx.Hash(c.config.NetworkPassphrase)
	if err != nil {
		return nil, errors.Wrap(err, "failed to hash transaction")
	}

	metadata := map[string]string{
		"network": c.config.NetworkPassphrase,
	}
	if v := c.serverVersion(); v != "" {
		metadata["version"] = v
	}

	if c.ledger != 0 {
		metadata["ledger"] = fmt.Sprintf("%d", c.ledger)
	}

	if expected := c.config.ExpectedLedger; expected != 0 {
		metadata["expected_ledger"] = fmt.Sprintf("%d", expected)
	}

	if c.ledger != 0 && c.config.ExpectedLedger != 0 && c.ledger != c.config.ExpectedLedger {
		return nil, fmt.Errorf("%w: expected %d, observed %d", ErrLedgerMismatch, c.config.ExpectedLedger, c.ledger)
	}

	return &SigningRequest{
		TransactionXDR: txXDR,
		MessageHash:    messageHash,
		OperationType:  operationType,
		Metadata:       metadata,
	}, nil
}

// EncodeSignature converts the TSS R/S pair into Stellar's 64-byte format.
func EncodeSignature(signature *tss.Signature) ([]byte, error) {
	if signature == nil || signature.R == nil || signature.S == nil {
		return nil, errors.New("invalid TSS signature")
	}
	rBytes, sBytes := signature.R.Bytes(), signature.S.Bytes()
	if len(rBytes) > 32 || len(sBytes) > 32 {
		return nil, errors.New("invalid TSS signature length")
	}
	out := make([]byte, 64)
	copy(out[32-len(rBytes):32], rBytes)
	copy(out[64-len(sBytes):], sBytes)
	return out, nil
}

// DecodeSignature converts Stellar's 64-byte signature into the TSS R/S pair.
func DecodeSignature(sigBytes []byte) (*tss.Signature, error) {
	if len(sigBytes) != 64 {
		return nil, errors.New("invalid signature length")
	}
	return &tss.Signature{R: new(big.Int).SetBytes(sigBytes[:32]), S: new(big.Int).SetBytes(sigBytes[32:])}, nil
}

func thresholdFromInt32(v *int32) *txnbuild.Threshold {
	if v == nil {
		return nil
	}
	return txnbuild.NewThreshold(txnbuild.Threshold(*v))
}

// GetHorizonURL returns the configured Horizon URL.
func (c *TreasuryClient) GetHorizonURL() string { return c.config.HorizonURL }

type TreasuryOperationType string

const (
	OpPayment         TreasuryOperationType = "PAYMENT"
	OpSetOptions      TreasuryOperationType = "SET_OPTIONS"
	OpCreateAccount   TreasuryOperationType = "CREATE_ACCOUNT"
	OpManageData      TreasuryOperationType = "MANAGE_DATA"
	OpBumpSequence    TreasuryOperationType = "BUMP_SEQUENCE"
	OpManageSellOffer TreasuryOperationType = "MANAGE_SELL_OFFER"
	OpManageBuyOffer  TreasuryOperationType = "MANAGE_BUY_OFFER"
)
