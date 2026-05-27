import React, { useEffect, useState } from "react";
import { Trophy, Medal, Star, Wallet, AlertCircle, RefreshCw, Users } from "lucide-react";
import { apiUrl } from "../../lib/api";

interface LeaderboardEntry {
  rank: number;
  walletAddress: string;
  tvl: number;
  totalYield: number;
  badge: string;
}

const Leaderboard: React.FC = () => {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLeaderboard = () => {
    setLoading(true);
    setError(null);
    fetch(apiUrl("/api/leaderboard"))
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json();
      })
      .then((data) => {
        setLeaderboard(Array.isArray(data) ? data : data.items ?? []);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch leaderboard", err);
        setError(err instanceof Error ? err.message : "Failed to load leaderboard data");
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchLeaderboard();
  }, []);

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  if (loading) {
    return (
      <div className="space-y-8 max-w-5xl mx-auto">
        <div className="text-center space-y-4">
          <h2 className="text-4xl font-black tracking-tight text-white flex items-center justify-center gap-3">
            <Trophy className="text-yellow-500" size={40} />
            TVL LEADERBOARD
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg italic">
            Compete with the whales to earn exclusive badges and protocol rewards.
          </p>
        </div>
        <div className="glass-panel p-12 flex flex-col items-center justify-center space-y-4">
          <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-indigo-500"></div>
          <p className="text-gray-400 text-sm">Loading leaderboard rankings...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-8 max-w-5xl mx-auto">
        <div className="text-center space-y-4">
          <h2 className="text-4xl font-black tracking-tight text-white flex items-center justify-center gap-3">
            <Trophy className="text-yellow-500" size={40} />
            TVL LEADERBOARD
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg italic">
            Compete with the whales to earn exclusive badges and protocol rewards.
          </p>
        </div>
        <div className="glass-panel p-12 flex flex-col items-center justify-center space-y-4 border border-red-500/30">
          <AlertCircle className="text-red-400" size={48} />
          <div className="text-center space-y-2">
            <h3 className="text-xl font-bold text-white">Failed to Load Leaderboard</h3>
            <p className="text-gray-400 text-sm max-w-md">{error}</p>
          </div>
          <button
            onClick={fetchLeaderboard}
            className="flex items-center gap-2 px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold rounded-lg transition-colors"
          >
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <div className="space-y-8 max-w-5xl mx-auto">
        <div className="text-center space-y-4">
          <h2 className="text-4xl font-black tracking-tight text-white flex items-center justify-center gap-3">
            <Trophy className="text-yellow-500" size={40} />
            TVL LEADERBOARD
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg italic">
            Compete with the whales to earn exclusive badges and protocol rewards.
          </p>
        </div>
        <div className="glass-panel p-12 flex flex-col items-center justify-center space-y-4">
          <Users className="text-gray-500" size={64} />
          <div className="text-center space-y-2">
            <h3 className="text-xl font-bold text-white">No Rankings Yet</h3>
            <p className="text-gray-400 text-sm max-w-md">
              Be the first to deposit and claim your spot on the leaderboard!
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="text-center space-y-4">
        <h2 className="text-4xl font-black tracking-tight text-white flex items-center justify-center gap-3">
          <Trophy className="text-yellow-500" size={40} />
          TVL LEADERBOARD
        </h2>
        <p className="text-gray-400 max-w-2xl mx-auto text-lg italic">
          Compete with the whales to earn exclusive badges and protocol rewards.
        </p>
      </div>

      <div className="glass-panel overflow-hidden border border-white/10 shadow-2xl">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-white/5 text-gray-400 text-xs uppercase tracking-widest font-bold">
              <th className="px-6 py-4">Rank</th>
              <th className="px-6 py-4">Wallet</th>
              <th className="px-6 py-4">TVL (USDC)</th>
              <th className="px-6 py-4">Yield Earned</th>
              <th className="px-6 py-4">Badges</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {leaderboard.map((user) => (
              <tr 
                key={user.walletAddress} 
                className={`hover:bg-white/5 transition-colors ${user.rank <= 3 ? 'bg-indigo-500/5' : ''}`}
              >
                <td className="px-6 py-4 font-mono text-lg flex items-center gap-3">
                  {user.rank === 1 && <Medal className="text-yellow-400" size={20} />}
                  {user.rank === 2 && <Medal className="text-gray-300" size={20} />}
                  {user.rank === 3 && <Medal className="text-orange-400" size={20} />}
                  #{user.rank}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2 group cursor-pointer">
                    <Wallet size={16} className="text-gray-500 group-hover:text-indigo-400" />
                    <span className="font-medium group-hover:text-indigo-400 transition-colors">
                      {truncateAddress(user.walletAddress)}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 font-bold text-lg text-white">
                  ${user.tvl.toLocaleString()}
                </td>
                <td className="px-6 py-4 text-green-400 font-medium">
                  +${user.totalYield.toLocaleString()}
                </td>
                <td className="px-6 py-4">
                  {user.badge && (
                    <span className="px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-[10px] font-black tracking-tighter uppercase border border-indigo-500/30">
                      {user.badge}
                    </span>
                  )}
                  {user.tvl > 100000 && (
                    <span className="hidden">
                       <Star size={14} className="inline text-yellow-500 ml-1" />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Leaderboard;
