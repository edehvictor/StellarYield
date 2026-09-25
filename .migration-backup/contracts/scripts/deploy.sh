#!/usr/bin/env bash
# =============================================================================
# Stellar Testnet Deployment Script
# Deploys key contracts to Stellar testnet using Soroban CLI.
#
# Prerequisites:
#   - soroban CLI installed: https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli
#   - Rust + cargo installed with wasm32-unknown-unknown target:
#       rustup target add wasm32-unknown-unknown
#   - A funded testnet account (source keypair)
#
# Usage:
#   cp contracts/scripts/.env.deploy.example contracts/scripts/.env.deploy
#   # Edit .env.deploy with your values
#   bash contracts/scripts/deploy.sh [CONTRACT...]
#
# Examples:
#   bash contracts/scripts/deploy.sh                  # deploy all contracts
#   bash contracts/scripts/deploy.sh yield_vault zap  # deploy specific contracts
#
# Output:
#   contracts/scripts/deployed.json  — machine-readable map of contract IDs
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env.deploy"
OUTPUT_FILE="$SCRIPT_DIR/deployed.json"

# ---------------------------------------------------------------------------
# Load environment
# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found."
  echo "Copy $SCRIPT_DIR/.env.deploy.example and fill in your values."
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

: "${STELLAR_RPC_URL:?STELLAR_RPC_URL must be set in .env.deploy}"
: "${STELLAR_NETWORK_PASSPHRASE:?STELLAR_NETWORK_PASSPHRASE must be set in .env.deploy}"
: "${STELLAR_SOURCE_ACCOUNT:?STELLAR_SOURCE_ACCOUNT must be set in .env.deploy}"

# ---------------------------------------------------------------------------
# Contracts to deploy (name = directory under contracts/)
# Override by passing names as CLI args.
# ---------------------------------------------------------------------------
ALL_CONTRACTS=(yield_vault zap aa_factory aa_recovery settlement intent_swap liquid_staking emission_controller ve_tokenomics stablecoin_manager)

if [[ $# -gt 0 ]]; then
  CONTRACTS=("$@")
else
  CONTRACTS=("${ALL_CONTRACTS[@]}")
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy] WARN: $*" >&2; }

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found. Please install it first."
    exit 1
  fi
}

require_cmd stellar
require_cmd cargo
require_cmd jq

# ---------------------------------------------------------------------------
# Build all requested contracts
# ---------------------------------------------------------------------------
log "Building contracts: ${CONTRACTS[*]}"

for contract in "${CONTRACTS[@]}"; do
  dir="$CONTRACTS_DIR/$contract"
  if [[ ! -d "$dir" ]]; then
    warn "Contract directory '$dir' not found — skipping."
    continue
  fi

  log "  Building $contract..."
  stellar contract build \
    --manifest-path "$dir/Cargo.toml" \
    --out-dir "$dir/target/wasm32-unknown-unknown/release" \
    2>&1 | sed "s/^/    /"
done

# ---------------------------------------------------------------------------
# Deploy each contract and collect IDs
# ---------------------------------------------------------------------------
declare -A DEPLOYED_IDS

for contract in "${CONTRACTS[@]}"; do
  dir="$CONTRACTS_DIR/$contract"
  wasm_file=$(find "$dir/target/wasm32-unknown-unknown/release" -name "*.wasm" 2>/dev/null | head -1)

  if [[ -z "$wasm_file" ]]; then
    warn "No WASM found for $contract — skipping deploy."
    continue
  fi

  log "  Deploying $contract from $wasm_file..."

  contract_id=$(stellar contract deploy \
    --wasm "$wasm_file" \
    --source-account "$STELLAR_SOURCE_ACCOUNT" \
    --rpc-url "$STELLAR_RPC_URL" \
    --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
    2>&1)

  if [[ $? -ne 0 ]]; then
    warn "Deploy failed for $contract: $contract_id"
    continue
  fi

  # stellar contract deploy prints the contract ID on the last line
  contract_id=$(echo "$contract_id" | tail -1 | tr -d '[:space:]')
  DEPLOYED_IDS["$contract"]="$contract_id"
  log "  $contract => $contract_id"
done

# ---------------------------------------------------------------------------
# Write deployed.json
# ---------------------------------------------------------------------------
log "Writing $OUTPUT_FILE..."

{
  echo "{"
  first=true
  for contract in "${!DEPLOYED_IDS[@]}"; do
    [[ "$first" == "true" ]] || echo ","
    printf '  "%s": "%s"' "$contract" "${DEPLOYED_IDS[$contract]}"
    first=false
  done
  echo ""
  echo "}"
} | jq . > "$OUTPUT_FILE"

log "Done. Contract IDs written to $OUTPUT_FILE"
cat "$OUTPUT_FILE"

# ---------------------------------------------------------------------------
# Update contracts/registry.json with deployed IDs (#185)
# ---------------------------------------------------------------------------
REGISTRY_FILE="$SCRIPT_DIR/../registry.json"
NETWORK_KEY="testnet"
if [[ "$STELLAR_NETWORK_PASSPHRASE" == *"mainnet"* ]] || [[ "$STELLAR_NETWORK_PASSPHRASE" == *"Public Global"* ]]; then
  NETWORK_KEY="mainnet"
elif [[ "$STELLAR_RPC_URL" == *"localhost"* ]] || [[ "$STELLAR_RPC_URL" == *"local"* ]]; then
  NETWORK_KEY="local"
fi

# Map deploy contract names to registry keys
declare -A REGISTRY_KEY_MAP=(
  ["yield_vault"]="vault"
  ["zap"]="zap"
  ["strategies"]="strategy"
  ["optimistic_governance"]="governance"
  ["emission_controller"]="emissionController"
  ["liquid_staking"]="liquidStaking"
  ["stableswap"]="stableswap"
)

REGISTRY_UPDATES=()
for contract in "${!DEPLOYED_IDS[@]}"; do
  registry_key="${REGISTRY_KEY_MAP[$contract]:-$contract}"
  REGISTRY_UPDATES+=(".${NETWORK_KEY}.${registry_key} = \"${DEPLOYED_IDS[$contract]}\"")
done

if [[ ${#REGISTRY_UPDATES[@]} -gt 0 && -f "$REGISTRY_FILE" ]]; then
  JQ_FILTER=$(printf " | %s" "${REGISTRY_UPDATES[@]}")
  JQ_FILTER="${JQ_FILTER:3}" # strip leading " | "
  jq "$JQ_FILTER" "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp" && mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"
  log "Registry updated at $REGISTRY_FILE (network: $NETWORK_KEY)"
fi
