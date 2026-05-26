import { fetchNetworkSnapshot } from "../services/stellarNetworkService";

jest.setTimeout(30000);

// The mock factory creates the shared instances in its own closure and exposes
// them via static properties so beforeEach can reference the same objects that
// the service module received when it was loaded.
jest.mock("@stellar/stellar-sdk", () => {
  const callBuilder = {
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: jest.fn(() => Promise.resolve({ records: [] })),
  };
  const horizonServer = { ledgers: jest.fn().mockReturnValue(callBuilder) };
  const MockServer = jest.fn().mockImplementation(() => horizonServer);
  (MockServer as any).__callBuilder = callBuilder;
  (MockServer as any).__horizonServer = horizonServer;
  return { Horizon: { Server: MockServer } };
});

const { Horizon } = require("@stellar/stellar-sdk");
const mockCallBuilder = (Horizon.Server as any).__callBuilder;
const mockHorizonServer = (Horizon.Server as any).__horizonServer;

describe("stellarNetworkService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallBuilder.call = jest.fn(() => Promise.resolve({ records: [] }));
    mockHorizonServer.ledgers = jest.fn().mockReturnValue(mockCallBuilder);
  });

  it("fetches network snapshot successfully on first attempt", async () => {
    const mockResponse = {
      records: [
        {
          sequence: 12345,
          closed_at: "2023-01-01T00:00:00Z",
        },
      ],
    };
    mockCallBuilder.call = jest.fn(() => Promise.resolve(mockResponse));

    const result = await fetchNetworkSnapshot();

    expect(result).toEqual({
      ledgerSequence: 12345,
      closedAt: "2023-01-01T00:00:00Z",
      network: "mainnet",
    });
    expect(mockCallBuilder.call).toHaveBeenCalledTimes(1);
  });

  it("retries on network error and succeeds", async () => {
    const networkError = new Error("Network error");
    Object.assign(networkError, { code: "ECONNREFUSED" });

    const mockResponse = {
      records: [
        {
          sequence: 12346,
          closed_at: "2023-01-02T00:00:00Z",
        },
      ],
    };

    mockCallBuilder.call = jest
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(mockResponse);

    const result = await fetchNetworkSnapshot();

    expect(result).toEqual({
      ledgerSequence: 12346,
      closedAt: "2023-01-02T00:00:00Z",
      network: "mainnet",
    });
    expect(mockCallBuilder.call).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws error", async () => {
    const networkError = new Error("Network error");
    Object.assign(networkError, { code: "ECONNREFUSED" });

    mockCallBuilder.call = jest.fn().mockRejectedValue(networkError);

    await expect(fetchNetworkSnapshot()).rejects.toThrow("Network error");
    expect(mockCallBuilder.call).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("does not retry on 4xx client error", async () => {
    const clientError = new Error("Client error");
    Object.assign(clientError, { response: { status: 400 } });

    mockCallBuilder.call.mockRejectedValue(clientError);

    await expect(fetchNetworkSnapshot()).rejects.toThrow("Client error");
    expect(mockCallBuilder.call).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx server error", async () => {
    const serverError = new Error("Server error");
    Object.assign(serverError, { response: { status: 500 } });

    const mockResponse = {
      records: [
        {
          sequence: 12347,
          closed_at: "2023-01-03T00:00:00Z",
        },
      ],
    };

    mockCallBuilder.call
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce(mockResponse);

    const result = await fetchNetworkSnapshot();

    expect(result).toEqual({
      ledgerSequence: 12347,
      closedAt: "2023-01-03T00:00:00Z",
      network: "mainnet",
    });
    expect(mockCallBuilder.call).toHaveBeenCalledTimes(2);
  });

  it("throws timeout error", async () => {
    mockCallBuilder.call = jest.fn(() => new Promise(() => {}));

    await expect(fetchNetworkSnapshot()).rejects.toThrow("Timeout");
    expect(mockCallBuilder.call).toHaveBeenCalledTimes(1);
  });

  it("throws error when no ledger data", async () => {
    const mockResponse = {
      records: [],
    };
    mockCallBuilder.call.mockResolvedValue(mockResponse);

    await expect(fetchNetworkSnapshot()).rejects.toThrow(
      "No Stellar ledger data returned from Horizon."
    );
  });
});
