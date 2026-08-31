/**
 * Notification Center Component
 * Displays full notification list with unread filtering
 * Uses centralized state for consistent counts with header badge
 */

import React, { useState } from "react";
import { CheckCircle, Info, AlertTriangle, ExternalLink, Trash2 } from "lucide-react";
import { useNotificationsList } from "../../context/NotificationContext";

const NotificationCenter: React.FC = () => {
  const { notifications, isLoading, error, markAsRead, markAllAsRead } = useNotificationsList();
  const [filterUnread, setFilterUnread] = useState(true);

  const filteredNotifications = filterUnread
    ? notifications.filter((n) => !n.isRead)
    : notifications;

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const getTimeAgo = (dateStr: string) => {
    const seconds = Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  };

  const handleMarkAsRead = async (notifId: string) => {
    await markAsRead(notifId);
  };

  const handleMarkAllAsRead = async () => {
    await markAllAsRead("");
  };

  const getIconForType = (type: string) => {
    switch (type) {
      case "DEPOSIT":
        return <CheckCircle className="text-green-500" size={20} />;
      case "WITHDRAWAL":
        return <ExternalLink className="text-blue-500" size={20} />;
      case "HARVEST":
        return <CheckCircle className="text-amber-500" size={20} />;
      case "ANNOUNCEMENT":
        return <Info className="text-indigo-400" size={20} />;
      default:
        return <AlertTriangle className="text-red-500" size={20} />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header with controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">Notification Center</h2>
          <span className="text-xs bg-indigo-500/20 text-indigo-300 font-mono px-2.5 py-1 rounded-full border border-indigo-500/30">
            {filteredNotifications.length} {filterUnread ? "unread" : "total"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer hover:text-gray-300 transition-colors">
            <input
              type="checkbox"
              checked={filterUnread}
              onChange={(e) => setFilterUnread(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-700"
            />
            Unread only
          </label>
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllAsRead}
              className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors px-3 py-1.5 rounded-lg hover:bg-indigo-500/10"
            >
              Mark all read
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="glass-panel border border-white/10 rounded-lg overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-gray-400">
            <p>Loading notifications...</p>
          </div>
        ) : error ? (
          <div className="p-12 text-center space-y-3">
            <AlertTriangle className="mx-auto text-red-500" size={32} />
            <p className="text-red-400 font-medium">Error loading notifications</p>
            <p className="text-red-300/60 text-sm">{error}</p>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="bg-white/5 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="text-gray-600" size={32} />
            </div>
            <p className="text-gray-400 font-medium">All caught up!</p>
            <p className="text-gray-500 text-sm">
              {filterUnread ? "No unread notifications." : "No notifications yet."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {filteredNotifications.map((notif) => (
              <div
                key={notif.id}
                className={`p-4 flex gap-4 transition-all hover:bg-white/5 ${
                  !notif.isRead ? "bg-indigo-500/5" : ""
                }`}
              >
                {/* Icon */}
                <div className="shrink-0 pt-1">{getIconForType(notif.type)}</div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <h3
                      className={`font-semibold text-sm ${
                        !notif.isRead ? "text-white" : "text-gray-300"
                      }`}
                    >
                      {notif.title}
                    </h3>
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {getTimeAgo(notif.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    {notif.message}
                  </p>
                </div>

                {/* Unread indicator + action */}
                <div className="shrink-0 flex items-center gap-3">
                  {!notif.isRead && (
                    <>
                      <div className="h-2 w-2 rounded-full bg-indigo-500" />
                      <button
                        onClick={() => handleMarkAsRead(notif.id)}
                        className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-1 rounded hover:bg-indigo-500/10"
                        title="Mark as read"
                      >
                        Mark read
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default NotificationCenter;
