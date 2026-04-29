# Contract Deployment Scripts

Repeatable testnet deployment for all Soroban contracts.

## Prerequisites

1. Install the Stellar CLI:
   ```bash
   cargo install --locked stellar-cli --features opt
   ```

2. Add the WASM target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

3. Install `jq` (used to format the output JSON):
   ```bash
   # macOS
   brew install jq
   # Ubuntu/Debian
   sudo apt-get install jq
   ```

4. Create and fund a testnet identity:
   ```bash
   stellar keys generate --global deployer --network testnet
   stellar keys fund deployer --network testnet
   ```

## Configuration

```bash
cp contracts/scripts/.env.deploy.example contracts/scripts/.env.deploy
```

Edit `.env.deploy` with your values. The file is gitignored — never commit secrets.

| Variable | Description |
|---|---|
| `STELLAR_RPC_URL` | Soroban RPC endpoint (default: Stellar testnet) |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase |
| `STELLAR_SOURCE_ACCOUNT` | Secret key (`S...`) or named CLI identity |

## Usage

Deploy all contracts:
```bash
bash contracts/scripts/deploy.sh
```

Deploy specific contracts:
```bash
bash contracts/scripts/deploy.sh yield_vault zap aa_factory
```

## Output

Deployed contract IDs are written to `contracts/scripts/deployed.json`:

```json
{
  "yield_vault": "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "zap": "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

This file can be consumed by other scripts or CI pipelines.

## Secrets

`.env.deploy` is listed in `.gitignore`. Never commit private keys or secret accounts.
