import pino from 'pino';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// We mock the pino library to track how it's called
jest.mock('pino', () => {
  const m = jest.fn().mockReturnValue({
    level: 'info',
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  });
  return m;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('logger utility', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('configures pino-pretty transport in non-production environments', () => {
    process.env.NODE_ENV = 'development';
    
    // Use require to trigger module evaluation with new ENV
    require('../utils/logger');
    
    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          target: 'pino-pretty',
        }),
      }),
    );
  });

  test('disables pino-pretty transport in production for JSON output', () => {
    process.env.NODE_ENV = 'production';
    
    jest.isolateModules(() => {
      require('../utils/logger');
    });

    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: undefined,
      }),
    );
  });

  test('logger instance is exported correctly', () => {
    const { logger } = require('../utils/logger');
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
  });
});
