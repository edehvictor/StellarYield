import type { Vector3Tuple } from "three";

export interface FlowNode {
  id: string;
  label: string;
  position: Vector3Tuple;
  apy: number;
  tvl: number;
  riskScore: number;
  color: string;
  speed: number;
  particleCount: number;
  nodeRadius: number;
}

export type QualityTier = "low" | "medium" | "high";

export interface QualityConfig {
  tier: QualityTier;
  maxParticlesPerStream: number;
  maxTotalParticles: number;
  pixelRatio: number;
  enableGlow: boolean;
  enableStars: boolean;
}

export interface YieldFlowCanvasProps {
  scene: "dashboard" | "portfolio";
  positions?: PortfolioPosition[];
  className?: string;
}

export interface PortfolioPosition {
  protocol: string;
  asset: string;
  deposited: number;
  currentValue: number;
  apy: number;
  shares: number;
}
