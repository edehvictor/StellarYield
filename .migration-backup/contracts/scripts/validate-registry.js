/**
 * validate-registry.js
 * 
 * Validates the contract registry JSON file for required networks, 
 * correctly formatted contract IDs, and duplicate entries.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '../registry.json');

const REQUIRED_NETWORKS = ['testnet', 'mainnet'];
const REQUIRED_CONTRACTS = [
    'vault',
    'zap',
    'token',
    'governance',
    'strategy'
];

// Soroban addresses are 56 characters and start with 'C'
// Stellar public keys are 56 characters and start with 'G'
const ADDR_REGEX = /^[CG][A-Z2-7]{55}$/;

function validate() {
    console.log('--- Validating Contract Registry ---');
    
    if (!fs.existsSync(REGISTRY_PATH)) {
        console.error('FAIL: registry.json not found at ' + REGISTRY_PATH);
        process.exit(1);
    }

    let registry;
    try {
        const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
        registry = JSON.parse(raw);
    } catch (err) {
        console.error('FAIL: Failed to parse registry.json: ' + err.message);
        process.exit(1);
    }

    let errors = [];
    let warnings = [];

    // 1. Check for required networks
    for (const network of REQUIRED_NETWORKS) {
        if (!registry[network]) {
            errors.push(`Missing required network: ${network}`);
        }
    }

    // 2. Validate each network
    for (const [network, contracts] of Object.entries(registry)) {
        if (network === '_comment') continue;

        console.log(`Checking network: ${network}...`);

        // Check required contracts for standard networks
        if (REQUIRED_NETWORKS.includes(network)) {
            for (const req of REQUIRED_CONTRACTS) {
                if (!(req in contracts)) {
                    errors.push(`Network [${network}] is missing required contract: ${req}`);
                }
            }
        }

        const addresses = new Set();
        const entries = Object.entries(contracts);

        for (const [alias, address] of entries) {
            // Check for empty values (warning for non-testnet/mainnet, error for required ones if they should be there)
            if (!address) {
                if (REQUIRED_NETWORKS.includes(network) && REQUIRED_CONTRACTS.includes(alias)) {
                    errors.push(`Network [${network}] has empty address for required contract: ${alias}`);
                } else {
                    warnings.push(`Network [${network}] has empty address for: ${alias}`);
                }
                continue;
            }

            // Check address format
            if (!ADDR_REGEX.test(address)) {
                errors.push(`Network [${network}] has malformed address for [${alias}]: ${address}`);
            }

            // Check for duplicate addresses within the same network
            if (addresses.has(address)) {
                warnings.push(`Network [${network}] has duplicate address for [${alias}]: ${address}`);
            } else {
                addresses.add(address);
            }
        }
    }

    // Output results
    if (warnings.length > 0) {
        console.warn('\n--- Warnings ---');
        warnings.forEach(w => console.warn('WARN: ' + w));
    }

    if (errors.length > 0) {
        console.error('\n--- Errors ---');
        errors.forEach(e => console.error('FAIL: ' + e));
        console.log('\nResult: FAILED');
        process.exit(1);
    } else {
        console.log('\nResult: PASSED');
        process.exit(0);
    }
}

validate();
