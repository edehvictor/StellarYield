package stellar

import (
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
	// ErrNetworkMismatch is returned when a transaction, caller, or Horizon
	// endpoint targets a different network than the node is configured for.
	ErrNetworkMismatch = errors.New("network mismatch")
	// ErrGroupSignatureMissing is returned when a transaction carries no valid
	// signature from the configured MPC group key.
	ErrGroupSignatureMissing = errors.New("transaction is not signed by the MPC group key")
)

// knownNetworkPassphrases are checked when a group signature does not verify
// for the configured network, so a cross-network signature is reported as a
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

// VerifyEnvelopeNetwork checks that the signed transaction carries a group
// signature that is valid for the configured network passphrase. A signature
// produced for another network yields ErrNetworkMismatch.
func (c *TreasuryClient) VerifyEnvelopeNetwork(signedTxXDR string) error {
	if c.config.MPCPublicKey == nil {
		return errors.New("MPC public key not set")
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
