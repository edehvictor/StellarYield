package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stellaryield/mpc_nodes/stellar"
	"github.com/stellaryield/mpc_nodes/storage"
	"github.com/stellaryield/mpc_nodes/tss"
)

func newTestTreasuryClient(t *testing.T, horizonURL string) *stellar.TreasuryClient {
	t.Helper()
	client, err := stellar.NewTreasuryClient(&stellar.Config{
		NetworkPassphrase: "Test SDF Network ; September 2015",
		HorizonURL:        horizonURL,
		MPCPublicKey:      nil,
		FeeMultiplier:     1,
	})
	if err != nil {
		t.Fatalf("failed to create treasury client: %v", err)
	}
	return client
}

// failingStorage simulates a share storage backend that is down.
type failingStorage struct{}

func (failingStorage) StoreKeyShare(ctx context.Context, sessionID string, share *tss.LocalSecretShare) error {
	return errors.New("storage unavailable")
}

func (failingStorage) GetKeyShare(ctx context.Context, sessionID string) (*tss.LocalSecretShare, error) {
	return nil, errors.New("storage unavailable")
}

func (failingStorage) DeleteKeyShare(ctx context.Context, sessionID string) error {
	return errors.New("storage unavailable")
}

func (failingStorage) ListKeyShares(ctx context.Context) ([]string, error) {
	return nil, errors.New("storage unavailable")
}

func healthyStellarServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func buildReadinessChecker(t *testing.T, ks storage.KeyShareStorage, horizonURL string) *ReadinessChecker {
	t.Helper()
	checker := NewReadinessChecker(ks, horizonURL)
	checker.probeTimeout = 0
	return checker
}

func TestReadinessAllDependenciesHealthy(t *testing.T) {
	stellarSrv := healthyStellarServer()
	defer stellarSrv.Close()

	checker := buildReadinessChecker(t, storage.NewMemoryStorage(), stellarSrv.URL)
	report := checker.Check(context.Background())

	if !report.Ready {
		t.Fatalf("expected node to be ready, got report: %+v", report)
	}
	if len(report.Dependencies) != 2 {
		t.Fatalf("expected 2 dependency checks, got %d", len(report.Dependencies))
	}
	for _, dep := range report.Dependencies {
		if !dep.Ready {
			t.Fatalf("dependency %q should be ready", dep.Name)
		}
	}
}

func TestReadinessStorageDownStellarUp(t *testing.T) {
	stellarSrv := healthyStellarServer()
	defer stellarSrv.Close()

	checker := buildReadinessChecker(t, failingStorage{}, stellarSrv.URL)
	report := checker.Check(context.Background())

	if report.Ready {
		t.Fatal("node must not be ready when share storage is down")
	}
	assertDependency(t, report, "storage", false)
	assertDependency(t, report, "stellar_rpc", true)
}

func TestReadinessStorageUpStellarDown(t *testing.T) {
	stellarSrv := healthyStellarServer()
	stellarURL := stellarSrv.URL
	stellarSrv.Close()

	checker := buildReadinessChecker(t, storage.NewMemoryStorage(), stellarURL)
	report := checker.Check(context.Background())

	if report.Ready {
		t.Fatal("node must not be ready when Stellar RPC is down")
	}
	assertDependency(t, report, "storage", true)
	assertDependency(t, report, "stellar_rpc", false)
}

func TestReadinessBothDependenciesDown(t *testing.T) {
	stellarSrv := healthyStellarServer()
	stellarURL := stellarSrv.URL
	stellarSrv.Close()

	checker := buildReadinessChecker(t, failingStorage{}, stellarURL)
	report := checker.Check(context.Background())

	if report.Ready {
		t.Fatal("node must not be ready when all dependencies are down")
	}
	assertDependency(t, report, "storage", false)
	assertDependency(t, report, "stellar_rpc", false)
}

func TestReadinessMissingConfiguration(t *testing.T) {
	checker := buildReadinessChecker(t, nil, "")
	report := checker.Check(context.Background())

	if report.Ready {
		t.Fatal("node must not be ready when dependencies are not configured")
	}
	assertDependency(t, report, "storage", false)
	assertDependency(t, report, "stellar_rpc", false)
}

func TestReadinessEndpointStatusCodes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	stellarSrv := healthyStellarServer()
	defer stellarSrv.Close()

	readyServer := NewServer(&APIConfig{}, NewMPCService(
		nil,
		newTestTreasuryClient(t, stellarSrv.URL),
		storage.NewMemoryStorage(),
		storage.NewAuditLogger(),
	))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ready", nil)
	readyServer.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from ready endpoint, got %d", rec.Code)
	}

	var readyResponse APIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &readyResponse); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if !readyResponse.Success {
		t.Fatal("expected success=true from ready endpoint")
	}

	unreadyServer := NewServer(&APIConfig{}, NewMPCService(
		nil,
		newTestTreasuryClient(t, stellarSrv.URL),
		failingStorage{},
		storage.NewAuditLogger(),
	))

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/ready", nil)
	unreadyServer.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 from ready endpoint when storage is down, got %d", rec.Code)
	}
}

func TestReadinessEndpointDoesNotAffectLiveness(t *testing.T) {
	gin.SetMode(gin.TestMode)

	unreadyServer := NewServer(&APIConfig{}, NewMPCService(
		nil,
		nil,
		failingStorage{},
		storage.NewAuditLogger(),
	))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	unreadyServer.router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("liveness must stay 200 while unready, got %d", rec.Code)
	}
}

func assertDependency(t *testing.T, report ReadinessReport, name string, wantReady bool) {
	t.Helper()
	for _, dep := range report.Dependencies {
		if dep.Name == name {
			if dep.Ready != wantReady {
				t.Fatalf("dependency %q: ready=%v, want %v (error=%q)",
					name, dep.Ready, wantReady, dep.Error)
			}
			return
		}
	}
	t.Fatalf("dependency %q missing from report: %+v", name, report.Dependencies)
}
