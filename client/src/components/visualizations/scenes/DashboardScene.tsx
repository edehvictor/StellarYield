import { useYieldFlowData } from "../hooks/useYieldFlowData";
import CentralHub from "../nodes/CentralHub";
import ProtocolNode from "../nodes/ProtocolNode";
import ParticleStream from "../particles/ParticleStream";
import BackgroundStars from "../effects/BackgroundStars";
import type { QualityConfig } from "../types";
import { useReducedMotion } from "../../../hooks/useReducedMotion";

interface DashboardSceneProps {
  quality: QualityConfig;
}

const HUB_POSITION: [number, number, number] = [0, -1, 0];

export default function DashboardScene({ quality }: DashboardSceneProps) {
  const { nodes } = useYieldFlowData(quality.maxParticlesPerStream);
  const reducedMotion = useReducedMotion();

  return (
    <>
      {quality.enableStars && !reducedMotion && <BackgroundStars />}
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
          {/* Particle streams are disabled under reduced motion */}
          {!reducedMotion && (
            <ParticleStream
              origin={HUB_POSITION}
              target={node.position}
              count={Math.min(node.particleCount, quality.maxParticlesPerStream)}
              speed={node.speed}
              color={node.color}
              enableGlow={quality.enableGlow}
            />
          )}
        </group>
      ))}
    </>
  );
}
