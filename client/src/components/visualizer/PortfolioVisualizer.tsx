import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  PerspectiveCamera,
  Stars,
  Float,
  Text,
  Points,
  PointMaterial,
} from "@react-three/drei";
import * as THREE from "three";

interface PoolNodeProps {
  position: [number, number, number];
  name: string;
  tvl: number;
  yield_rate: number;
  color: string;
}

function PoolNode({ position, name, tvl, yield_rate, color }: PoolNodeProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const size = Math.log10(tvl / 1000) * 0.5 + 0.5;

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.01;
      meshRef.current.position.y =
        position[1] + Math.sin(state.clock.elapsedTime + position[0]) * 0.1;
    }
  });

  return (
    <Float speed={2} rotationIntensity={0.5} floatIntensity={1}>
      <group position={position}>
        <mesh ref={meshRef}>
          <sphereGeometry args={[size, 32, 32]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.5}
            transparent
            opacity={0.8}
            roughness={0.2}
            metalness={0.8}
          />
        </mesh>
        <Text
          position={[0, size + 0.5, 0]}
          fontSize={0.3}
          color="white"
          anchorX="center"
          anchorY="middle"
        >
          {name}
        </Text>
        <Text
          position={[0, -size - 0.5, 0]}
          fontSize={0.2}
          color="#aaa"
          anchorX="center"
          anchorY="middle"
        >
          {`${yield_rate}% APY`}
        </Text>
      </group>
    </Float>
  );
}

function FlowParticles({
  start,
  end,
  count = 50,
  color,
}: {
  start: [number, number, number];
  end: [number, number, number];
  count?: number;
  color: string;
}) {
  const points = useMemo(() => {
    const p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const t = Math.random();
      p[i * 3] = start[0] + (end[0] - start[0]) * t;
      p[i * 3 + 1] = start[1] + (end[1] - start[1]) * t;
      p[i * 3 + 2] = start[2] + (end[2] - start[2]) * t;
    }
    return p;
  }, [start, end, count]);

  const ref = useRef<THREE.Points>(null);

  useFrame(() => {
    if (!ref.current) return;
    const positions = ref.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < count; i++) {
      // Move particles from start to end
      const step = 0.05;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];

      positions[i * 3] += dx * step * Math.random() * 0.1;
      positions[i * 3 + 1] += dy * step * Math.random() * 0.1;
      positions[i * 3 + 2] += dz * step * Math.random() * 0.1;

      // Reset if close to end
      const dist = Math.sqrt(
        Math.pow(positions[i * 3] - end[0], 2) +
          Math.pow(positions[i * 3 + 1] - end[1], 2) +
          Math.pow(positions[i * 3 + 2] - end[2], 2)
      );
      if (dist < 0.5) {
        positions[i * 3] = start[0];
        positions[i * 3 + 1] = start[1];
        positions[i * 3 + 2] = start[2];
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <Points ref={ref} positions={points}>
      <PointMaterial
        transparent
        color={color}
        size={0.05}
        sizeAttenuation={true}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </Points>
  );
}

export default function PortfolioVisualizer() {
  const pools = [
    { name: "USDC-XLM", tvl: 50000, yield: 12.5, color: "#4f46e5", pos: [-5, 2, -3] as [number, number, number] },
    { name: "Y-XLM", tvl: 25000, yield: 18.2, color: "#06b6d4", pos: [5, 1, -2] as [number, number, number] },
    { name: "USDY-USDC", tvl: 120000, yield: 5.4, color: "#10b981", pos: [0, 4, -6] as [number, number, number] },
  ];

  const userPos: [number, number, number] = [0, 0, 0];

  return (
    <div className="w-full h-[600px] glass-panel rounded-2xl overflow-hidden relative border border-white/10 shadow-2xl">
      <div className="absolute top-6 left-6 z-10">
        <h3 className="text-xl font-bold">Portfolio Universe</h3>
        <p className="text-sm text-gray-400">3D visualization of your liquidity nodes</p>
      </div>

      <Canvas dpr={[1, 2]}>
        <PerspectiveCamera makeDefault position={[0, 5, 12]} />
        <OrbitControls enableDamping dampingFactor={0.05} rotateSpeed={0.5} maxDistance={20} minDistance={5} />
        
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} intensity={1} />
        
        {/* User Node */}
        <mesh position={userPos}>
          <icosahedronGeometry args={[0.5, 1]} />
          <meshStandardMaterial color="#fff" emissive="#fff" emissiveIntensity={2} wireframe />
        </mesh>
        <Text
          position={[0, -1, 0]}
          fontSize={0.4}
          color="white"
          anchorX="center"
          anchorY="middle"
        >
          My Portfolio
        </Text>

        {/* Pool Nodes */}
        {pools.map((pool, i) => (
          <group key={i}>
            <PoolNode
              position={pool.pos}
              name={pool.name}
              tvl={pool.tvl}
              yield_rate={pool.yield}
              color={pool.color}
            />
            <FlowParticles
              start={pool.pos}
              end={userPos}
              color={pool.color}
              count={30}
            />
          </group>
        ))}

        <gridHelper args={[20, 20, 0x333333, 0x111111]} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -10]} />
      </Canvas>
    </div>
  );
}
