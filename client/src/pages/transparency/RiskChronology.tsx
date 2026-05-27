import React, { useEffect, useState } from "react";
import { ShieldAlert, Info, CheckCircle2, Filter, Calendar } from "lucide-react";

interface Incident {
    id: string;
    protocol: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    type: string;
    title: string;
    description: string;
    affectedVaults: string[];
    resolved: boolean;
    startedAt: string;
    resolvedAt?: string;
}

const RiskChronology: React.FC = () => {
    const [incidents, setIncidents] = useState<Incident[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState({ protocol: "", severity: "" });

    useEffect(() => {
        fetchIncidents();
    }, [filter]);

    const fetchIncidents = async () => {
        setLoading(true);
        try {
            const query = new URLSearchParams(filter as any).toString();
            const response = await fetch(`/api/incidents?${query}`);
            const data = await response.json();
            setIncidents(data);
        } catch (error) {
            console.error("Failed to fetch incidents", error);
        } finally {
            setLoading(false);
        }
    };

    const severityColor = (severity: string) => {
        switch (severity) {
            case "CRITICAL": return "text-red-500 bg-red-500/10 border-red-500/20";
            case "HIGH": return "text-orange-500 bg-orange-500/10 border-orange-500/20";
            case "MEDIUM": return "text-yellow-500 bg-yellow-500/10 border-yellow-500/20";
            default: return "text-blue-500 bg-blue-500/10 border-blue-500/20";
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Risk Incident Chronicle</h2>
                    <p className="text-gray-400 mt-2">Historical log of protocol-level incidents, anomalies, and interventions.</p>
                </div>

                <div className="flex gap-4">
                    <div className="flex items-center gap-2 px-4 py-2 glass-panel rounded-xl">
                        <Filter size={16} className="text-gray-400" />
                        <select
                            className="bg-transparent text-sm focus:outline-none"
                            value={filter.protocol}
                            onChange={(e) => setFilter({ ...filter, protocol: e.target.value })}
                        >
                            <option value="">All Protocols</option>
                            <option value="Blend">Blend</option>
                            <option value="Soroswap">Soroswap</option>
                            <option value="DeFindex">DeFindex</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="relative">
                <div className="absolute left-8 top-0 bottom-0 w-px bg-gradient-to-b from-indigo-500/50 via-purple-500/20 to-transparent" />

                {loading ? (
                    <div className="pl-20 py-12 text-gray-500 italic">Synchronizing incident logs...</div>
                ) : incidents.length === 0 ? (
                    <div className="pl-20 py-12 text-gray-400 italic">No incidents recorded for the selected criteria.</div>
                ) : (
                    <div className="space-y-12">
                        {incidents.map((incident) => (
                            <div key={incident.id} className="relative pl-20 group">
                                <div className={`absolute left-6 top-0 w-4 h-4 rounded-full border-4 border-black z-10 transition-transform group-hover:scale-125 ${incident.resolved ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`} />

                                <div className="glass-panel p-6 rounded-2xl border-white/5 hover:border-white/10 transition-all">
                                    <div className="flex justify-between items-start mb-4">
                                        <div>
                                            <div className="flex items-center gap-3 mb-1">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest border ${severityColor(incident.severity)}`}>
                                                    {incident.severity}
                                                </span>
                                                <span className="text-xs text-gray-500 font-medium uppercase tracking-widest">{incident.protocol}</span>
                                                {incident.resolved && (
                                                    <span className="flex items-center gap-1 text-green-500 text-[10px] font-bold uppercase">
                                                        <CheckCircle2 size={12} /> Resolved
                                                    </span>
                                                )}
                                            </div>
                                            <h3 className="text-xl font-bold">{incident.title}</h3>
                                        </div>
                                        <div className="text-right">
                                            <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
                                                <Calendar size={14} />
                                                {new Date(incident.startedAt).toLocaleDateString()}
                                            </div>
                                        </div>
                                    </div>

                                    <p className="text-gray-300 text-sm leading-relaxed mb-4">{incident.description}</p>

                                    <div className="flex flex-wrap gap-2 pt-4 border-t border-white/5">
                                        {incident.affectedVaults.map(vault => (
                                            <span key={vault} className="px-3 py-1 bg-white/5 rounded-lg text-xs text-gray-400">
                                                {vault}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default RiskChronology;
