import axios from 'axios';

jest.mock('axios');

// healthMonitor.ts reads DISCORD_WEBHOOK_URL into a module-level constant, so
// the env var must be set before the module is imported.
process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendAlert } = require('../monitoring/healthMonitor');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('healthMonitor severity normalization (#1318)', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue({ data: {} });
  });

  it('normalizes a known severity into the alert title', async () => {
    await sendAlert('DB is down', 'HIGH');

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [, payload] = mockedAxios.post.mock.calls[0];
    expect((payload as any).embeds[0].title).toBe('Backend Health Alert — HIGH');
  });

  it('normalizes an inconsistent/lowercase severity before sending', async () => {
    await sendAlert('Soroban RPC degraded', 'warning');

    const [, payload] = mockedAxios.post.mock.calls[0];
    // "warning" is a known alias for MEDIUM, not passed through verbatim.
    expect((payload as any).embeds[0].title).toBe('Backend Health Alert — MEDIUM');
  });

  it('falls back to the default severity for an unrecognized label', async () => {
    await sendAlert('Unknown condition', 'sev1');

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect((payload as any).embeds[0].title).toBe('Backend Health Alert — MEDIUM');
  });

  it('uses the CRITICAL color for critical alerts regardless of input casing', async () => {
    await sendAlert('Backend unreachable', 'critical');

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect((payload as any).embeds[0].color).toBe(0xff0000);
  });
});
