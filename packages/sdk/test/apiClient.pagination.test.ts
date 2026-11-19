import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/ApiClient";
import { ApiCancelledError, ApiPaginationError } from "../src/errors";

interface Row {
  id: number;
}

describe("ApiClient cursor pagination (#1554)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function mockPages(pages: unknown[]) {
    let i = 0;
    const fetchMock = vi.fn(async (_url: string) => json(pages[Math.min(i++, pages.length - 1)]));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const client = () => new ApiClient({ baseUrl: "https://api.test", maxRetries: 0 });

  it("returns an empty list for an empty single page", async () => {
    const fetchMock = mockPages([{ items: [], nextCursor: null }]);

    const rows = await client().getAllPages<Row>("/api/things");

    expect(rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows cursors until the final page and keeps item order", async () => {
    const fetchMock = mockPages([
      { items: [{ id: 1 }, { id: 2 }], nextCursor: "c1" },
      { items: [{ id: 3 }], nextCursor: "c2" },
      { items: [{ id: 4 }] },
    ]);

    const rows = await client().getAllPages<Row>("/api/things?limit=2");

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.test/api/things?limit=2",
      "https://api.test/api/things?limit=2&cursor=c1",
      "https://api.test/api/things?limit=2&cursor=c2",
    ]);
  });

  it("yields typed pages and marks the final page with a null cursor", async () => {
    mockPages([
      { items: [{ id: 1 }], nextCursor: "c1" },
      { items: [{ id: 2 }], nextCursor: null },
    ]);

    const pages = [];
    for await (const page of client().paginate<Row>("/api/things")) {
      pages.push(page);
    }

    expect(pages).toEqual([
      { items: [{ id: 1 }], nextCursor: "c1" },
      { items: [{ id: 2 }], nextCursor: null },
    ]);
  });

  it("uses a custom cursor query parameter", async () => {
    const fetchMock = mockPages([
      { items: [{ id: 1 }], nextCursor: "abc/=" },
      { items: [], nextCursor: null },
    ]);

    await client().getAllPages<Row>("/api/things", { cursorParam: "after" });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.test/api/things?after=abc%2F%3D");
  });

  it("stops at maxPages even when the server keeps returning cursors", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => json({ items: [{ id: n }], nextCursor: `c${++n}` }));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await client().getAllPages<Row>("/api/things", { maxPages: 3 });

    expect(rows).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops early and trims the last page at maxItems", async () => {
    const fetchMock = mockPages([
      { items: [{ id: 1 }, { id: 2 }], nextCursor: "c1" },
      { items: [{ id: 3 }, { id: 4 }], nextCursor: "c2" },
      { items: [{ id: 5 }], nextCursor: null },
    ]);

    const rows = await client().getAllPages<Row>("/api/things", { maxItems: 3 });

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a non-object body", [{ id: 1 }]],
    ["a missing items array", { nextCursor: null }],
    ["a non-array items field", { items: "nope", nextCursor: null }],
    ["a numeric cursor", { items: [], nextCursor: 42 }],
    ["an empty-string cursor", { items: [], nextCursor: "" }],
  ])("throws ApiPaginationError for %s", async (_label, body) => {
    mockPages([body]);

    await expect(client().getAllPages<Row>("/api/things")).rejects.toBeInstanceOf(
      ApiPaginationError
    );
  });

  it("throws ApiPaginationError when a cursor repeats", async () => {
    const fetchMock = mockPages([
      { items: [{ id: 1 }], nextCursor: "same" },
      { items: [{ id: 2 }], nextCursor: "same" },
    ]);

    const err = await client()
      .getAllPages<Row>("/api/things")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiPaginationError);
    expect((err as ApiPaginationError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces caller cancellation between pages", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return json({ items: [{ id: 1 }], nextCursor: "c1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().getAllPages<Row>("/api/things", { signal: controller.signal })
    ).rejects.toBeInstanceOf(ApiCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
