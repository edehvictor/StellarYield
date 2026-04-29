import React, { useState, useEffect } from "react";
import { Bell, Trash2, CheckCircle, Info, AlertTriangle, ExternalLink } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { apiUrl } from "../../lib/api";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

const NotificationBell: React.FC = () => {
  const { walletAddress, isConnected } = useWallet();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (isConnected && walletAddress) {
      fetchNotifications();
      // Poll every 30 seconds
      const interval = setInterval(fetchNotifications, 30000);
      return () => clearInterval(interval);
    }
  }, [isConnected, walletAddress]);

  const fetchNotifications = async () => {
    try {
      const res = await fetch(apiUrl(`/api/notifications/${walletAddress}`));
      const data = await res.json();
      setNotifications(data);
      setUnreadCount(data.filter((n: Notification) => !n.isRead).length);
    } catch (err) {
      console.error("Failed to fetch notifications", err);
    }
  };

  const markAsRead = async (id: string) => {
    try {
      await fetch(apiUrl(`/api/notifications/${id}/read`), { method: "PATCH" });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
      setUnreadCount(count => count - 1);
    } catch (err) {
      console.error("Failed to mark as read", err);
    }
  };

  const clearAll = async () => {
    try {
      if (!walletAddress) return;
      await fetch(apiUrl(`/api/notifications/${walletAddress}`), { method: "DELETE" });
      setNotifications([]);
      setUnreadCount(0);
    } catch (err) {
      console.error("Failed to clear notifications", err);
    }
  };

  const getTimeAgo = (dateStr: string) => {
    const seconds = Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(dateStr).toLocaleDateString();
  };

  if (!isConnected) return null;

  return (
    <div className="relative">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="glass-panel p-2.5 hover:bg-white/10 transition-all active:scale-95 group focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      >
        <Bell size={20} className={unreadCount > 0 ? "animate-bounce text-indigo-400" : "text-gray-400 group-hover:text-white"} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-4 w-4 bg-indigo-500 text-[10px] font-black items-center justify-center text-white">
              {unreadCount}
            </span>
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)}></div>
          <div className="absolute right-0 mt-4 w-96 max-h-[500px] overflow-hidden glass-panel border border-white/10 shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/5">
              <h3 className="font-bold text-lg flex items-center gap-2">
                Notifications
                <span className="text-xs bg-indigo-500/20 text-indigo-300 font-mono px-2 rounded-full border border-indigo-500/30">
                  {notifications.length}
                </span>
              </h3>
              <button 
                onClick={clearAll}
                className="text-gray-400 hover:text-red-400 transition-colors p-1"
                title="Clear all"
              >
                <Trash2 size={16} />
              </button>
            </div>

            <div className="overflow-y-auto max-h-[400px] divide-y divide-white/5 custom-scrollbar">
              {notifications.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <div className="bg-white/5 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Bell size={24} className="text-gray-600" />
                  </div>
                  <p className="text-gray-400 font-medium">All caught up!</p>
                  <p className="text-gray-500 text-sm">No new events to worry about.</p>
                </div>
              ) : (
                notifications.map((notif) => (
                  <div 
                    key={notif.id} 
                    className={`p-4 hover:bg-white/5 transition-all cursor-pointer group flex gap-4 ${!notif.isRead ? 'bg-indigo-500/5' : ''}`}
                    onClick={() => !notif.isRead && markAsRead(notif.id)}
                  >
                    <div className="shrink-0 mt-1">
                      {notif.type === 'DEPOSIT' && <CheckCircle className="text-green-500" size={18} />}
                      {notif.type === 'WITHDRAWAL' && <ExternalLink className="text-blue-500" size={18} />}
                      {notif.type === 'ANNOUNCEMENT' && <Info className="text-indigo-400" size={18} />}
                      {notif.type === 'ERROR' && <AlertTriangle className="text-red-500" size={18} />}
                    </div>
                    <div className="space-y-1 flex-1">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className={`text-sm font-bold ${!notif.isRead ? 'text-white' : 'text-gray-400'}`}>
                          {notif.title}
                        </h4>
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">
                          {getTimeAgo(notif.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 leading-relaxed font-normal">
                        {notif.message}
                      </p>
                    </div>
                    {!notif.isRead && (
                      <div className="shrink-0 flex items-center">
                        <div className="h-2 w-2 rounded-full bg-indigo-500"></div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            
            <div className="p-3 border-t border-white/10 bg-white/5 text-center">
              <button className="text-[10px] font-black tracking-widest uppercase text-indigo-400 hover:text-white transition-colors">
                View All Activity
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default NotificationBell;
