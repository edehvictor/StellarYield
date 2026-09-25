// Global setup for tests — defines mandatory environment variables
// so that config.ts's requireEnv() doesn't throw during test loading.

process.env.VAULT_CONTRACT_ID = 'CAL7654321';
process.env.STABLECOIN_MANAGER_CONTRACT_ID = 'CSM1234567';
process.env.KEEPER_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
process.env.STELLAR_NETWORK = 'testnet';
process.env.NODE_ENV = 'test';
