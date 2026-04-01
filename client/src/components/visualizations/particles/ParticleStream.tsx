import { useRef, useMemo } from "react";
import { Color, Vector3, AdditiveBlending } from "three";
import type { InstancedMesh } from "three";
import { useParticleSimulation } from "./useParticleSimulation";

interface ParticleStreamProps {
  origin: [number, number, number];
  target: [number, number, number];
  count: number;
  speed: number;
  color: string;
  enableGlow: boolean;
}

export default function ParticleStream({
  origin,
  target,
  count,
  speed,
  color,
  enableGlow,
}: ParticleStreamProps) {
  const meshRef = useRef<InstancedMesh>(null);

  const originVec = useMemo(() => new Vector3(...origin), [origin]);
  const targetVec = useMemo(() => new Vector3(...target), [target]);
  const threeColor = useMemo(() => new Color(color), [color]);

  useParticleSimulation(meshRef, {
    count,
    speed,
    origin: originVec,
    target: targetVec,
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial
        color={threeColor}
        transparent
        opacity={enableGlow ? 0.8 : 0.6}
        depthWrite={false}
        blending={enableGlow ? AdditiveBlending : undefined}
      />
    </instancedMesh>
  );
}
