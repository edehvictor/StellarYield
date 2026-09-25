import { Readable } from "stream";
import {
    generateCSV,
    createCSVStream,
    type TransactionRecord,
} from "../services/export";

function makeRecord(index: number): TransactionRecord {
    return {
        date: `2025-01-${(index % 28 + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
        action: index % 3 === 0 ? "DEPOSIT" : index % 3 === 1 ? "WITHDRAW" : "HARVEST",
        asset: "USDC",
        amount: (index + 1) * 10.1234567,
        usdValue: (index + 1) * 10.5,
        txHash: `txhash_${index}_abcdef1234567890`,
    };
}

function collectStream(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: string[] = [];
        stream.on("data", (chunk) => chunks.push(chunk.toString()));
        stream.on("end", () => resolve(chunks.join("")));
        stream.on("error", reject);
    });
}

describe("Streaming behavior for large portfolio exports", () => {
    it("streams 1000 records without loading all into memory at once", async () => {
        const records = Array.from({ length: 1000 }, (_, i) => makeRecord(i));
        const stream = createCSVStream(records);

        const chunks: string[] = [];
        let chunkCount = 0;

        for await (const chunk of stream) {
            chunks.push(chunk.toString());
            chunkCount++;
        }

        expect(chunkCount).toBeGreaterThan(1);
        const content = chunks.join("");
        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(1001);
    });

    it("streams 5000 records with header appearing in first chunk", async () => {
        const records = Array.from({ length: 5000 }, (_, i) => makeRecord(i));
        const stream = createCSVStream(records);

        const firstChunk = await new Promise<string>((resolve) => {
            stream.once("data", (chunk) => {
                resolve(chunk.toString());
                stream.destroy();
            });
        });

        expect(firstChunk).toContain("Date,Action,Asset,Amount,USD Value,TxHash");
    });

    it("streams 10000 records completely and produces correct line count", async () => {
        const records = Array.from({ length: 10000 }, (_, i) => makeRecord(i));
        const stream = createCSVStream(records);
        const content = await collectStream(stream);

        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(10001);
    });

    it("stream terminates properly after all records are emitted", async () => {
        const records = Array.from({ length: 2500 }, (_, i) => makeRecord(i));
        const stream = createCSVStream(records);

        let ended = false;
        stream.on("end", () => {
            ended = true;
        });

        const content = await collectStream(stream);
        expect(ended).toBe(true);
        expect(content.length).toBeGreaterThan(0);
    });

    it("stream handles empty records array (header only)", async () => {
        const stream = createCSVStream([]);
        const content = await collectStream(stream);

        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe("Date,Action,Asset,Amount,USD Value,TxHash");
    });

    it("stream handles single record correctly", async () => {
        const records = [makeRecord(0)];
        const stream = createCSVStream(records);
        const content = await collectStream(stream);

        const lines = content.trim().split("\n");
        expect(lines).toHaveLength(2);
    });

    it("stream batches rows in chunks of 100", async () => {
        const records = Array.from({ length: 350 }, (_, i) => makeRecord(i));
        const stream = createCSVStream(records);

        const chunkSizes: number[] = [];
        for await (const chunk of stream) {
            const lineCount = chunk.toString().split("\n").filter(Boolean).length;
            chunkSizes.push(lineCount);
        }

        expect(chunkSizes.length).toBeGreaterThanOrEqual(4);
        expect(chunkSizes[0]).toBe(1);
        expect(chunkSizes[1]).toBe(100);
    });

    it("stream content is valid CSV with correct column count per row", async () => {
        const records = Array.from({ length: 500 }, (_, i) => makeRecord(i));
        const stream = createCSVStream(records);
        const content = await collectStream(stream);

        const lines = content.trim().split("\n");
        for (const line of lines) {
            const fieldCount = line.split(",").length;
            expect(fieldCount).toBe(6);
        }
    });

    it("stream content matches generateCSV output (modulo trailing newline)", async () => {
        const records = Array.from({ length: 100 }, (_, i) => makeRecord(i));

        const csvString = generateCSV(records);
        const stream = createCSVStream(records);
        const streamedContent = await collectStream(stream);

        expect(streamedContent.trimEnd()).toBe(csvString);
    });

    it("stream handles records with special characters in fields", async () => {
        const records: TransactionRecord[] = [
            {
                date: "2025-01-01",
                action: "DEPOSIT",
                asset: "USDC,wrapped",
                amount: 100,
                usdValue: 100,
                txHash: 'tx"hash"',
            },
            {
                date: "2025-01-02",
                action: "WITHDRAW\nescaped",
                asset: "XLM",
                amount: 200,
                usdValue: 200,
                txHash: "txhash2",
            },
        ];

        const stream = createCSVStream(records);
        const content = await collectStream(stream);

        expect(content).toContain('"USDC,wrapped"');
        expect(content).toContain('"tx""hash"""');
        expect(content).toContain('"WITHDRAW\nescaped"');
    });

    it("stream handles very large USD values without scientific notation", async () => {
        const records: TransactionRecord[] = [
            {
                date: "2025-01-01",
                action: "DEPOSIT",
                asset: "USDC",
                amount: 999999999.9999999,
                usdValue: 999999999.99,
                txHash: "tx_large",
            },
        ];

        const stream = createCSVStream(records);
        const content = await collectStream(stream);

        expect(content).toContain("999999999.9999999");
        expect(content).toContain("999999999.99");
        expect(content).not.toContain("e+");
    });
});

describe("generateCSV — large dataset performance", () => {
    it("generates CSV for 1000 records inline", () => {
        const records = Array.from({ length: 1000 }, (_, i) => makeRecord(i));
        const csv = generateCSV(records);
        const lines = csv.split("\n");
        expect(lines).toHaveLength(1001);
    });

    it("generates CSV for 2000 records inline", () => {
        const records = Array.from({ length: 2000 }, (_, i) => makeRecord(i));
        const csv = generateCSV(records);
        const lines = csv.split("\n");
        expect(lines).toHaveLength(2001);
    });

    it("preserves all record data in large CSV", () => {
        const records = Array.from({ length: 500 }, (_, i) => makeRecord(i));
        const csv = generateCSV(records);

        for (let i = 0; i < records.length; i++) {
            expect(csv).toContain(records[i].txHash);
        }
    });
});
