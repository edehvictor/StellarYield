import { shaderMaterial } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import { Color, AdditiveBlending } from "three";

const GlowParticleMaterial = shaderMaterial(
  {
    uColor: new Color("#6C5DD3"),
    uOpacity: 1.0,
  },
  // Vertex shader
  `
    varying float vDistance;
    void main() {
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      vDistance = -mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  // Fragment shader
  `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vDistance;
    void main() {
      float dist = length(gl_PointCoord - vec2(0.5));
      if (dist > 0.5) discard;

      float glow = 1.0 - smoothstep(0.0, 0.5, dist);
      glow = pow(glow, 1.5);

      float depthFade = clamp(1.0 / (1.0 + vDistance * 0.05), 0.3, 1.0);

      gl_FragColor = vec4(uColor, glow * uOpacity * depthFade);
    }
  `
);

GlowParticleMaterial.defaultProps = {
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
};

extend({ GlowParticleMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    glowParticleMaterial: JSX.IntrinsicElements["shaderMaterial"] & {
      uColor?: Color;
      uOpacity?: number;
    };
  }
}

export { GlowParticleMaterial };
