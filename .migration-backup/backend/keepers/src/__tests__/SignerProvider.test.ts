jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: jest.fn().mockReturnValue('GPROVIDER_PUBLIC'),
        sign: jest.fn(),
      }),
    },
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: jest.fn().mockReturnValue({ toXDR: () => 'reconstructed-signed-xdr' }),
    },
  };
});

import {
  LocalSignerProvider,
  EnvSignerProvider,
  ExternalSignerProvider,
  NotImplementedError,
  DEFAULT_ALLOWED_OPERATIONS,
} from '../signer/SignerProvider';

describe('LocalSignerProvider', () => {
  const FAKE_SECRET = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  test('exposes a non-secret id and the keypair public key', () => {
    const provider = new LocalSignerProvider(FAKE_SECRET);
    expect(provider.publicKey).toBe('GPROVIDER_PUBLIC');
    expect(provider.id).toBe('local:GPROVIDER_PUBLIC');
    expect(provider.id).not.toContain(FAKE_SECRET);
  });

  test('defaults to the standard keeper operation allowlist', () => {
    const provider = new LocalSignerProvider(FAKE_SECRET);
    for (const op of DEFAULT_ALLOWED_OPERATIONS) {
      expect(provider.allowedOperations.has(op)).toBe(true);
    }
    expect(provider.allowedOperations.has('admin_withdraw')).toBe(false);
  });

  test('accepts a custom operation allowlist', () => {
    const provider = new LocalSignerProvider(FAKE_SECRET, ['harvest']);
    expect(provider.allowedOperations.has('harvest')).toBe(true);
    expect(provider.allowedOperations.has('liquidate')).toBe(false);
  });

  test('sign() signs the transaction with the keypair and returns it', async () => {
    const provider = new LocalSignerProvider(FAKE_SECRET);
    const tx = { sign: jest.fn() } as any;
    const result = await provider.sign(tx, 'Test SDF Network ; September 2015');
    expect(tx.sign).toHaveBeenCalled();
    expect(result).toBe(tx);
  });
});

describe('EnvSignerProvider', () => {
  const ENV_VAR = 'TEST_KEEPER_SECRET_KEY';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test('id is prefixed with "env:" to distinguish it from local providers', () => {
    const provider = new EnvSignerProvider('SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    expect(provider.id).toBe('env:GPROVIDER_PUBLIC');
  });

  test('fromEnvVar reads the secret from the named environment variable', () => {
    process.env[ENV_VAR] = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const provider = EnvSignerProvider.fromEnvVar(ENV_VAR);
    expect(provider.publicKey).toBe('GPROVIDER_PUBLIC');
  });

  test('fromEnvVar throws when the environment variable is unset', () => {
    expect(() => EnvSignerProvider.fromEnvVar(ENV_VAR)).toThrow(`${ENV_VAR} is not set`);
  });
});

describe('ExternalSignerProvider', () => {
  test('throws NotImplementedError when no sign callback is supplied', async () => {
    const provider = new ExternalSignerProvider('GEXTERNAL', ['harvest']);
    const tx = { toXDR: () => 'unsigned-xdr' } as any;
    await expect(provider.sign(tx, 'passphrase')).rejects.toBeInstanceOf(NotImplementedError);
  });

  test('delegates to the injected callback and reconstructs the signed transaction', async () => {
    const signCallback = jest.fn().mockResolvedValue('signed-xdr-from-kms');
    const provider = new ExternalSignerProvider('GEXTERNAL', ['harvest'], signCallback);
    const tx = { toXDR: () => 'unsigned-xdr' } as any;

    const result: any = await provider.sign(tx, 'Test SDF Network ; September 2015');

    expect(signCallback).toHaveBeenCalledWith('unsigned-xdr', 'Test SDF Network ; September 2015');
    expect(result.toXDR()).toBe('reconstructed-signed-xdr');
  });

  test('never exposes key material through id or publicKey', () => {
    const provider = new ExternalSignerProvider('GEXTERNAL', ['harvest']);
    expect(provider.id).toBe('external:GEXTERNAL');
    expect(provider.publicKey).toBe('GEXTERNAL');
  });
});
