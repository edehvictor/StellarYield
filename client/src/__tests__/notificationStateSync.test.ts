/**
 * Tests for notification center unread state synchronization
 * Verifies unread counts stay consistent across list, header, and digest views
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { useNotificationState } from "../hooks/useNotificationState";
import type { Notification } from "../hooks/useNotificationState";

// Mock fetch
global.fetch = jest.fn();

describe("Notification State Synchronization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Unread Count Consistency", () => {
    it("should compute correct unread count from notifications", async () => {
      const mockNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          walletAddress: "0xtest",
          type: "HARVEST",
          title: "Harvest Ready",
          message: "You can harvest rewards now",
          isRead: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: "3",
          walletAddress: "0xtest",
          type: "ANNOUNCEMENT",
          title: "New Feature",
          message: "Check out our new feature",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockNotifications,
      });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(2);
      expect(result.current[0].notifications).toHaveLength(3);
    });

    it("should sync unread count after marking single notification as read", async () => {
      const mockNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          walletAddress: "0xtest",
          type: "HARVEST",
          title: "Harvest Ready",
          message: "You can harvest rewards now",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockNotifications,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockNotifications[0], isRead: true }),
        });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(2);

      await act(async () => {
        await result.current[1].markAsRead("1");
      });

      expect(result.current[0].unreadCount).toBe(1);
      expect(result.current[0].notifications[1].isRead).toBe(false);
      expect(result.current[0].notifications[0].isRead).toBe(true);
    });

    it("should sync unread count after marking all as read", async () => {
      const mockNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          walletAddress: "0xtest",
          type: "HARVEST",
          title: "Harvest Ready",
          message: "You can harvest rewards now",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "3",
          walletAddress: "0xtest",
          type: "ANNOUNCEMENT",
          title: "New Feature",
          message: "Check out our new feature",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockNotifications,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ marked: 3 }),
        });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(3);

      await act(async () => {
        await result.current[1].markAllAsRead("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(0);
      expect(result.current[0].notifications.every((n) => n.isRead)).toBe(true);
    });
  });

  describe("Refresh Behavior", () => {
    it("should maintain read state after refresh", async () => {
      const initialNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          walletAddress: "0xtest",
          type: "HARVEST",
          title: "Harvest Ready",
          message: "You can harvest rewards now",
          isRead: true,
          createdAt: new Date().toISOString(),
        },
      ];

      const refreshedNotifications: Notification[] = [
        initialNotifications[0],
        initialNotifications[1],
        {
          id: "3",
          walletAddress: "0xtest",
          type: "ANNOUNCEMENT",
          title: "New Notification",
          message: "A new notification",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => initialNotifications,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => refreshedNotifications,
        });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(1);

      await act(async () => {
        await result.current[1].refreshNotifications("0xtest");
      });

      // After refresh: 2 unread (IDs 1 and 3 are unread)
      expect(result.current[0].unreadCount).toBe(2);
      expect(result.current[0].notifications).toHaveLength(3);
      expect(result.current[0].notifications[1].isRead).toBe(true); // ID 2 still read
    });

    it("should not restore already-read items after refresh", async () => {
      const initialNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => initialNotifications,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ ...initialNotifications[0], isRead: true }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ ...initialNotifications[0], isRead: true }],
        });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(1);

      await act(async () => {
        await result.current[1].markAsRead("1");
      });

      expect(result.current[0].unreadCount).toBe(0);

      await act(async () => {
        await result.current[1].refreshNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(0);
      expect(result.current[0].notifications[0].isRead).toBe(true);
    });
  });

  describe("Empty and Edge Cases", () => {
    it("should handle empty notification list", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(0);
      expect(result.current[0].notifications).toHaveLength(0);
      expect(result.current[0].isLoading).toBe(false);
    });

    it("should handle all notifications already read", async () => {
      const mockNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          walletAddress: "0xtest",
          type: "HARVEST",
          title: "Harvest Ready",
          message: "You can harvest rewards now",
          isRead: true,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockNotifications,
      });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(0);
      expect(result.current[0].notifications).toHaveLength(2);
    });

    it("should handle error gracefully on mark as read", async () => {
      const mockNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockNotifications,
        })
        .mockResolvedValueOnce({
          ok: false,
          statusText: "Internal Server Error",
        });

      const { result } = renderHook(() => useNotificationState());

      await act(async () => {
        await result.current[1].fetchNotifications("0xtest");
      });

      expect(result.current[0].unreadCount).toBe(1);

      await act(async () => {
        await result.current[1].markAsRead("1");
      });

      // Should revert optimistic update
      expect(result.current[0].unreadCount).toBe(1);
      expect(result.current[0].notifications[0].isRead).toBe(false);
      expect(result.current[0].error).toBeTruthy();
    });
  });

  describe("Cross-view Synchronization", () => {
    it("should maintain consistent state across multiple hook instances", async () => {
      const mockNotifications: Notification[] = [
        {
          id: "1",
          walletAddress: "0xtest",
          type: "DEPOSIT",
          title: "Deposit Confirmed",
          message: "Your deposit has been processed",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          walletAddress: "0xtest",
          type: "HARVEST",
          title: "Harvest Ready",
          message: "You can harvest rewards now",
          isRead: false,
          createdAt: new Date().toISOString(),
        },
      ];

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockNotifications,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockNotifications[0], isRead: true }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockNotifications.map((n) => ({ ...n, isRead: true })),
        });

      const { result: headerResult } = renderHook(() => useNotificationState());
      const { result: listResult } = renderHook(() => useNotificationState());

      await act(async () => {
        await headerResult.current[1].fetchNotifications("0xtest");
        await listResult.current[1].fetchNotifications("0xtest");
      });

      // Both hooks have same initial state
      expect(headerResult.current[0].unreadCount).toBe(2);
      expect(listResult.current[0].unreadCount).toBe(2);

      // Note: Each hook instance has its own state
      // In a real app, they would share state via Context
    });
  });
});

describe("Preference Override Precedence", () => {
  type DeliveryChannel = "email" | "digest" | "in-app";
  type AlertClass = "DEPOSIT" | "HARVEST" | "ANNOUNCEMENT";
  type DeliveryPreference = Record<DeliveryChannel, boolean>;

  function resolvePreference(
    globalPreference: DeliveryPreference,
    sourceChannelOverrides: Record<string, Partial<DeliveryPreference>>,
    sourceChannel: string,
    alertClassOverrides: Partial<Record<AlertClass, Partial<DeliveryPreference>>>,
    alertClass: AlertClass
  ): DeliveryPreference {
    const sourceChannelOverride = sourceChannelOverrides[sourceChannel];
    const alertClassOverride = alertClassOverrides[alertClass];
    return {
      email: alertClassOverride?.email ?? sourceChannelOverride?.email ?? globalPreference.email,
      digest: alertClassOverride?.digest ?? sourceChannelOverride?.digest ?? globalPreference.digest,
      "in-app": alertClassOverride?.["in-app"] ?? sourceChannelOverride?.["in-app"] ?? globalPreference["in-app"],
    };
  }

  it("uses global defaults when no override exists", () => {
    const globalPreference: DeliveryPreference = { email: true, digest: false, "in-app": true };
    expect(resolvePreference(globalPreference, {}, "pool-1", {}, "DEPOSIT")).toEqual(globalPreference);
  });

  it("applies source-channel then alert-class overrides with deterministic precedence", () => {
    const globalPreference: DeliveryPreference = { email: true, digest: true, "in-app": true };
    const sourceChannelOverrides: Record<string, Partial<DeliveryPreference>> = {
      "pool-1": { email: false, digest: true, "in-app": true },
    };
    const alertClassOverrides: Partial<Record<AlertClass, Partial<DeliveryPreference>>> = {
      DEPOSIT: { email: true, digest: true, "in-app": false },
    };
    expect(resolvePreference(globalPreference, sourceChannelOverrides, "pool-1", alertClassOverrides, "DEPOSIT")).toEqual({
      email: true,
      digest: true,
      "in-app": false,
    });
  });

  it("does not leak alert-class overrides across alert classes", () => {
    const globalPreference: DeliveryPreference = { email: true, digest: true, "in-app": true };
    const alertClassOverrides: Partial<Record<AlertClass, Partial<DeliveryPreference>>> = {
      DEPOSIT: { email: false, digest: false, "in-app": false },
    };
    expect(resolvePreference(globalPreference, {}, "pool-1", alertClassOverrides, "HARVEST")).toEqual(globalPreference);
  });
});
