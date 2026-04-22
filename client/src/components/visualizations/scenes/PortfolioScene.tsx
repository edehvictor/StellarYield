import { useMemo } from "react";
import CentralHub from "../nodes/CentralHub";
import ProtocolNode from "../nodes/ProtocolNode";
import ParticleStream from "../particles/ParticleStream";
import BackgroundStars from "../effects/BackgroundStars";
import type { QualityConfig, PortfolioPosition, FlowNode } from "../types";
import type { Vector3Tuple } from "three";

interface PortfolioSceneProps {
  quality: QualityConfig;
  positions: PortfolioPosition[];
}

const HUB_POSITION: [number, number, number] = [0, -1, 0];

function computeArcPositions(count: number): Vector3Tuple[] {
  const result: Vector3Tuple[] = [];
  const arcStart = -Math.PI * 0.4;
  const arcEnd = Math.PI * 0.4;
  const radius = 4;

  for (let i = 0; i < count; i++) {
    const angle =
      count === 1
        ? 0
        : arcStart + (i / (count - 1)) * (arcEnd - arcStart);
    result.push([
      Math.sin(angle) * radius,
      Math.cos(angle) * radius - 1,
      0,
    ]);
  }
  return result;
}

export default function PortfolioScene({
  quality,
  positions,
}: PortfolioSceneProps) {
  const nodes: FlowNode[] = useMemo(() => {
    if (!positions.length) return [];

    const arcPositions = computeArcPositions(positions.length);
    const maxDeposited = Math.max(...positions.map((p) => p.deposited), 1);
    const maxValue = Math.max(...positions.map((p) => p.currentValue), 1);

    return positions.map((pos, i) => {
      const depositRatio = pos.deposited / maxDeposited;
      const valueRatio = pos.currentValue / maxValue;

      return {
        id: `${pos.protocol}-${pos.asset}`,
        label: `${pos.protocol} (${pos.asset})`,
        position: arcPositions[i],
        apy: pos.apy,
        tvl: pos.currentValue,
        riskScore: 7,
        color: pos.currentValue >= pos.deposited ? "#3EAC75" : "#FF5E5E",
        speed: 0.3 + Math.min(pos.apy / 15, 1) * 1.7,
        particleCount: Math.max(
          10,
          Math.round(depositRatio * quality.maxParticlesPerStream)
        ),
        nodeRadius: 0.3 + valueRatio * 0.7,
      };
    });
  }, [positions, quality.maxParticlesPerStream]);

  if (!nodes.length) {
    return (
      <>
        {quality.enableStars && <BackgroundStars count={80} />}
        <CentralHub />
      </>
    );
  }

  return (
    <>
      {quality.enableStars && <BackgroundStars />}
      <CentralHub />

      {nodes.map((node) => (
        <group key={node.id}>
          <ProtocolNode
            position={node.position}
            label={node.label}
            color={node.color}
            radius={node.nodeRadius}
            apy={node.apy}
          />
          <ParticleStream
            origin={HUB_POSITION}
            target={node.position}
            count={Math.min(node.particleCount, quality.maxParticlesPerStream)}
            speed={node.speed}
            color={node.color}
            enableGlow={quality.enableGlow}
          />
        </group>
      ))}
    </>
  );
}
