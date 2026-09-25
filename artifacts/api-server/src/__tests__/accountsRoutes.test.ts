import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { LinkStellarAccountResponse } from "@workspace/api-zod";
import { createApp } from "../app";
import { LinkStellarAccountService } from "../services/stellarAccounts/linkStellarAccountService";
import { InMemoryStellarAccountRepository } from "./helpers/inMemoryStellarAccountRepository";

const CLIENT_ID = "client-alpha";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let server: Server;
let baseUrl: string;
let repository: InMemoryStellarAccountRepository;

beforeAll(async () => {
  repository = new InMemoryStellarAccountRepository();
  const app = createApp({
    linkStellarAccount: new LinkStellarAccountService(repository),
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(
  () => new Promise<void>((resolve) => server.close(() => resolve())),
);

beforeEach(() => {
  repository.clear();
});

function validKey(): string {
  return Keypair.random().publicKey();
}

async function postLink(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/accounts/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function readError(
  response: Response,
): Promise<{ code: string; message: string; details?: unknown }> {
  const body = await readJson(response);
  const error = (body["error"] ?? {}) as Record<string, unknown>;

  return {
    code: String(error["code"]),
    message: String(error["message"]),
    details: error["details"],
  };
}

describe("POST /api/accounts/link", () => {
  it("links a standard well-formed alphanumeric Stellar public key", async () => {
    const publicKey = validKey();

    const response = await postLink({ clientId: CLIENT_ID, publicKey });

    expect(response.status).toBe(200);
    const body = await readJson(response);

    // The payload must satisfy the generated OpenAPI response schema.
    expect(() => LinkStellarAccountResponse.parse(body)).not.toThrow();

    const account = (body["account"] ?? {}) as Record<string, unknown>;
    expect(account["clientId"]).toBe(CLIENT_ID);
    expect(account["publicKey"]).toBe(publicKey);
    expect(account["id"]).toMatch(UUID_PATTERN);
    expect(typeof account["linkedAt"]).toBe("string");

    expect(repository.size()).toBe(1);
  });

  it("keeps the health route working (existing behavior preserved)", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: "ok" });
  });

  it("is idempotent for an already linked account", async () => {
    const publicKey = validKey();

    const first = await postLink({ clientId: CLIENT_ID, publicKey });
    const second = await postLink({ clientId: CLIENT_ID, publicKey });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstAccount = ((await readJson(first))["account"] ?? {}) as Record<
      string,
      unknown
    >;
    const secondAccount = ((await readJson(second))["account"] ?? {}) as Record<
      string,
      unknown
    >;

    expect(secondAccount["id"]).toBe(firstAccount["id"]);
    expect(repository.size()).toBe(1);
  });

  it("accepts a whitespace-padded key and stores it normalized", async () => {
    const publicKey = validKey();

    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: `  ${publicKey}  `,
    });

    expect(response.status).toBe(200);
    const account = ((await readJson(response))["account"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(account["publicKey"]).toBe(publicKey);
  });

  it("returns typed 400 INVALID_PUBLIC_KEY for a wrong prefix", async () => {
    const key = validKey();
    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: "R" + key.slice(1),
    });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("INVALID_PUBLIC_KEY");
    expect(error.message).toBe(
      "publicKey is not a valid Stellar public key.",
    );
    expect(error.details).toEqual([
      { path: "publicKey", message: "publicKey must start with the prefix G." },
    ]);
    expect(repository.size()).toBe(0);
  });

  it("returns typed 400 INVALID_PUBLIC_KEY for a short key", async () => {
    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: validKey().slice(0, 40),
    });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("INVALID_PUBLIC_KEY");
    expect(error.details).toEqual([
      {
        path: "publicKey",
        message: "publicKey must be exactly 56 characters long.",
      },
    ]);
    expect(repository.size()).toBe(0);
  });

  it("returns typed 400 INVALID_PUBLIC_KEY for non-alphanumeric input", async () => {
    const key = validKey();
    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: key.slice(0, 25) + "#" + key.slice(26),
    });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("INVALID_PUBLIC_KEY");
    expect(error.details).toEqual([
      {
        path: "publicKey",
        message: "publicKey must only contain base32 characters (A-Z, 2-7).",
      },
    ]);
    expect(repository.size()).toBe(0);
  });

  it("returns typed 400 INVALID_PUBLIC_KEY when the StrKey checksum fails", async () => {
    const key = validKey();
    const lastIndex = key.length - 1;
    const flippedIndex = BASE32_ALPHABET.indexOf(key[lastIndex]) ^ 16;
    const corrupted = key.slice(0, lastIndex) + BASE32_ALPHABET[flippedIndex];

    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: corrupted,
    });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("INVALID_PUBLIC_KEY");
    expect(error.details).toEqual([
      {
        path: "publicKey",
        message: "publicKey failed StrKey checksum validation.",
      },
    ]);
    expect(repository.size()).toBe(0);
  });

  it("returns typed 400 MISSING_PUBLIC_KEY for an empty string", async () => {
    const response = await postLink({ clientId: CLIENT_ID, publicKey: "" });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("MISSING_PUBLIC_KEY");
    expect(error.message).toBe(
      "publicKey is required to link a Stellar account.",
    );
    expect(repository.size()).toBe(0);
  });

  it("returns typed 400 MISSING_PUBLIC_KEY for a null public key", async () => {
    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: null,
    });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("MISSING_PUBLIC_KEY");
  });

  it("returns typed 400 MISSING_PUBLIC_KEY when the field is absent", async () => {
    const response = await postLink({ clientId: CLIENT_ID });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("MISSING_PUBLIC_KEY");
  });

  it("returns typed 400 INVALID_PUBLIC_KEY for non-string public keys", async () => {
    const response = await postLink({ clientId: CLIENT_ID, publicKey: 12345 });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("INVALID_PUBLIC_KEY");
    expect(error.details).toEqual([
      { path: "publicKey", message: "publicKey must be a string." },
    ]);
  });

  it("returns typed 400 INVALID_REQUEST when clientId is missing", async () => {
    const response = await postLink({ publicKey: validKey() });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toBe("Request validation failed.");

    const details = error.details as Array<Record<string, string>>;
    expect(details.some((detail) => detail["path"] === "clientId")).toBe(true);
  });

  it("returns typed 400 instead of crashing when no body is sent", async () => {
    const response = await fetch(`${baseUrl}/accounts/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe("MISSING_PUBLIC_KEY");
  });

  it("returns a stable typed 503 without leaking provider errors when reads fail", async () => {
    repository.failureMode = "read";
    repository.failureError = new Error(
      'connect ECONNREFUSED 10.0.0.5:5432 - relation "stellar_accounts" does not exist',
    );

    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: validKey(),
    });

    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("stellar_accounts");

    const body = JSON.parse(raw) as Record<string, unknown>;
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("ACCOUNT_SERVICE_UNAVAILABLE");
    expect(error["message"]).toBe(
      "Stellar account storage is temporarily unavailable. Please retry.",
    );
  });

  it("returns a stable typed 503 when writes fail after a successful read", async () => {
    repository.failureMode = "write";
    repository.failureError = new Error("timeout exceeded while waiting for lock");

    const response = await postLink({
      clientId: CLIENT_ID,
      publicKey: validKey(),
    });

    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain("timeout");

    const body = JSON.parse(raw) as Record<string, unknown>;
    const error = (body["error"] ?? {}) as Record<string, unknown>;
    expect(error["code"]).toBe("ACCOUNT_SERVICE_UNAVAILABLE");
    expect(repository.size()).toBe(0);
  });

  it("returns the winning record when a concurrent link wins the unique race", async () => {
    const publicKey = validKey();
    repository.duplicateRaceWinner = {
      id: "11111111-1111-4111-8111-111111111111",
      clientId: CLIENT_ID,
      publicKey,
      linkedAt: new Date("2026-09-25T09:00:00.000Z"),
    };

    const response = await postLink({ clientId: CLIENT_ID, publicKey });

    expect(response.status).toBe(200);
    const account = ((await readJson(response))["account"] ?? {}) as Record<
      string,
      unknown
    >;
    expect(account["id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(repository.size()).toBe(0);
  });
});
