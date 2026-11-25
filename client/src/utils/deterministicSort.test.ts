import { describe, expect, it } from "vitest";
import { sortNotificationsDeterministically } from "./deterministicSort";

describe("sortNotificationsDeterministically", () => {
  it("sorts unread first then newest then id", () => {
    const items = [
      { id: "b", createdAt: "2026-01-01T00:00:00Z", isRead: true },
      { id: "a", createdAt: "2026-01-01T00:00:00Z", isRead: false },
      { id: "c", createdAt: "2026-01-02T00:00:00Z", isRead: true },
    ];
    expect(sortNotificationsDeterministically(items).map((i) => i.id)).toEqual(["a", "c", "b"]);
  });
});
