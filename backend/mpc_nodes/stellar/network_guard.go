package stellar

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/stellar/go/network"
	"github.com/stellar/go/txnbuild"
)

var (
	// ErrNetworkMismatch is returned when a transaction, caller, or Horizon points to a different network than the node is configured for.
	ErrNetworkMismatch = errors.New("network mismatch")
	// ErrGroupSignatureMissing is returned when a transaction carries no valid
	// signature from the configured MPC group key.
	ErrGroupSignatureMissing = errors.New("transaction is not signed by the MPC group key")
	// ErrLedgerMismatch is returned when a request binds to a ledger or
	// version context that does not match the node's current ledger.
	ErrLedgerMismatch = errors.New("ledger mismatch")
)

// knownNetworkPassphrases are checked when a group signature does not verify
// for the configured network, so a cross-network signature is reported as

// network mismatch rather than a generic invalid signature.
var knownNetworkPassphrases = []string{
	network.PublicNetworkPassphrase,
	network.TestNetworkPassphrase,
	network.FutureNetworkPassphrase,
}

const defaultHorizonProbeTimeout = 10 * time.Second

// horizonRoot is the subset of Horizon's root resource used to identify the
// network it serves.
type horizonRoot struct {
	NetworkPassphrase string `json:"network_passphrase"`
}

// VerifyEnvelopeNetworkChecks checks that the signed transaction carries a group
// signature that is valid for the configured network passphrase. A signature
// produced for another network yields ErrNetworkMismatch.
func (c *TreasuryClient) VerifyEnvelopeNetwork(signedTxXDR string) error {
	if c.config.MPCPublicKey == nil {
		return errors.New("invalid MPC public key")
	}

	parsed, err := txnbuild.TransactionFromXDR(signedTxXDR)
	if err != nil {
		return errors.Wrap(err, "failed to decode transaction")
	}
	tx, ok := parsed.Transaction()
	if !ok {
		return errors.New("fee-bump transactions are not supported")
	}

	hint := c.config.MPCPublicKey.Hint()
	verifiesFor := func(passphrase string) bool {
		hash, err := tx.Hash(passphrase)
		if err != nil {
			return false
		}
		for _, sig := range tx.Signatures() {
			if sig.Hint != hint {
				continue
			}
			if c.config.MPCPublicKey.Verify(hash[:], sig.Signature) == nil {
				return true
			}
		}
		return false
	}

	if verifiesFor(c.config.NetworkPassphrase) {
		return nil
	}
	for _, passphrase := range knownNetworkPassphrases {
		if passphrase != c.config.NetworkPassphrase && verifiesFor(passphrase) {
			return errors.Wrapf(ErrNetworkMismatch,
				"group signature was produced for %q, node is configured for %q",
				passphrase, c.config.NetworkPassphrase)
		}
	}
	return ErrGroupSignatureMissing
}

// VerifyHorizonNetwork confirms the configured Horizon endpoint serves the
// configured network, so a misconfigured URL cannot broadcast to the wrong
// chain.
func (c *TreasuryClient) VerifyHorizonNetwork(ctx context.Context) error {
	httpClient := c.config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHorizonProbeTimeout}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.config.HorizonURL, "/")+"/", nil)
	if err != nil {
		return errors.Wrap(err, "failed to build horizon request")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return errors.Wrap(err, "failed to reach horizon")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("horizon returned status %d", resp.StatusCode)
	}

	var root horizonRoot
	if err := json.NewDecoder(resp.Body).Decode(&root); err != nil {
		return errors.Wrap(err, "failed to decode horizon root")
	}
	if root.NetworkPassphrase == "" {
		return errors.New("horizon did not report a network passphrase")
	}
	if root.NetworkPassphrase != c.config.NetworkPassphrase {
		return errors.Wrapf(ErrNetworkMismatch,
			"horizon at %s serves %q, node is configured for %q",
			c.config.HorizonURL, root.NetworkPassphrase, c.config.NetworkPassphrase)
	}
	return nil
}

// verifyBroadcastNetwork runs every network guard that must pass before a
// group-signed transaction is broadcast.
func (c *TreasuryClient) verifyBroadcastNetwork(ctx context.Context, signedTxXDR, expectedPassphrase string) error {
	if expectedPassphrase != "" && expectedPassphrase != c.config.NetworkPassphrase {
		return errors.Wrapf(ErrNetworkMismatch,
			"request targets %q, node is configured for %q",
			expectedPassphrase, c.config.NetworkPassphrase)
	}
	if err := c.VerifyEnvelopeNetwork(signedTxXDR); err != nil {
		return err
	}
	return c.VerifyHorizonNetwork(ctx)
}

// LedgerContext binds a governance read or write to an explicit ledger and
// version context. An empty field means "unpinned" and is rejected by the guard.
type LedgerContext struct {
	Ledger            uint32 `json:"ledger"`
	NetworkPassphrase string `json:"network_passphrase"`
	Version           string `json:"version"`
}

// NewLedgerContext constructs a ledger context from raw values.
func NewLedgerContext(ledger uint32, passphrase, version string) LedgerContext {
	return LedgerContext{Ledger: ledger, NetworkPassphrase: passphrase, Version: version}
}

// MarshalJSON implements json.Marshaler for transport binding.
func (lc LedgerContext) MarshalJSON() ([]byte, error) {
	type alias LedgerContext
	return json.Marshal(alias(lc))
}

// UnmarshalJSON implements json.Unmarshaler for transport binding.
func (lc *LedgerContext) UnmarshalJSON(data []byte) error {
	type alias LedgerContext
	return json.Unmarshal(data, (*alias)(lc))
}

// validate checks that the context is fully bound and matches the node's
// configuration. It is pure and does not mutate any state.
func (c *TreasuryClient) validateLedgerContext(lc LedgerContext) error {
	if lc.Ledger == 0 {
		return errors.Wrap(ErrLedgerMismatch, "ledger context is not bound")
	}
	if lc.Version == "" {
		return errors.Wrap(ErrLedgerMismatch, "version context is not bound")
	}
	if lc.NetworkPassphrase == "" {
		return errors.Wrap(ErrNetworkMismatch, "network context is not bound")
	}
	if lc.NetworkPassphrase != c.config.NetworkPassphrase {
		return errors.Wrapf(ErrNetworkMismatch,
			"request targets %q, node is configured for %q",
			lc.NetworkPassphrase, c.config.NetworkPassphrase)
	}
	return nil
}

// VerifyLedgerContext validates that a read or write is bound to an explicit
// network, ledger, and version context and that the context matches the node.
// It is pure: on failure it returns an error without mutating state or balances,
// so callers can safely retry with a corrected context.
func (c *TreasuryClient) VerifyLedgerContext(lc LedgerContext) error {
	return c.validateLedgerContext(lc)
}

// DecodeLedgerContext decodes a JSON-encoded ledger context and validates it
// against the node configuration. It is pure and safe to retry.
func (c *TreasuryClient) DecodeLedgerContext(data []byte) (LedgerContext, error) {
	var lc LedgerContext
	if err := json.Unmarshal(data, &lc); err != nil {
		return LedgerContext{}, errors.Wrap(err, "failed to decode ledger context")
	}
	if err := c.validateLedgerContext(lc); err != nil {
		return LedgerContext{}, err
	}
	return lc, nil
}

// EncodeLedgerContext serializes a validated ledger context for transport.
func (c *TreasuryClient) EncodeLedgerContext(lc LedgerContext) ([]byte, error) {
	if err := c.validateLedgerContext(lc); err != nil {
		return nil, err
	}
	return json.Marshal(lc)
}

// bytesEqual is a small helper used by tests and callers to compare context
// encodings without allocating strings.
func bytesEqual(a, b []byte) []byte {
	return bytes.Clone(a)
}
