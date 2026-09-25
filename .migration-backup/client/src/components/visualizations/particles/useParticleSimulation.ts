import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Object3D,
  Vector3,
  QuadraticBezierCurve3,
  InstancedMesh,
} from "three";
import { useReducedMotion } from "../../../hooks/useReducedMotion";

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
  const reducedMotion = useReducedMotion();

  const curve = useMemo(() => {
    const mid = new Vector3()
      .addVectors(origin, target)
      .multiplyScalar(0.5);
    const perpX = -(target.y - origin.y) * 0.4;
    const perpY = (target.x - origin.x) * 0.4;
    mid.x += perpX;
    mid.y += perpY;
    return new QuadraticBezierCurve3(origin, mid, target);
  }, [origin, target]);

  const progresses = useMemo(() => {
    const arr = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = Math.random();
    }
    return arr;
  }, [count]);

  // Pre-compute static positions for reduced-motion mode
  const staticPositions = useMemo(() => {
    const positions: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const pt = new Vector3();
      curve.getPoint(progresses[i], pt);
      positions.push(pt);
    }
    return positions;
  }, [curve, count, progresses]);

  const _point = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    if (reducedMotion) {
      // Render particles at fixed positions along the curve — no movement
      for (let i = 0; i < count; i++) {
        _dummy.position.copy(staticPositions[i]);
        _dummy.scale.setScalar(0.08);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }

    const clampedDelta = Math.min(delta, 0.05);

    for (let i = 0; i < count; i++) {
      progresses[i] += clampedDelta * speed * 0.15;
      if (progresses[i] > 1) progresses[i] -= 1;

      curve.getPoint(progresses[i], _point);

      const wobble = Math.sin(progresses[i] * Math.PI * 4 + i * 1.7) * 0.06;
      _point.x += wobble;
      _point.y += wobble * 0.5;

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
