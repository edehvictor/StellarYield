import React, { useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";

interface CorrelationMatrix {
  items: string[];
  matrix: number[][];
  warnings: string[];
}

function getColorForCorrelation(value: number): string {
  // Map [-1, 1] to varying shades
  // -1 = strong red: rgb(244, 63, 94) (Tailwind rose-500)
  // 0 = neutral dark: rgb(30, 41, 59) (Tailwind slate-800)
  // +1 = strong green: rgb(16, 185, 129) (Tailwind emerald-500)
  
  const v = Math.max(-1, Math.min(1, value));
  
  if (v < 0) {
    // Interpolate from slate-800 to rose-500
    const intensity = Math.abs(v);
    const r = Math.round(30 + (244 - 30) * intensity);
    const g = Math.round(41 + (63 - 41) * intensity);
    const b = Math.round(59 + (94 - 59) * intensity);
    return `rgba(${r}, ${g}, ${b}, 0.8)`;
  } else {
    // Interpolate from slate-800 to emerald-500
    const intensity = v;
    const r = Math.round(30 + (16 - 30) * intensity);
    const g = Math.round(41 + (185 - 41) * intensity);
    const b = Math.round(59 + (129 - 59) * intensity);
    return `rgba(${r}, ${g}, ${b}, 0.8)`;
  }
}

export default function CorrelationHeatmap() {
  const [data, setData] = useState<CorrelationMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const response = await fetch(apiUrl("/api/correlation?window=30"));
        if (!response.ok) {
          throw new Error("Unable to fetch correlation data");
        }
        const json = await response.json() as CorrelationMatrix;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error fetching correlation data");
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  if (loading) {
    return (
      <div className="glass-card mt-8 p-6 animate-pulse">
        <div className="h-6 w-1/3 bg-gray-700/50 rounded mb-6"></div>
        <div className="h-[300px] bg-slate-800/30 rounded-xl"></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="glass-card mt-8 p-6 text-center text-red-400">
        <p>{error || "Failed to load"}</p>
      </div>
    );
  }

  return (
    <div className="glass-card mt-8 p-6">
       <div className="mb-6">
          <h3 className="text-xl font-bold text-white">Asset Correlation Matrix</h3>
          <p className="mt-1 text-sm text-gray-400">
             Understand hidden exposures and monitor protocol clustering across 30 days.
          </p>
       </div>

       {data.warnings.length > 0 && (
         <div className="mb-6 rounded-lg border border-orange-500/30 bg-orange-500/10 p-4" data-testid="concentration-warnings">
           <div className="flex items-start gap-3">
             <span className="text-xl">⚠️</span>
             <div>
               <h4 className="font-semibold text-orange-400">Concentration Warnings</h4>
               <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-orange-200">
                 {data.warnings.map((warn, i) => (
                   <li key={i}>{warn}</li>
                 ))}
               </ul>
             </div>
           </div>
         </div>
       )}

       <div className="overflow-x-auto pb-4">
         <div className="inline-block min-w-max">
           <div className="flex">
             {/* Top-left empty corner */}
             <div className="w-28 sm:w-32"></div>
             {/* Column headers */}
             {data.items.map((item, idx) => (
                <div key={idx} className="w-20 sm:w-24 text-center px-1">
                  <span className="text-xs font-semibold text-gray-400 tracking-wider truncate block" title={item}>
                    {item}
                  </span>
                </div>
             ))}
           </div>
           
           <div className="mt-3 flex flex-col gap-1">
             {data.matrix.map((row, rowIndex) => (
               <div key={rowIndex} className="flex h-12">
                 {/* Row header */}
                 <div className="flex w-28 sm:w-32 items-center pr-4">
                   <span className="text-xs font-semibold text-gray-300 truncate" title={data.items[rowIndex]}>
                     {data.items[rowIndex]}
                   </span>
                 </div>
                 
                 {/* Row cells */}
                 {row.map((val, colIndex) => (
                   <div 
                     key={colIndex} 
                     className="w-20 sm:w-24 px-1 group relative"
                   >
                     <div 
                       className="h-full w-full rounded-md shadow-sm transition-all duration-300 group-hover:scale-105 group-hover:shadow-[0_0_15px_rgba(255,255,255,0.1)] flex items-center justify-center border border-white/5"
                       style={{ backgroundColor: getColorForCorrelation(val) }}
                       title={`${data.items[rowIndex]} & ${data.items[colIndex]}: ${(val*100).toFixed(1)}% correlation`}
                     >
                        <span className="text-xs font-medium text-white/90 drop-shadow-md">
                          {val.toFixed(2)}
                        </span>
                     </div>
                   </div>
                 ))}
               </div>
             ))}
           </div>
         </div>
       </div>

       <div className="mt-6 flex items-center justify-end gap-3 text-xs text-gray-400">
         <span>Correlated (+1)</span>
         <div className="h-2 w-32 rounded-full bg-gradient-to-r from-emerald-500 via-slate-800 to-rose-500 flex-row-reverse" style={{ background: "linear-gradient(to right, #F43F5E, #1E293B, #10B981)" }}></div>
         <span>Inverse (-1)</span>
       </div>
    </div>
  );
}
