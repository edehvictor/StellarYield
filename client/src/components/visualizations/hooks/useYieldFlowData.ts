import { useState, useEffect, useRef } from "react";
import type { FlowNode } from "../types";
import type { Vector3Tuple } from "three";

interface NormalizedYield {
  protocolName: string;
  apy: number;
  tvl: number;
  riskScore: number;
  source: string;
  fetchedAt: string;
}

const POLL_INTERVAL = 30_000;

function riskToColor(score: number): string {
  if (score >= 7) return "#3EAC75";
  if (score >= 4) return "#F5A623";
  return "#FF5E5E";
}

function mapApy(apy: number): number {
  return 0.3 + Math.min(apy / 15, 1) * 1.7;
}

function mapTvl(tvl: number, maxParticles: number): number {
  const normalized = Math.min(tvl / 15_000_000, 1);
  return Math.max(10, Math.round(normalized * maxParticles));
}

function mapNodeRadius(tvl: number): number {
  const normalized = Math.min(tvl / 15_000_000, 1);
  return 0.3 + normalized * 0.7;
}

function computePositions(count: number): Vector3Tuple[] {
  const positions: Vector3Tuple[] = [];
  const arcStart = -Math.PI * 0.4;
  const arcEnd = Math.PI * 0.4;
  const radius = 4;

  for (let i = 0; i < count; i++) {
    const angle = count === 1
      ? 0
      : arcStart + (i / (count - 1)) * (arcEnd - arcStart);
    positions.push([
      Math.sin(angle) * radius,
      Math.cos(angle) * radius - 1,
      0,
    ]);
  }
  return positions;
}

export function useYieldFlowData(maxParticlesPerStream: number): {
  nodes: FlowNode[];
  loading: boolean;
  error: string | null;
} {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    let cancelled = false;

    async function fetchYields() {
      try {
        const res = await fetch("http://localhost:3001/api/yields");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: NormalizedYield[] = await res.json();

        if (cancelled) return;

        const positions = computePositions(data.length);

        const flowNodes: FlowNode[] = data.map((y, i) => ({
          id: y.protocolName,
          label: y.protocolName,
          position: positions[i],
          apy: y.apy,
          tvl: y.tvl,
          riskScore: y.riskScore,
          color: riskToColor(y.riskScore),
          speed: mapApy(y.apy),
          particleCount: mapTvl(y.tvl, maxParticlesPerStream),
          nodeRadius: mapNodeRadius(y.tvl),
        }));

        setNodes(flowNodes);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchYields();
    timerRef.current = setInterval(fetchYields, POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(timerRef.current);
    };
  }, [maxParticlesPerStream]);

  return { nodes, loading, error };
}
