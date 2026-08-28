import crypto from "crypto";
import { validateIconAssetOrThrow, DEFAULT_ICON_CONFIG } from "../../utils/iconValidator";

export interface VaultMetadataInput {
  vaultName: string;
  description: string;
  iconSvg: string;
}

export interface VaultMetadataPayload {
  name: string;
  description: string;
  icon: string;
  createdAt: string;
}

export interface UploadVaultMetadataResult {
  cid: string;
  metadataUri: string;
  iconUri: string;
  metadata: VaultMetadataPayload;
  uploadMode: "pinata" | "local-fallback";
}

const PINATA_FILE_API = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_JSON_API = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

export function sanitizeSvg(svg: string): string {
  const normalized = requireNonEmpty(svg, "iconSvg");

  if (!normalized.includes("<svg")) {
    throw new Error("iconSvg must be a valid SVG string");
  }

  return normalized
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a VaultMetadataInput object, returning a structured result.
 * Returns { ok: true } on success, or { ok: false, errors: [...] } on failure.
 */
export function validateVaultMetadataInput(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (input === null || input === undefined || typeof input !== "object") {
    return { ok: false, errors: ["Input must be a non-null object"] };
  }

  const p = input as Record<string, unknown>;

  if (!p.vaultName || typeof p.vaultName !== "string" || (p.vaultName as string).trim() === "") {
    errors.push("vaultName is required");
  }

  if (!p.description || typeof p.description !== "string" || (p.description as string).trim() === "") {
    errors.push("description is required");
  }

  if (!p.iconSvg || typeof p.iconSvg !== "string" || (p.iconSvg as string).trim() === "") {
    errors.push("iconSvg is required");
  } else {
    const svg = p.iconSvg as string;
    if (!svg.includes("<svg")) {
      errors.push("iconSvg must be a valid SVG string");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function makeDeterministicCid(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 46);
}

function buildMetadata(
  input: VaultMetadataInput,
  iconCid: string,
  createdAt = new Date().toISOString(),
): VaultMetadataPayload {
  return {
    name: requireNonEmpty(input.vaultName, "vaultName"),
    description: requireNonEmpty(input.description, "description"),
    icon: `ipfs://${iconCid}`,
    createdAt,
  };
}

async function uploadSvgToPinata(svg: string, pinataJwt: string): Promise<string> {
  const body = new FormData();
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  body.append("file", svgBlob, "vault-icon.svg");

  const response = await fetch(PINATA_FILE_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata SVG upload failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) {
    throw new Error("Pinata SVG upload failed: missing IpfsHash in response");
  }

  return data.IpfsHash;
}

async function uploadJsonToPinata(
  payload: VaultMetadataPayload,
  pinataJwt: string,
): Promise<string> {
  const response = await fetch(PINATA_JSON_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pinataJwt}`,
    },
    body: JSON.stringify({
      pinataContent: payload,
      pinataMetadata: {
        name: `vault-metadata-${payload.name}.json`,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata JSON upload failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) {
    throw new Error("Pinata JSON upload failed: missing IpfsHash in response");
  }

  return data.IpfsHash;
}

export async function uploadVaultMetadata(
  input: VaultMetadataInput,
): Promise<UploadVaultMetadataResult> {
  validateIconAssetOrThrow(input.iconSvg, "image/svg+xml", DEFAULT_ICON_CONFIG);
  const sanitizedSvg = sanitizeSvg(input.iconSvg);
  const pinataJwt = process.env.PINATA_JWT?.trim();

  if (!pinataJwt) {
    const iconCid = makeDeterministicCid(`icon:${sanitizedSvg}`);
    const metadata = buildMetadata(input, iconCid, "1970-01-01T00:00:00.000Z");
    const metadataCid = makeDeterministicCid(
      `meta:${JSON.stringify(metadata)}:${sanitizedSvg}`,
    );

    return {
      cid: metadataCid,
      metadataUri: `ipfs://${metadataCid}`,
      iconUri: `ipfs://${iconCid}`,
      metadata,
      uploadMode: "local-fallback",
    };
  }

  const iconCid = await uploadSvgToPinata(sanitizedSvg, pinataJwt);
  const metadata = buildMetadata(input, iconCid);
  const metadataCid = await uploadJsonToPinata(metadata, pinataJwt);

  return {
    cid: metadataCid,
    metadataUri: `ipfs://${metadataCid}`,
    iconUri: `ipfs://${iconCid}`,
    metadata,
    uploadMode: "pinata",
  };
}
