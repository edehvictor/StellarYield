import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Object3D,
  Vector3,
  QuadraticBezierCurve3,
  InstancedMesh,
} from "three";

interface ParticleSimConfig {
  count: number;
  speed: number;
  origin: Vector3;
  target: Vector3;
}

const _dummy = new Object3D();

export function useParticleSimulation(
  meshRef: React.RefObject<InstancedMesh | null>,
  config: ParticleSimConfig
) {
  const { count, speed, origin, target } = config;

  const curve = useMemo(() => {
    const mid = new Vector3()
      .addVectors(origin, target)
      .multiplyScalar(0.5);
    // Arc the curve outward for visual appeal
    const perpX = -(target.y - origin.y) * 0.4;
    const perpY = (target.x - origin.x) * 0.4;
    mid.x += perpX;
    mid.y += perpY;
    return new QuadraticBezierCurve3(origin, mid, target);
  }, [origin, target]);

  // Initialize particle progress values randomly along the curve
  const progresses = useMemo(() => {
    const arr = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = Math.random();
    }
    return arr;
  }, [count]);

  const _point = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const clampedDelta = Math.min(delta, 0.05); // Clamp to avoid jumps on tab refocus

    for (let i = 0; i < count; i++) {
      progresses[i] += clampedDelta * speed * 0.15;
      if (progresses[i] > 1) progresses[i] -= 1;

      curve.getPoint(progresses[i], _point);

      // Add slight perpendicular wobble
      const wobble = Math.sin(progresses[i] * Math.PI * 4 + i * 1.7) * 0.06;
      _point.x += wobble;
      _point.y += wobble * 0.5;

      // Scale particles: larger in the middle of the curve
      const t = progresses[i];
      const scale = 0.6 + Math.sin(t * Math.PI) * 0.4;

      _dummy.position.copy(_point);
      _dummy.scale.setScalar(scale * 0.08);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
  });
}
