import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Mesh, Group } from "three";
import { useReducedMotion } from "../../../hooks/useReducedMotion";

export default function CentralHub() {
  const groupRef = useRef<Group>(null);
  const ringRef = useRef<Mesh>(null);
  const reducedMotion = useReducedMotion();

  useFrame((_, delta) => {
    if (reducedMotion) return;
    if (ringRef.current) {
      ringRef.current.rotation.z += delta * 0.3;
    }
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.1;
    }
  });

  return (
    <group ref={groupRef} position={[0, -1, 0]}>
      {/* Core sphere */}
      <mesh>
        <sphereGeometry args={[0.4, 24, 24]} />
        <meshStandardMaterial
          color="#6C5DD3"
          emissive="#6C5DD3"
          emissiveIntensity={0.6}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Outer glow */}
      <mesh>
        <sphereGeometry args={[0.55, 16, 16]} />
        <meshBasicMaterial
          color="#6C5DD3"
          transparent
          opacity={0.15}
          depthWrite={false}
        />
      </mesh>

      {/* Rotating ring — static when reduced motion is preferred */}
      <mesh ref={ringRef}>
        <torusGeometry args={[0.7, 0.03, 8, 48]} />
        <meshBasicMaterial
          color="#6C5DD3"
          transparent
          opacity={0.4}
        />
      </mesh>
    </group>
  );
}
