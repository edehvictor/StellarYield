import React from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";

interface ExposureMapProps {
  data: {
    byAsset: Record<string, number>;
    byProtocol: Record<string, number>;
    totalValue: number;
    warnings: string[];
  };
}

const COLORS = ["#6C5DD3", "#3EAC75", "#F5A623", "#FF5E5E", "#A0AEC0"];

export const ExposureMap: React.FC<ExposureMapProps> = ({ data }) => {
  const assetData = Object.entries(data.byAsset).map(([name, value]) => ({
    name,
    value,
  }));

  const protocolData = Object.entries(data.byProtocol).map(([name, value]) => ({
    name,
    value,
  }));

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="glass-panel p-6">
          <h3 className="text-lg font-bold mb-4">Asset Exposure</h3>
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={assetData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {assetData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: "#1A1D1F", border: "none", borderRadius: "8px" }}
                  itemStyle={{ color: "#fff" }}
                  formatter={(value: number) => `$${value.toLocaleString()}`}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-panel p-6">
          <h3 className="text-lg font-bold mb-4">Protocol Exposure</h3>
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={protocolData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {protocolData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: "#1A1D1F", border: "none", borderRadius: "8px" }}
                  itemStyle={{ color: "#fff" }}
                  formatter={(value: number) => `$${value.toLocaleString()}`}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className="glass-panel p-6 border-l-4 border-yellow-500">
          <h3 className="text-lg font-bold text-yellow-500 mb-2 flex items-center gap-2">
            ⚠️ Concentration Warnings
          </h3>
          <ul className="list-disc list-inside space-y-1 text-gray-300">
            {data.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
