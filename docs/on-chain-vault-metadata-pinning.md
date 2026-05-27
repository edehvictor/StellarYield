# On-Chain Vault Metadata Pinning

This workflow describes how to generate, validate, and pin vault metadata to IPFS before a release.

## Metadata requirements

Each vault metadata payload must include:

- `vaultName` — human-readable vault identifier
- `description` — short summary of the strategy or product
- `iconSvg` — inline SVG string containing the vault icon

### Icon SVG constraints

- Must be valid SVG markup (`<svg ...>...</svg>`)
- Must not include `<script>` tags or inline event handlers (`onload=`, `onclick=`, etc.)
- Must be under 20KB in size for reliable pinning

## Validation

The backend validation helper is located at `server/src/services/ipfs/vaultMetadataService.ts`.
It enforces required fields, SVG validity, and a moderate icon size cap.

## Pinning workflow

Use the manual GitHub action or the script below to pin release metadata.

### Script usage

```bash
cd server
npx ts-node scripts/pin-vault-metadata.ts --input=server/vault-metadata.json
```

The script will validate the payload and upload the icon and metadata to IPFS using `PINATA_JWT` if configured.

### GitHub Action

A workflow has been added at `.github/workflows/pin-vault-metadata.yml`.
It can be executed manually via `workflow_dispatch` and uses the same validation pipeline.

## Metadata validation checklist

Before pinning, verify each item:

- [ ] `vaultName` is a non-empty string
- [ ] `description` is a non-empty string
- [ ] `iconSvg` is valid SVG markup (contains `<svg`)
- [ ] `iconSvg` contains no `<script>` tags
- [ ] `iconSvg` contains no inline event handlers (`onclick=`, `onload=`, etc.)
- [ ] `iconSvg` contains no `javascript:` URIs
- [ ] Icon file size is under 20 KB

Run the automated validation before pinning:

```bash
cd server
npx ts-node scripts/pin-vault-metadata.ts --input=vault-metadata.json
```

## Recommended release checklist entry

- Validate metadata with `server/scripts/pin-vault-metadata.ts`
- Confirm the returned `metadataUri` and `iconUri` are valid `ipfs://` URIs
- Record the pinned CID in release notes and smart contract metadata references
- Run `npm test -- --testPathPattern=vaultMetadataValidation` to verify edge cases pass
