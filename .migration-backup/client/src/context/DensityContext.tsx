import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";

export type DensityMode = "compact" | "comfortable" | "spacious";

export interface DensityContextValue {
  density: DensityMode;
  setDensity: (mode: DensityMode) => void;
  /** CSS class name for the current density */
  densityClass: string;
  /** Spacing scale multiplier (0.75 compact, 1 comfortable, 1.25 spacious) */
  spacingScale: number;
  /** Font size scale multiplier (0.85 compact, 1 comfortable, 1.1 spacious) */
  fontScale: number;
}

const STORAGE_KEY = "stellar-yield.density-mode";

const DENSITY_CONFIG: Record<DensityMode, { spacingScale: number; fontScale: number; className: string }> = {
  compact: { spacingScale: 0.75, fontScale: 0.85, className: "density-compact" },
  comfortable: { spacingScale: 1, fontScale: 1, className: "density-comfortable" },
  spacious: { spacingScale: 1.25, fontScale: 1.1, className: "density-spacious" },
};

export function loadDensity(): DensityMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "compact" || stored === "comfortable" || stored === "spacious") {
      return stored;
    }
  } catch {
    return "comfortable";
  }
  return "comfortable";
}

function saveDensity(mode: DensityMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    return;
  }
}

export const DensityContext = createContext<DensityContextValue | undefined>(undefined);

export function DensityProvider({ children }: { children: React.ReactNode }) {
  const [density, setDensityState] = useState<DensityMode>(loadDensity);

  const setDensity = useCallback((mode: DensityMode) => {
    setDensityState(mode);
    saveDensity(mode);
  }, []);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        if (e.newValue === "compact" || e.newValue === "comfortable" || e.newValue === "spacious") {
          setDensityState(e.newValue);
        }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const config = DENSITY_CONFIG[density];

  const value = useMemo<DensityContextValue>(() => ({
    density,
    setDensity,
    densityClass: config.className,
    spacingScale: config.spacingScale,
    fontScale: config.fontScale,
  }), [density, setDensity, config]);

  return (
    <DensityContext.Provider value={value}>
      {children}
    </DensityContext.Provider>
  );
}

export function useDensity(): DensityContextValue {
  const context = useContext(DensityContext);
  if (!context) {
    return {
      density: "comfortable",
      setDensity: () => {},
      densityClass: "density-comfortable",
      spacingScale: 1,
      fontScale: 1,
    };
  }
  return context;
}
