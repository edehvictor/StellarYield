/**
 * Portfolio import validation for external CSV files (#1340).
 */
import request from "supertest";
import express from "express";
import portfolioImportRouter from "../routes/portfolioImport";
import { validatePortfolioImportCsv } from "../../../shared/types/portfolioImport";

const HEADER = "protocol,asset,depositedUsd,currentValueUsd";

function preview(csv: string) {
  const result = validatePortfolioImportCsv(csv);
  if (!result.ok) throw new Error(`expected a preview, got ${result.error.code}`);
  return result.preview;
}

function failureCode(csv: string, limits?: { maxBytes?: number; maxRows?: number }) {
  const result = validatePortfolioImportCsv(csv, limits);
  return result.ok ? null : result.error.code;
}

describe("validatePortfolioImportCsv", () => {
  it("accepts a well-formed file and totals the holdings", () => {
    const result = preview(`${HEADER}\nBlend,USDC,1000,1012.5\nSoroswap,XLM,250.25,240\n`);

    expect(result.holdings).toEqual([
      { row: 2, protocol: "Blend", asset: "USDC", depositedUsd: 1000, currentValueUsd: 1012.5 },
      { row: 3, protocol: "Soroswap", asset: "XLM", depositedUsd: 250.25, currentValueUsd: 240 },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      totalDepositedUsd: 1250.25,
      totalCurrentValueUsd: 1252.5,
    });
  });

  it("accepts StellarYield's own export header, a BOM, CRLF, quoted values and extra columns", () => {
    const csv =
      "﻿Protocol,Asset,Deposited (USD),Current Value (USD),Source Freshness,Last Updated\r\n" +
      '"Blend, Pool A",USDC,100,101,fresh,2026-09-24T09:00:00Z\r\n';

    expect(preview(csv).holdings).toEqual([
      { row: 2, protocol: "Blend, Pool A", asset: "USDC", depositedUsd: 100, currentValueUsd: 101 },
    ]);
  });

  it("collects row issues and keeps the valid rows", () => {
    const result = preview(
      [
        HEADER,
        "Blend,USDC,100,101",
        "Blend,,abc,-5",
        "Soroswap,XLM,10",
        "blend,usdc,1,1",
        "DeFindex,BTC,5,6",
      ].join("\n"),
    );

    expect(result.holdings.map((h) => h.row)).toEqual([2, 6]);
    expect(result.issues.map(({ row, column, code }) => [row, column, code])).toEqual([
      [3, "asset", "ROW_MISSING_VALUE"],
      [3, "depositedUsd", "ROW_INVALID_AMOUNT"],
      [3, "currentValueUsd", "ROW_NEGATIVE_AMOUNT"],
      [4, null, "ROW_COLUMN_COUNT"],
      [5, null, "ROW_DUPLICATE_HOLDING"],
    ]);
    expect(result.summary).toMatchObject({ totalRows: 5, validRows: 2, invalidRows: 3 });
  });

  it("returns stable file-level failure codes", () => {
    expect(failureCode("")).toBe("IMPORT_EMPTY_FILE");
    expect(failureCode("  \n\n")).toBe("IMPORT_EMPTY_FILE");
    expect(failureCode(`${HEADER}\n"Blend,USDC,1,1`)).toBe("IMPORT_MALFORMED_CSV");
    expect(failureCode("protocol,asset\nBlend,USDC")).toBe("IMPORT_MISSING_COLUMNS");
    expect(failureCode(`${HEADER},deposited\nBlend,USDC,1,1,1`)).toBe("IMPORT_DUPLICATE_COLUMNS");
    expect(failureCode(`${HEADER}\n`)).toBe("IMPORT_NO_DATA_ROWS");
    expect(failureCode(`${HEADER}\nBlend,USDC,1,1`, { maxBytes: 10 })).toBe("IMPORT_FILE_TOO_LARGE");
    expect(failureCode(`${HEADER}\nBlend,USDC,1,1\nBlend,XLM,1,1`, { maxRows: 1 })).toBe("IMPORT_TOO_MANY_ROWS");
  });

  it("names the missing columns", () => {
    const result = validatePortfolioImportCsv("Protocol,Asset,Deposited\nBlend,USDC,1");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "IMPORT_MISSING_COLUMNS",
        details: { missingColumns: ["currentValueUsd"] },
      }),
    });
  });

  it("is deterministic for the same input", () => {
    const csv = `${HEADER}\nBlend,USDC,100,101\nBlend,,x,1`;
    expect(validatePortfolioImportCsv(csv)).toEqual(validatePortfolioImportCsv(csv));
  });
});

describe("POST /api/portfolio/import/validate", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/portfolio/import", portfolioImportRouter);

  it("returns the preview for a valid file", async () => {
    const res = await request(app)
      .post("/api/portfolio/import/validate")
      .send({ csv: `${HEADER}\nBlend,USDC,1000,1012.5` });

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalRows: 1, validRows: 1 });
    expect(res.body.holdings[0]).toMatchObject({ protocol: "Blend", asset: "USDC" });
  });

  it("answers 422 with the typed code and missing columns", async () => {
    const res = await request(app)
      .post("/api/portfolio/import/validate")
      .send({ csv: "protocol,asset\nBlend,USDC" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "IMPORT_MISSING_COLUMNS",
      details: { missingColumns: ["depositedUsd", "currentValueUsd"] },
    });
  });

  it("rejects a request without CSV contents", async () => {
    const res = await request(app).post("/api/portfolio/import/validate").send({ file: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IMPORT_INVALID_REQUEST");
  });
});
