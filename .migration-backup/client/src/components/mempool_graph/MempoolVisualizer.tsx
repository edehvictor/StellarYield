import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { Activity, Zap, Cpu, ArrowRightLeft, ShieldAlert } from "lucide-react";

interface MempoolTx {
  id: string;
  type: "transfer" | "contract_call" | "liquidity_pool";
  from: string;
  to?: string;
  contract?: string;
  value: number;
  timestamp: number;
}

const COLORS = {
  transfer: "#4f46e5",
  contract_call: "#10b981",
  liquidity_pool: "#f59e0b",
};

export default function MempoolVisualizer() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transactions, setTransactions] = useState<MempoolTx[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const simulationRef = useRef<any>(null);

  // Simulate incoming transactions via WebSocket
  useEffect(() => {
    setIsConnected(true);
    const interval = setInterval(() => {
      const types: ("transfer" | "contract_call" | "liquidity_pool")[] = [
        "transfer",
        "contract_call",
        "liquidity_pool",
      ];
      const type = types[Math.floor(Math.random() * types.length)];
      
      const newTx: MempoolTx = {
        id: Math.random().toString(36).substr(2, 9),
        type,
        from: `G...${Math.random().toString(36).substr(2, 4)}`,
        to: type === "transfer" ? `G...${Math.random().toString(36).substr(2, 4)}` : undefined,
        contract: type !== "transfer" ? `C...${Math.random().toString(36).substr(2, 4)}` : undefined,
        value: Math.random() * 1000,
        timestamp: Date.now(),
      };

      setTransactions((prev) => [newTx, ...prev].slice(0, 50));
    }, 2000);

    return () => {
      clearInterval(interval);
      setIsConnected(false);
    };
  }, []);

  useEffect(() => {
    if (!svgRef.current || transactions.length === 0) return;

    const width = 800;
    const height = 500;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const nodes = transactions.map((tx) => ({
      ...tx,
      x: Math.random() * width,
      y: Math.random() * height,
    }));

    const simulation = d3
      .forceSimulation(nodes as any)
      .force("charge", d3.forceManyBody().strength(-50))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((d: any) => Math.sqrt(d.value) + 10))
      .on("tick", () => {
        nodeGroups
          .attr("transform", (d: any) => `translate(${d.x},${d.y})`);
      });

    simulationRef.current = simulation;

    const nodeGroups = svg
      .selectAll(".node")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .call(
        d3.drag<SVGGElement, any>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    nodeGroups
      .append("circle")
      .attr("r", (d: any) => Math.sqrt(d.value) + 5)
      .attr("fill", (d: any) => COLORS[d.type as keyof typeof COLORS])
      .attr("stroke", "#fff")
      .attr("stroke-width", 2)
      .attr("opacity", 0.8)
      .style("filter", "url(#glow)");

    // Add labels for large transactions
    nodeGroups
      .filter((d: any) => d.value > 500)
      .append("text")
      .text((d: any) => `${d.type}: ${d.value.toFixed(0)} XLM`)
      .attr("y", (d: any) => -Math.sqrt(d.value) - 10)
      .attr("text-anchor", "middle")
      .attr("fill", "#fff")
      .attr("font-size", "10px")
      .attr("font-weight", "bold");

    // Defs for glow filter
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "glow");
    filter
      .append("feGaussianBlur")
      .attr("stdDeviation", "3.5")
      .attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    return () => {
      simulation.stop();
    };
  }, [transactions]);

  return (
    <div className="glass-panel p-6 overflow-hidden space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/20 rounded-lg text-indigo-400">
            <Activity className={isConnected ? "animate-pulse" : ""} />
          </div>
          <div>
            <h3 className="text-xl font-bold">Mempool Transaction Graph</h3>
            <p className="text-xs text-gray-400">Real-time pending transaction flow on Stellar</p>
          </div>
        </div>
        
        <div className="flex gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#4f46e5]" />
            <span className="text-gray-400">Transfer</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#10b981]" />
            <span className="text-gray-400">Contract Call</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#f59e0b]" />
            <span className="text-gray-400">LP Intersect</span>
          </div>
        </div>
      </div>

      <div className="relative bg-black/40 rounded-xl border border-white/10 aspect-[16/10] sm:aspect-[16/9] w-full max-h-[500px] overflow-hidden">
        {!isConnected && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20 backdrop-blur-sm">
            <div className="text-center space-y-3">
              <RefreshCw className="mx-auto animate-spin text-gray-500" size={32} />
              <p className="text-sm text-gray-400">Connecting to Horizon node...</p>
            </div>
          </div>
        )}
        
        <svg
          ref={svgRef}
          className="w-full h-full cursor-move"
          viewBox="0 0 800 500"
        />

        {/* Legend/Info Overlay */}
        <div className="absolute bottom-4 left-4 grid grid-cols-2 gap-x-6 gap-y-2 glass-panel !bg-black/80 !p-3 text-[10px] sm:text-xs">
          <div className="flex items-center gap-2">
            <Zap size={12} className="text-indigo-400" />
            <span className="text-gray-300">TPS: 42.5</span>
          </div>
          <div className="flex items-center gap-2">
            <Cpu size={12} className="text-emerald-400" />
            <span className="text-gray-300">Gas (avg): 100 stroops</span>
          </div>
          <div className="flex items-center gap-2">
            <ArrowRightLeft size={12} className="text-amber-400" />
            <span className="text-gray-300">Pending: {transactions.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldAlert size={12} className="text-red-400" />
            <span className="text-gray-300">High-Risk: 0</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RefreshCw(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
