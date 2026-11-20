package stellar

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pkg/errors"
	"github.com/stellar/go/keypair"
	"github.com/stellar/go/network"
	"github.com/stellar/go/txnbuild"
)

func horizonServing(t *testing.T, passphrase string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"network_passphrase": passphrase})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newGuardedClient(t *testing.T, passphrase, horizonURL string, group *keypair.Full) *TreasuryClient {
	t.Helper()
	client, err := NewTreasuryClient(&Config{
		NetworkPassphrase: passphrase,
		HorizonURL:        horizonURL,
		MPCPublicKey:      group.FromAddress(),
		FeeMultiplier:     1,
	})
	if err != nil {
		t.Fatalf("NewTreasuryClient: %v", err)
	}
	return client
}

// signedPayment builds a payment from the group account signed by signer for
// the given network passphrase.
func signedPayment(t *testing.T, group, signer *keypair.Full, passphrase string) string {
	t.Helper()
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount: &txnbuild.SimpleAccount{AccountID: group.Address(), Sequence: 1},
		Operations: []txnbuild.Operation{&txnbuild.Payment{
			Destination: keypair.MustRandom().Address(),
			Amount:      "10",
			Asset:       txnbuild.NativeAsset{},
		}},
		BaseFee:       txnbuild.MinBaseFee,
		Preconditions: txnbuild.Preconditions{TimeBounds: txnbuild.NewInfiniteTimeout()},
	})
	if err != nil {
		t.Fatalf("NewTransaction: %v", err)
	}
	if signer != nil {
		if tx, err = tx.Sign(passphrase, signer); err != nil {
			t.Fatalf("Sign: %v", err)
		}
	}
	xdr, err := tx.Base64()
	if err != nil {
		t.Fatalf("Base64: %v", err)
	}
	return xdr
}

func TestSubmitTransactionMatchingNetwork(t *testing.T) {
	group := keypair.MustRandom()
	horizon := horizonServing(t, network.TestNetworkPassphrase)
	client := newGuardedClient(t, network.TestNetworkPassphrase, horizon.URL, group)
	signed := signedPayment(t, group, group, network.TestNetworkPassphrase)

	for _, expected := range []string{"", network.TestNetworkPassphrase} {
		result, err := client.SubmitTransaction(context.Background(), signed, expected)
		if err != nil {
			t.Fatalf("expected submission to pass (expected=%q): %v", expected, err)
		}
		if !result.Success || result.EnvelopeXDR != signed {
			t.Fatalf("unexpected result: %+v", result)
		}
	}
}

func TestSubmitTransactionSignedForOtherNetwork(t *testing.T) {
	group := keypair.MustRandom()
	horizon := horizonServing(t, network.TestNetworkPassphrase)
	client := newGuardedClient(t, network.TestNetworkPassphrase, horizon.URL, group)

	for _, other := range []string{network.PublicNetworkPassphrase, network.FutureNetworkPassphrase} {
		signed := signedPayment(t, group, group, other)
		_, err := client.SubmitTransaction(context.Background(), signed, "")
		if !errors.Is(err, ErrNetworkMismatch) {
			t.Fatalf("expected ErrNetworkMismatch for signature on %q, got %v", other, err)
		}
	}
}

func TestSubmitTransactionHorizonOnOtherNetwork(t *testing.T) {
	group := keypair.MustRandom()
	horizon := horizonServing(t, network.PublicNetworkPassphrase)
	client := newGuardedClient(t, network.TestNetworkPassphrase, horizon.URL, group)
	signed := signedPayment(t, group, group, network.TestNetworkPassphrase)

	_, err := client.SubmitTransaction(context.Background(), signed, "")
	if !errors.Is(err, ErrNetworkMismatch) {
		t.Fatalf("expected ErrNetworkMismatch for horizon on pubnet, got %v", err)
	}
}

func TestSubmitTransactionCallerExpectsOtherNetwork(t *testing.T) {
	group := keypair.MustRandom()
	horizon := horizonServing(t, network.TestNetworkPassphrase)
	client := newGuardedClient(t, network.TestNetworkPassphrase, horizon.URL, group)
	signed := signedPayment(t, group, group, network.TestNetworkPassphrase)

	_, err := client.SubmitTransaction(context.Background(), signed, network.PublicNetworkPassphrase)
	if !errors.Is(err, ErrNetworkMismatch) {
		t.Fatalf("expected ErrNetworkMismatch for caller-pinned pubnet, got %v", err)
	}
}

func TestSubmitTransactionRequiresGroupSignature(t *testing.T) {
	group := keypair.MustRandom()
	horizon := horizonServing(t, network.TestNetworkPassphrase)
	client := newGuardedClient(t, network.TestNetworkPassphrase, horizon.URL, group)

	cases := map[string]string{
		"unsigned":       signedPayment(t, group, nil, network.TestNetworkPassphrase),
		"foreign signer": signedPayment(t, group, keypair.MustRandom(), network.TestNetworkPassphrase),
	}
	for name, xdr := range cases {
		_, err := client.SubmitTransaction(context.Background(), xdr, "")
		if !errors.Is(err, ErrGroupSignatureMissing) {
			t.Fatalf("%s: expected ErrGroupSignatureMissing, got %v", name, err)
		}
	}
}

func TestSubmitTransactionFailsClosedWhenHorizonUnreachable(t *testing.T) {
	group := keypair.MustRandom()
	horizon := horizonServing(t, network.TestNetworkPassphrase)
	horizonURL := horizon.URL
	horizon.Close()

	client := newGuardedClient(t, network.TestNetworkPassphrase, horizonURL, group)
	signed := signedPayment(t, group, group, network.TestNetworkPassphrase)

	if _, err := client.SubmitTransaction(context.Background(), signed, ""); err == nil {
		t.Fatal("expected submission to fail when horizon network cannot be verified")
	}
}

func TestVerifyEnvelopeNetworkRequiresGroupKey(t *testing.T) {
	group := keypair.MustRandom()
	client, err := NewTreasuryClient(&Config{
		NetworkPassphrase: network.TestNetworkPassphrase,
		HorizonURL:        "http://unused",
		FeeMultiplier:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.VerifyEnvelopeNetwork(signedPayment(t, group, group, network.TestNetworkPassphrase)); err == nil {
		t.Fatal("expected error without configured MPC public key")
	}
}
