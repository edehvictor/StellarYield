package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stellaryield/mpc_nodes/storage"
)

// defaultProbeTimeout bounds each individual readiness probe so a hung
// dependency cannot stall the endpoint.
const defaultProbeTimeout = 2 * time.Second

var (
	errStorageNotConfigured = errors.New("key share storage not configured")
	errStellarNotConfigured = errors.New("stellar RPC URL not configured")
)

// ReadinessProbe checks a single dependency and returns an error when the
// dependency is unusable.
type ReadinessProbe func(ctx context.Context) error

// DependencyStatus reports the outcome of one readiness probe.
type DependencyStatus struct {
	Name  string `json:"name"`
	Ready bool   `json:"ready"`
	Error string `json:"error,omitempty"`
}

// ReadinessReport is the result of a full readiness check. It is distinct
// from liveness (/health): a node can be alive while not ready to participate
// in ceremonies because a dependency is down.
type ReadinessReport struct {
	Ready        bool               `json:"ready"`
	CheckedAt    time.Time          `json:"checked_at"`
	Dependencies []DependencyStatus `json:"dependencies"`
}

// ReadinessChecker verifies that every dependency required for MPC
// participation is usable: key share storage and the Stellar RPC endpoint.
// The node is ready only when all dependencies pass (#1532).
type ReadinessChecker struct {
	storageProbe ReadinessProbe
	stellarProbe ReadinessProbe
	probeTimeout time.Duration
}

// NewReadinessChecker builds a checker for the given key share storage and
// Stellar Horizon RPC URL.
func NewReadinessChecker(ks storage.KeyShareStorage, horizonURL string) *ReadinessChecker {
	return &ReadinessChecker{
		storageProbe: func(ctx context.Context) error {
			if ks == nil {
				return errStorageNotConfigured
			}
			_, err := ks.ListKeyShares(ctx)
			return err
		},
		stellarProbe: stellarRPCProbe(horizonURL),
		probeTimeout: defaultProbeTimeout,
	}
}

// stellarRPCProbe returns a probe that confirms the Horizon endpoint answers
// HTTP. Any HTTP response (even an error status) proves the endpoint is
// reachable; only transport-level failures mark it unusable.
func stellarRPCProbe(horizonURL string) ReadinessProbe {
	client := &http.Client{Timeout: defaultProbeTimeout}
	return func(ctx context.Context) error {
		if horizonURL == "" {
			return errStellarNotConfigured
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, horizonURL, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		return nil
	}
}

// Check runs every probe and aggregates the results.
func (r *ReadinessChecker) Check(ctx context.Context) ReadinessReport {
	checks := []struct {
		name  string
		probe ReadinessProbe
	}{
		{"storage", r.storageProbe},
		{"stellar_rpc", r.stellarProbe},
	}

	report := ReadinessReport{
		Ready:        true,
		CheckedAt:    time.Now().UTC(),
		Dependencies: make([]DependencyStatus, 0, len(checks)),
	}

	for _, check := range checks {
		status := DependencyStatus{Name: check.name, Ready: true}

		probeCtx := ctx
		if r.probeTimeout > 0 {
			var cancel context.CancelFunc
			probeCtx, cancel = context.WithTimeout(ctx, r.probeTimeout)
			defer cancel()
		}

		if err := check.probe(probeCtx); err != nil {
			status.Ready = false
			status.Error = err.Error()
			report.Ready = false
		}

		report.Dependencies = append(report.Dependencies, status)
	}

	return report
}

// readinessCheck handles readiness probe requests. It returns 503 while any
// required dependency is unusable so orchestrators and load balancers stop
// routing MPC traffic to this node.
func (s *Server) readinessCheck(c *gin.Context) {
	report := s.readiness.Check(c.Request.Context())

	statusCode := http.StatusOK
	if !report.Ready {
		statusCode = http.StatusServiceUnavailable
	}

	c.JSON(statusCode, APIResponse{
		Success: report.Ready,
		Data:    report,
	})
}
