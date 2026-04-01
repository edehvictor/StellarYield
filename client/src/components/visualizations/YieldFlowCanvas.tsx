import { Suspense, useRef, useEffect, useState, lazy } from "react";
import { Canvas } from "@react-three/fiber";
import { useAdaptiveQuality } from "./hooks/useAdaptiveQuality";
import type { YieldFlowCanvasProps } from "./types";

const DashboardScene = lazy(() => import("./scenes/DashboardScene"));
const PortfolioScene = lazy(() => import("./scenes/PortfolioScene"));

function WebGLFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-3 h-16 w-16 rounded-full bg-[#6C5DD3]/20 animate-pulse" />
        <p className="text-sm text-gray-400">Yield Flow Visualization</p>
      </div>
    </div>
  );
}

function CanvasLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#6C5DD3] border-t-transparent" />
    </div>
  );
}

export default function YieldFlowCanvas({
  scene,
  positions,
  className = "",
}: YieldFlowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [webglSupported, setWebglSupported] = useState(true);
  const quality = useAdaptiveQuality();

  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl =
        canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) setWebglSupported(false);
    } catch {
      setWebglSupported(false);
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`glass-card relative overflow-hidden ${className}`}
      style={{ height: window.innerWidth < 768 ? 250 : 400 }}
    >
      <div className="absolute left-4 top-4 z-10">
        <h3 className="text-sm font-semibold text-gray-300 tracking-wide uppercase">
          {scene === "dashboard" ? "Yield Flow" : "Portfolio Flow"}
        </h3>
      </div>

      {!webglSupported ? (
        <WebGLFallback />
      ) : !visible ? (
        <CanvasLoader />
      ) : (
        <Canvas
          dpr={quality.pixelRatio}
          camera={{ position: [0, 0, 8], fov: 50 }}
          style={{ background: "transparent" }}
          gl={{ alpha: true, antialias: quality.tier !== "low", powerPreference: "default" }}
        >
          <ambientLight intensity={0.3} />
          <pointLight position={[0, 0, 5]} intensity={0.8} color="#6C5DD3" />
          <Suspense fallback={null}>
            {scene === "dashboard" ? (
              <DashboardScene quality={quality} />
            ) : (
              <PortfolioScene quality={quality} positions={positions || []} />
            )}
          </Suspense>
        </Canvas>
      )}
    </div>
  );
}
