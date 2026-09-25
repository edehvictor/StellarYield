# MPC Treasury with Threshold Signature Scheme (TSS)

A production-grade Multi-Party Computation (MPC) treasury system implementing Threshold Signature Scheme (TSS) for enhanced operational security. This system replaces basic multi-sig with distributed key generation and signing, ensuring **zero exposure of private key shards** during execution.

## 🎯 Overview

### What is MPC Treasury?

MPC Treasury uses cryptographic secret sharing to distribute control of treasury funds across multiple parties. Unlike traditional multi-sig where each party holds a complete key, in MPC:

- **No single party ever holds the complete private key**
- **The private key is mathematically split into shards**
- **A threshold (t) of parties (n) must cooperate to sign**
- **Signatures are produced without reconstructing the private key**

### Security Benefits

| Feature | Traditional Multi-sig | MPC TSS |
|---------|----------------------|---------|
| Key Exposure | Each party has full key | Only shards exist |
| On-chain Visibility | All signers visible | Single aggregated key |
| Gas Cost | Higher (multiple sigs) | Lower (single sig) |
| Privacy | Signers public | Signers hidden |
| Flexibility | Fixed signers | Dynamic threshold |

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MPC Treasury Network                          │
│                                                                  │
│  ┌──────────┐         ┌──────────┐         ┌──────────┐        │
│  │  Node 1  │◄───────►│  Node 2  │◄───────►│  Node 3  │        │
│  │ (Party A)│  Libp2p │ (Party B)│  Libp2p │ (Party C)│        │
│  │  t=2,n=3 │  Gossip │  t=2,n=3 │  Gossip │  t=2,n=3 │        │
│  └────┬─────┘         └────┬─────┘         └────┬─────┘        │
│       │                    │                    │               │
│       └────────────────────┼────────────────────┘               │
│                            │                                    │
│                            ▼                                    │
│              ┌─────────────────────────┐                        │
│              │   TSS Signing Protocol   │                       │
│              │  (No key reconstruction) │                       │
│              └───────────┬─────────────┘                        │
│                          │                                      │
│                          ▼                                      │
│              ┌─────────────────────────┐                        │
│              │   Stellar Transaction    │                       │
│              │   (Single Signature)     │                       │
│              └───────────┬─────────────┘                        │
│                          │                                      │
│                          ▼                                      │
│              ┌─────────────────────────┐                        │
│              │   Stellar Blockchain     │                       │
│              └─────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

## 📦 Components

### 1. TSS Core (`/tss/`)

Implements the cryptographic primitives for threshold signatures:

- **Shamir's Secret Sharing**: Polynomial-based secret sharing
- **Key Generation**: Distributed key generation protocol
- **Signing Protocol**: Threshold signing without key reconstruction
- **Signature Aggregation**: Combine partial signatures into complete signature

```go
// Example: Creating a TSS coordinator
config := &tss.TSSConfig{
    Threshold:    2,  // Need 2 of 3 parties
    TotalParties: 3,
    PartyID:      "party_a",
}

coordinator, err := tss.NewTSSCoordinator(config)
```

### 2. Ceremony Coordinator (`/coordinator/`)

Manages the multi-phase ceremonies for key generation and signing:

**Key Generation Ceremony:**
1. **Commit Phase**: Each party generates share and broadcasts commitment
2. **Reveal Phase**: Parties reveal shares, verify commitments
3. **Verify Phase**: Aggregate public key from all shares
4. **Complete**: Store key shard securely

**Signing Ceremony:**
1. **Commit Phase**: Each party generates random value, broadcasts commitment
2. **Reveal Phase**: Parties reveal random values and signature shares
3. **Aggregate Phase**: Combine signature shares into complete signature

### 3. Secure Storage (`/storage/`)

Provides secure storage for key shards:

- **Memory Storage**: Ephemeral storage for testing
- **Encrypted Storage**: AES-256-GCM encrypted MongoDB storage
- **HSM Integration**: HashiCorp Vault, AWS KMS, GCP KMS, Azure Key Vault
- **Audit Logging**: Comprehensive audit trail for all key operations
- **Key Rotation**: Secure key share rotation protocol

### 4. Stellar Integration (`/stellar/`)

Integrates with Stellar blockchain:

- **Transaction Creation**: Build payment, set options, and custom transactions
- **TSS Signing**: Sign transactions with threshold signatures
- **Submission**: Submit signed transactions to Horizon
- **Verification**: Verify transaction signatures

### 5. HTTP API (`/api/`)

RESTful API for treasury operations:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/ceremony/keygen` | POST | Start key generation ceremony |
| `/api/v1/ceremony/signing` | POST | Start signing ceremony |
| `/api/v1/treasury/payment` | POST | Create payment transaction |
| `/api/v1/treasury/sign` | POST | Sign transaction with TSS |
| `/api/v1/treasury/submit` | POST | Submit signed transaction |
| `/api/v1/public-key` | GET | Get aggregated public key |

## 🔒 Security Model

### Zero Key Exposure

The fundamental security property of this MPC implementation:

```
Private Key = d (NEVER EXISTS as a single value)
Public Key = g^d (computed from shares)
Signature = (r, s) where:
  - r is agreed random value
  - s = Σ(s_i) where s_i are signature shares
  - d is NEVER reconstructed
```

### Threat Mitigation

| Threat | Mitigation |
|--------|------------|
| Single point compromise | Threshold (t) required |
| Key shard theft | Encrypted storage + HSM |
| Replay attacks | Nonce + timestamp validation |
| Man-in-the-middle | Libp2p noise encryption |
| Rogue key attacks | Commitment-reveal protocol |
| Side-channel attacks | Constant-time operations |

### Key Generation Security

```
1. Each party generates random share: s_i
2. Party computes commitment: C_i = H(s_i || nonce)
3. Parties broadcast commitments
4. Parties reveal shares with nonces
5. Verify: H(s_i || nonce) == C_i
6. Compute public key: PK = Σ(g^s_i)
```

### Signing Security

```
1. Each party generates random k_i
2. Compute commitment: C_i = H(k_i)
3. Parties broadcast commitments
4. Compute aggregated R = g^Σk_i
5. Compute signature share: s_i = k_i * H(m) + r * d_i
6. Aggregate: s = Σ(s_i)
7. Signature: (R, s)
```

## 📋 Quick Start

### Running an MPC Node

```bash
cd backend/mpc_nodes

# Build the node
go build -o mpc_node ./cmd/node

# Run Node 1 (Party A)
./mpc_node \
  --party-id party_a \
  --threshold 2 \
  --total-parties 3 \
  --api-port 8081 \
  --storage memory \
  --stellar-network "Stellar Test Network ; September 2015" \
  --stellar-horizon "https://horizon-testnet.stellar.org"

# Run Node 2 (Party B) - in another terminal
./mpc_node \
  --party-id party_b \
  --threshold 2 \
  --total-parties 3 \
  --api-port 8082 \
  ...

# Run Node 3 (Party C) - in another terminal
./mpc_node \
  --party-id party_c \
  --threshold 2 \
  --total-parties 3 \
  --api-port 8083 \
  ...
```

### Initiating Key Generation

```bash
# Start key generation ceremony
curl -X POST http://localhost:8081/api/v1/ceremony/keygen \
  -H "Content-Type: application/json" \
  -d '{
    "party_id": "party_a",
    "threshold": 2,
    "total_parties": 3
  }'
```

### Creating and Signing a Payment

```bash
# Create payment transaction
curl -X POST http://localhost:8081/api/v1/treasury/payment \
  -H "Content-Type: application/json" \
  -d '{
    "type": "PAYMENT",
    "source": "G...MPC_TREASURY_ADDRESS",
    "destination": "G...RECIPIENT_ADDRESS",
    "amount": "1000",
    "memo": "MPC Treasury Payment"
  }'

# Sign with TSS
curl -X POST http://localhost:8081/api/v1/treasury/sign \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_xdr": "AAAA...",
    "operation_type": "PAYMENT"
  }'

# Submit to Stellar
curl -X POST http://localhost:8081/api/v1/treasury/submit \
  -H "Content-Type: application/json" \
  -d '{
    "signed_transaction_xdr": "AAAA..."
  }'
```

## 🔧 Configuration

### Command-Line Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--party-id` | Unique party identifier | (required) |
| `--threshold` | Signature threshold (t) | 2 |
| `--total-parties` | Total parties (n) | 3 |
| `--api-port` | HTTP API port | 8080 |
| `--storage` | Storage type | memory |
| `--mongo-uri` | MongoDB connection string | |
| `--encryption-key` | AES-256 key (hex) | auto-generated |
| `--stellar-network` | Stellar network passphrase | Testnet |
| `--stellar-horizon` | Horizon API URL | Testnet |
| `--hsm-provider` | HSM provider | none |

### Storage Configuration

**Memory Storage (Testing):**
```bash
--storage memory
```

**MongoDB Storage (Production):**
```bash
--storage mongodb \
--mongo-uri "mongodb://user:pass@localhost:27017" \
--mongo-db "mpc_treasury" \
--mongo-collection "key_shares" \
--encryption-key "YOUR_64_HEX_CHAR_KEY"
```

**HSM Integration:**
```bash
--hsm-provider vault \
--hsm-key-uri "secret/data/mpc/shares" \
--hsm-region "us-east-1"
```

## 🧪 Testing

```bash
cd backend/mpc_nodes

# Run unit tests
go test ./...

# Run with coverage
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out

# Run specific package tests
go test ./tss -v
go test ./coordinator -v
go test ./storage -v
```

## 📊 Monitoring

### Prometheus Metrics

The MPC node exposes metrics at `/metrics`:

- `mpc_ceremony_total`: Total ceremonies initiated
- `mpc_ceremony_duration`: Ceremony duration histogram
- `mpc_signing_requests`: Pending signing requests
- `mpc_key_operations`: Key operation count
- `mpc_transaction_submitted`: Transactions submitted

### Audit Logging

All key operations are logged:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "action": "KEYGEN_CEREMONY_STARTED",
  "session_id": "abc123...",
  "party_id": "party_a",
  "success": true
}
```

## ⚠️ Production Considerations

### 1. Key Management

- **Never log or expose key shards**
- **Use HSM for shard storage in production**
- **Implement key rotation procedures**
- **Backup shards securely (encrypted, geographically distributed)**

### 2. Network Security

- **Use TLS for all API communications**
- **Authenticate ceremony participants**
- **Rate limit API endpoints**
- **Monitor for unusual signing patterns**

### 3. Operational Security

- **Run nodes in separate security domains**
- **Use separate infrastructure providers**
- **Implement monitoring and alerting**
- **Document incident response procedures**

### 4. Threshold Selection

| Threshold | Total Parties | Security | Availability | Use Case |
|-----------|---------------|----------|--------------|----------|
| 2 | 3 | High | High | Standard treasury |
| 3 | 5 | Very High | Medium | High-value treasury |
| 4 | 7 | Extreme | Medium | Critical infrastructure |

## 🚀 Deployment

### Docker Deployment

```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o mpc_node ./cmd/node

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/mpc_node /usr/local/bin/
ENTRYPOINT ["mpc_node"]
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mpc-node-party-a
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: mpc-node
        image: stellaryield/mpc-node:latest
        args:
        - --party-id=party_a
        - --threshold=2
        - --total-parties=3
        - --storage=mongodb
        env:
        - name: ENCRYPTION_KEY
          valueFrom:
            secretKeyRef:
              name: mpc-secrets
              key: encryption-key
```

## 📄 License

Part of the StellarYield project.
