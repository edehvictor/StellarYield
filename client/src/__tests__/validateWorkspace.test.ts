import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import * as child_process from "child_process";
import {
  checkNodeVersion,
  checkRust,
  checkWorkspaceDependencies,
  checkEnvFiles,
  checkNetworkReachability,
  parseEnvFile,
} from "../../../scripts/validate-workspace.js";

describe("Workspace Validator Script Checks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("checkNodeVersion", () => {
    it("passes for Node >= 18", () => {
      const originalVersion = process.version;
      Object.defineProperty(process, "version", {
        value: "v18.15.0",
        writable: true,
      });

      const result = checkNodeVersion();
      expect(result.success).toBe(true);

      Object.defineProperty(process, "version", {
        value: "v20.2.0",
        writable: true,
      });
      const result2 = checkNodeVersion();
      expect(result2.success).toBe(true);

      // Restore
      Object.defineProperty(process, "version", {
        value: originalVersion,
        writable: true,
      });
    });

    it("fails for Node < 18", () => {
      const originalVersion = process.version;
      Object.defineProperty(process, "version", {
        value: "v16.14.0",
        writable: true,
      });

      const result = checkNodeVersion();
      expect(result.success).toBe(false);
      expect(result.message).toContain("Version >= 18 is required");

      // Restore
      Object.defineProperty(process, "version", {
        value: originalVersion,
        writable: true,
      });
    });
  });

  describe("checkRust", () => {
    it("passes when rustc and cargo versions are fetched successfully", () => {
      const mockExec = vi.fn().mockReturnValue(Buffer.from("rustc 1.70.0 (90c541806 2023-05-31)"));
      const result = checkRust(mockExec as any);
      expect(result.success).toBe(true);
      expect(result.message).toContain("rustc");
    });

    it("fails when rustc or cargo are missing", () => {
      const mockExec = vi.fn().mockImplementation(() => {
        throw new Error("command not found");
      });
      const result = checkRust(mockExec as any);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Rust or Cargo compiler not found");
    });
  });

  describe("checkWorkspaceDependencies", () => {
    it("passes when node_modules exists in all workspaces", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const result = checkWorkspaceDependencies();
      expect(result.success).toBe(true);
    });

    it("fails when any node_modules is missing", () => {
      // Mock existsSync to return false (missing dependencies)
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const result = checkWorkspaceDependencies();
      expect(result.success).toBe(false);
      expect(result.message).toContain("Dependencies are missing in");
    });
  });

  describe("checkEnvFiles", () => {
    it("passes when env files exist", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const result = checkEnvFiles();
      expect(result.success).toBe(true);
    });

    it("fails when client env.local or server env is missing", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const result = checkEnvFiles();
      expect(result.success).toBe(false);
      expect(result.message).toContain("missing");
    });
  });

  describe("parseEnvFile", () => {
    it("correctly parses key-value pairs", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        "VITE_API_BASE_URL=http://localhost:3001\n# Comment\nVITE_SOROBAN_RPC_URL=\"https://soroban-testnet.stellar.org\"\n"
      );

      const envs = parseEnvFile("test-path");
      expect(envs.VITE_API_BASE_URL).toBe("http://localhost:3001");
      expect(envs.VITE_SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    });
  });
});
