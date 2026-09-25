// Package api provides the HTTP API for MPC treasury operations
package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pkg/errors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stellaryield/mpc_nodes/coordinator"
	"github.com/stellaryield/mpc_nodes/stellar"
	"github.com/stellaryield/mpc_nodes/storage"
	"github.com/stellaryield/mpc_nodes/tss"
)

// APIConfig holds API server configuration
type APIConfig struct {
	// Port is the HTTP port to listen on
	Port int
	// EnableMetrics enables Prometheus metrics endpoint
	EnableMetrics bool
	// EnableCORS enables CORS
	EnableCORS bool
	// AllowedOrigins is the list of allowed CORS origins
	AllowedOrigins []string
}

// MPCService provides MPC treasury operations
type MPCService struct {
	ceremonyCoord *coordinator.CeremonyCoordinator
	treasuryClient *stellar.TreasuryClient
	storage       storage.KeyShareStorage
	audit         *storage.AuditLogger
}

// Server is the HTTP API server
type Server struct {
	config  *APIConfig
	service *MPCService
	router  *gin.Engine
}

// APIResponse represents a standard API response
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Code    string      `json:"code,omitempty"`
}

// KeyGenRequest represents a key generation request
type KeyGenRequest struct {
	PartyID     string `json:"party_id" binding:"required"`
	Threshold   int    `json:"threshold" binding:"required,min=1"`
	TotalParties int   `json:"total_parties" binding:"required,min=1"`
}

// SigningRequest represents a signing request
type SigningRequest struct {
	TransactionXDR string            `json:"transaction_xdr" binding:"required"`
	OperationType  string            `json:"operation_type"`
	Metadata       map[string]string `json:"metadata"`
}

// TreasuryRequest represents a treasury operation request
type TreasuryRequest struct {
	Type        stellar.TreasuryOperationType `json:"type" binding:"required"`
	Source      string                        `json:"source" binding:"required"`
	Destination string                        `json:"destination"`
	Amount      string                        `json:"amount"`
	Memo        string                        `json:"memo"`
}

// NewServer creates a new API server
func NewServer(config *APIConfig, service *MPCService) *Server {
	router := gin.Default()

	server := &Server{
		config:  config,
		service: service,
		router:  router,
	}

	server.setupRoutes()

	return server
}

// setupRoutes configures the API routes
func (s *Server) setupRoutes() {
	// CORS middleware
	if s.config.EnableCORS {
		s.router.Use(corsMiddleware(s.config.AllowedOrigins))
	}

	// Health check
	s.router.GET("/health", s.healthCheck)

	// Metrics
	if s.config.EnableMetrics {
		s.router.GET("/metrics", gin.WrapH(promhttp.Handler()))
	}

	// API v1 routes
	v1 := s.router.Group("/api/v1")
	{
		// Key generation ceremony
		v1.POST("/ceremony/keygen", s.startKeyGenCeremony)
		v1.POST("/ceremony/keygen/commit", s.submitKeyGenCommit)
		v1.POST("/ceremony/keygen/reveal", s.submitKeyGenReveal)
		v1.GET("/ceremony/keygen/status/:session_id", s.getKeyGenStatus)

		// Signing ceremony
		v1.POST("/ceremony/signing", s.startSigningCeremony)
		v1.POST("/ceremony/signing/commit", s.submitSigningCommit)
		v1.POST("/ceremony/signing/reveal", s.submitSigningReveal)
		v1.GET("/ceremony/signing/status/:session_id", s.getSigningStatus)

		// Treasury operations
		v1.POST("/treasury/payment", s.createPayment)
		v1.POST("/treasury/sign", s.signTransaction)
		v1.POST("/treasury/submit", s.submitTransaction)
		v1.GET("/treasury/transaction/:hash", s.getTransactionStatus)

		// Key management
		v1.GET("/keys/list", s.listKeys)
		v1.DELETE("/keys/:session_id", s.deleteKey)
		v1.POST("/keys/rotate", s.rotateKey)

		// Public key
		v1.GET("/public-key", s.getPublicKey)
	}
}

// Run starts the HTTP server
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", s.config.Port),
		Handler:      s.router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server in goroutine
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			s.service.audit.Log(&storage.AuditLogEntry{
				Timestamp:   time.Now(),
				Action:      "SERVER_ERROR",
				Success:     false,
				ErrorMessage: err.Error(),
			})
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()

	// Graceful shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return srv.Shutdown(shutdownCtx)
}

// healthCheck handles health check requests
func (s *Server) healthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"status":    "healthy",
			"timestamp": time.Now().UTC(),
		},
	})
}

// startKeyGenCeremony handles key generation ceremony initiation
func (s *Server) startKeyGenCeremony(c *gin.Context) {
	var req KeyGenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	// In production, create ceremony coordinator with request params
	// For now, return mock response

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "KEYGEN_CEREMONY_STARTED",
		PartyID:   req.PartyID,
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id":    "mock_session_id",
			"party_id":      req.PartyID,
			"threshold":     req.Threshold,
			"total_parties": req.TotalParties,
			"status":        "INIT",
		},
	})
}

// submitKeyGenCommit handles key generation commit submission
func (s *Server) submitKeyGenCommit(c *gin.Context) {
	sessionID := c.Param("session_id")

	// Process commit message
	// In production, broadcast to other parties

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "KEYGEN_COMMIT_SUBMITTED",
		SessionID: sessionID,
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id": sessionID,
			"status":     "COMMIT_RECEIVED",
		},
	})
}

// submitKeyGenReveal handles key generation reveal submission
func (s *Server) submitKeyGenReveal(c *gin.Context) {
	sessionID := c.Param("session_id")

	// Process reveal message
	// In production, verify commitment and aggregate public key

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "KEYGEN_REVEAL_SUBMITTED",
		SessionID: sessionID,
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id": sessionID,
			"status":     "REVEAL_RECEIVED",
		},
	})
}

// getKeyGenStatus handles key generation status queries
func (s *Server) getKeyGenStatus(c *gin.Context) {
	sessionID := c.Param("session_id")

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id":   sessionID,
			"phase":        "COMPLETE",
			"participants": []string{"party1", "party2", "party3"},
		},
	})
}

// startSigningCeremony handles signing ceremony initiation
func (s *Server) startSigningCeremony(c *gin.Context) {
	var req SigningRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	// Build signing request from transaction
	signingReq, err := s.service.treasuryClient.BuildSigningRequest(
		req.TransactionXDR,
		req.OperationType,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "BUILD_SIGNING_REQUEST_FAILED",
		})
		return
	}

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "SIGNING_CEREMONY_STARTED",
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id":   hex.EncodeToString(signingReq.MessageHash),
			"message_hash": hex.EncodeToString(signingReq.MessageHash),
			"status":       "INIT",
		},
	})
}

// submitSigningCommit handles signing commit submission
func (s *Server) submitSigningCommit(c *gin.Context) {
	sessionID := c.Param("session_id")

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "SIGNING_COMMIT_SUBMITTED",
		SessionID: sessionID,
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id": sessionID,
			"status":     "COMMIT_RECEIVED",
		},
	})
}

// submitSigningReveal handles signing reveal submission
func (s *Server) submitSigningReveal(c *gin.Context) {
	sessionID := c.Param("session_id")

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "SIGNING_REVEAL_SUBMITTED",
		SessionID: sessionID,
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id": sessionID,
			"status":     "SIGNATURE_COMPLETE",
		},
	})
}

// getSigningStatus handles signing status queries
func (s *Server) getSigningStatus(c *gin.Context) {
	sessionID := c.Param("session_id")

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id": sessionID,
			"phase":      "COMPLETE",
			"signature":  "mock_signature",
		},
	})
}

// createPayment handles payment transaction creation
func (s *Server) createPayment(c *gin.Context) {
	var req TreasuryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	txXDR, err := s.service.treasuryClient.CreatePaymentTransaction(
		c.Request.Context(),
		req.Source,
		req.Destination,
		req.Amount,
		"",
		req.Memo,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "CREATE_TRANSACTION_FAILED",
		})
		return
	}

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "PAYMENT_CREATED",
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"transaction_xdr": txXDR,
			"type":            req.Type,
		},
	})
}

// signTransaction handles transaction signing
func (s *Server) signTransaction(c *gin.Context) {
	var req SigningRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	// In production, initiate TSS signing ceremony
	// For now, return mock response

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"signed_transaction_xdr": req.TransactionXDR,
			"signature":              "mock_signature",
		},
	})
}

// submitTransaction handles transaction submission
func (s *Server) submitTransaction(c *gin.Context) {
	var req struct {
		SignedTransactionXDR string `json:"signed_transaction_xdr" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	result, err := s.service.treasuryClient.SubmitTransaction(
		c.Request.Context(),
		req.SignedTransactionXDR,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "SUBMIT_TRANSACTION_FAILED",
		})
		return
	}

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "TRANSACTION_SUBMITTED",
		Success:   result.Success,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data:    result,
	})
}

// getTransactionStatus handles transaction status queries
func (s *Server) getTransactionStatus(c *gin.Context) {
	hash := c.Param("hash")

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"hash":    hash,
			"status":  "SUCCESS",
			"ledger":  12345,
		},
	})
}

// listKeys handles key listing
func (s *Server) listKeys(c *gin.Context) {
	keys, err := s.service.storage.ListKeyShares(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "LIST_KEYS_FAILED",
		})
		return
	}

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"keys": keys,
			"count": len(keys),
		},
	})
}

// deleteKey handles key deletion
func (s *Server) deleteKey(c *gin.Context) {
	sessionID := c.Param("session_id")

	if err := s.service.storage.DeleteKeyShare(c.Request.Context(), sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "DELETE_KEY_FAILED",
		})
		return
	}

	s.service.audit.Log(&storage.AuditLogEntry{
		Timestamp: time.Now(),
		Action:    "KEY_DELETED",
		SessionID: sessionID,
		Success:   true,
	})

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"session_id": sessionID,
			"deleted":    true,
		},
	})
}

// rotateKey handles key rotation
func (s *Server) rotateKey(c *gin.Context) {
	var req struct {
		OldSessionID string `json:"old_session_id" binding:"required"`
		NewSessionID string `json:"new_session_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, APIResponse{
			Success: false,
			Error:   err.Error(),
			Code:    "INVALID_REQUEST",
		})
		return
	}

	// In production, perform key rotation ceremony

	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"old_session_id": req.OldSessionID,
			"new_session_id": req.NewSessionID,
			"rotated":        true,
		},
	})
}

// getPublicKey handles public key queries
func (s *Server) getPublicKey(c *gin.Context) {
	// In production, return the aggregated MPC public key
	c.JSON(http.StatusOK, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"public_key": "mock_public_key",
			"format":     "ed25519",
		},
	})
}

// corsMiddleware provides CORS support
func corsMiddleware(origins []string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Origin, Content-Type, Authorization")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}

// NewMPCService creates a new MPC service
func NewMPCService(
	ceremonyCoord *coordinator.CeremonyCoordinator,
	treasuryClient *stellar.TreasuryClient,
	storage storage.KeyShareStorage,
	audit *storage.AuditLogger,
) *MPCService {
	return &MPCService{
		ceremonyCoord: ceremonyCoord,
		treasuryClient: treasuryClient,
		storage:       storage,
		audit:         audit,
	}
}
