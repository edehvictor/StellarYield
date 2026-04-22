import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import type { Mesh, Vector3Tuple } from "three";

interface ProtocolNodeProps {
  position: Vector3Tuple;
  label: string;
  color: string;
  radius: number;
  apy: number;
}

export default function ProtocolNode({
  position,
  label,
  color,
  radius,
  apy,
}: ProtocolNodeProps) {
  const meshRef = useRef<Mesh>(null);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.scale.setScalar(
        1 + Math.sin(Date.now() * 0.002) * 0.05
      );
    }
  });

  return (
    <group position={position}>
      {/* Node sphere */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[radius, 20, 20]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.4}
          transparent
          opacity={0.85}
        />
      </mesh>

      {/* Outer glow */}
      <mesh>
        <sphereGeometry args={[radius * 1.4, 12, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.1}
          depthWrite={false}
        />
      </mesh>

      {/* Label */}
      <Html
        position={[0, -(radius + 0.4), 0]}
        center
        style={{ pointerEvents: "none" }}
      >
        <div className="whitespace-nowrap text-center">
          <p
            className="text-xs font-semibold"
            style={{ color, textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}
          >
            {label}
          </p>
          <p className="text-[10px] text-gray-400">{apy.toFixed(1)}% APY</p>
        </div>
      </Html>
    </group>
  );
}
