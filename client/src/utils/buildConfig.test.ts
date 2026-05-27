import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const VITE_CONFIG_PATH = resolve(__dirname, "../../../vite.config.ts");

/**
 * Regression tests for the Vite/Vercel production build configuration.
 *
 * Vercel deploys the client as a static site. The `base: './'` setting in
 * vite.config.ts is required so asset URLs are relative — without it, assets
 * 404 when served from a sub-path or CDN prefix.
 */
describe("Vercel production build config", () => {
  let configSource: string;

  try {
    configSource = readFileSync(VITE_CONFIG_PATH, "utf-8");
  } catch {
    configSource = "";
  }

  it("vite.config.ts exists", () => {
    expect(configSource.length).toBeGreaterThan(0);
  });

  it("base is set to './' for relative asset paths on Vercel", () => {
    expect(configSource).toMatch(/base\s*:\s*['"]\.\//);
  });

  it("@vitejs/plugin-react is included", () => {
    expect(configSource).toMatch(/@vitejs\/plugin-react/);
  });

  it("@tailwindcss/vite plugin is included", () => {
    expect(configSource).toMatch(/@tailwindcss\/vite/);
  });
});
