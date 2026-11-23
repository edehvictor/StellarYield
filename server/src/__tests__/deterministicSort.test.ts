import { sortNotificationsDeterministically } from "../utils/deterministicSort";

describe("sortNotificationsDeterministically", () => {
  it("sorts unread before read, then newest createdAt, then id", () => {
    const items = [
      { id: "b", createdAt: "2026-01-01T00:00:00Z", isRead: true },
      { id: "a", createdAt: "2026-01-01T00:00:00Z", isRead: false },
      { id: "c", createdAt: "2026-01-02T00:00:00Z", isRead: true },
    ];

    expect(sortNotificationsDeterministically(items).map((i) => i.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("is stable across input order for equivalent tie-breakers", () => {
    const a = [
      { id: "2", createdAt: "2026-01-01T00:00:00Z", isRead: false, type: "DEPOSIT" },
      { id: "1", createdAt: "2026-01-01T00:00:00Z", isRead: false, type: "DEPOSIT" },
    ];
    const b = [a[1], a[0]];

    expect(sortNotificationsDeterministically(a).map((i) => i.id)).toEqual(["1", "2"]);
    expect(sortNotificationsDeterministically(b).map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("uses status/severity/priority/type tie-breakers deterministically", () => {
    const items = [
      { id: "1", createdAt: "2026-01-01T00:00:00Z", status: "active", severity: "low", priority: 1, type: "B" },
      { id: "2", createdAt: "2026-01-01T00:00:00Z", status: "triggered", severity: "high", priority: 0, type: "A" },
      { id: "3", createdAt: "2026-01-01T00:00:00Z", status: "active", severity: "high", priority: 5, type: "C" },
    ];

    expect(sortNotificationsDeterministically(items).map((i) => i.id)).toEqual([
      "2",
      "3",
      "1",
    ]);
  });
});
