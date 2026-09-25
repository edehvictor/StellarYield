import { useState, useEffect, useCallback, useRef } from "react";
import type { QualityConfig, QualityTier } from "../types";

const QUALITY_CONFIGS: Record<QualityTier, QualityConfig> = {
  low: {
    tier: "low",
    maxParticlesPerStream: 15,
    maxTotalParticles: 100,
    pixelRatio: 1.0,
    enableGlow: false,
    enableStars: false,
  },
  medium: {
    tier: "medium",
    maxParticlesPerStream: 40,
    maxTotalParticles: 300,
    pixelRatio: 1.5,
    enableGlow: true,
    enableStars: true,
  },
  high: {
    tier: "high",
    maxParticlesPerStream: 80,
    maxTotalParticles: 600,
    pixelRatio: 2.0,
    enableGlow: true,
    enableStars: true,
  },
};

function detectInitialTier(): QualityTier {
  if (typeof window === "undefined") return "medium";

  const isMobile =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.innerWidth < 768);

  const cores = navigator.hardwareConcurrency || 4;

  if (isMobile || cores < 4) return "low";
  if (cores >= 8 && window.innerWidth >= 1280) return "high";
  return "medium";
}

export function useAdaptiveQuality(): QualityConfig {
  const [tier, setTier] = useState<QualityTier>(detectInitialTier);
  const slowFrames = useRef(0);
  const lastDowngrade = useRef(0);

  const reportFrameTime = useCallback(
    (deltaMs: number) => {
      if (deltaMs > 20) {
        slowFrames.current++;
      } else {
        slowFrames.current = Math.max(0, slowFrames.current - 1);
      }

      const now = Date.now();
      if (
        slowFrames.current >= 3 &&
        now - lastDowngrade.current > 5000
      ) {
        slowFrames.current = 0;
        lastDowngrade.current = now;
        setTier((prev) => {
          if (prev === "high") return "medium";
          if (prev === "medium") return "low";
          return prev;
        });
      }
    },
    []
  );

  useEffect(() => {
    const handle = () => {
      if (document.visibilityState === "hidden") {
        slowFrames.current = 0;
      }
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, []);

  const config = QUALITY_CONFIGS[tier];
  return { ...config, reportFrameTime } as QualityConfig & {
    reportFrameTime: (deltaMs: number) => void;
  };
}
