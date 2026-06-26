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


  test('logger instance is exported correctly', () => {
    const { logger } = require('../utils/logger');
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
  });
});
