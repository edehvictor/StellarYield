import request from "supertest";
import { createApp } from "../app";

// jest.mock is hoisted above variable declarations, so we cannot reference
// external `const` variables inside the factory (temporal dead zone).
// Instead, we create the mock contact operations object inside the factory
// as a closure variable, then retrieve it via jest.requireMock below.
jest.mock("@prisma/client", () => {
  const contact = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({ contact })),
  };
});

// All PrismaClient instances share the same `contact` closure object, so we
// retrieve it once here for use in test assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PrismaClient: MockPrismaClient } = jest.requireMock("@prisma/client") as any;
const mockContact = new MockPrismaClient().contact as {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
};

const WALLET = "GTEST_WALLET_ADDRESS_12345";

const SAMPLE_CONTACT = {
  id: "contact-uuid-1",
  encryptedName: "enc_name_base64_blob",
  encryptedAddress: "enc_addr_base64_blob",
  createdAt: new Date("2024-01-15T10:00:00Z"),
  updatedAt: new Date("2024-01-15T10:00:00Z"),
};

describe("Contacts API", () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── GET /api/contacts ────────────────────────────────────────────────────

  describe("GET /api/contacts", () => {
    it("returns 401 when x-wallet-address header is missing", async () => {
      const res = await request(app).get("/api/contacts");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("WALLET_ADDRESS_REQUIRED");
    });

    it("returns 200 with contacts list for authenticated wallet", async () => {
      mockContact.findMany.mockResolvedValue([SAMPLE_CONTACT]);

      const res = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.contacts[0].id).toBe("contact-uuid-1");
      // Encrypted blobs must pass through unmodified (encryption boundary)
      expect(res.body.contacts[0].encrypted_name).toBe("enc_name_base64_blob");
      expect(res.body.contacts[0].encrypted_address).toBe("enc_addr_base64_blob");
      expect(mockContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { walletAddress: WALLET } })
      );
    });

    it("returns 200 with empty list when wallet has no contacts", async () => {
      mockContact.findMany.mockResolvedValue([]);

      const res = await request(app)
        .get("/api/contacts")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.contacts).toEqual([]);
    });
  });

  // ── GET /api/contacts/search ─────────────────────────────────────────────
  // Route is defined before /:id so Express resolves it as a static path.

  describe("GET /api/contacts/search", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app).get("/api/contacts/search?q=alice");
      expect(res.status).toBe(401);
    });

    it("returns 400 when query param is missing", async () => {
      const res = await request(app)
        .get("/api/contacts/search")
        .set("x-wallet-address", WALLET);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_QUERY");
    });

    it("returns all contacts so the client can filter after decryption", async () => {
      mockContact.findMany.mockResolvedValue([SAMPLE_CONTACT]);

      const res = await request(app)
        .get("/api/contacts/search?q=alice")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.contacts[0].encrypted_name).toBe("enc_name_base64_blob");
    });
  });

  // ── GET /api/contacts/export ─────────────────────────────────────────────

  describe("GET /api/contacts/export", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app).get("/api/contacts/export");
      expect(res.status).toBe(401);
    });

    it("returns encrypted backup blob when authenticated", async () => {
      mockContact.findMany.mockResolvedValue([SAMPLE_CONTACT]);

      const res = await request(app)
        .get("/api/contacts/export")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(200);
      expect(typeof res.body.encryptedBackup).toBe("string");

      const parsed = JSON.parse(res.body.encryptedBackup);
      expect(parsed.version).toBe("1.0");
      expect(Array.isArray(parsed.contacts)).toBe(true);
      // Encrypted fields passed through unchanged
      expect(parsed.contacts[0].encryptedName).toBe("enc_name_base64_blob");
      expect(parsed.contacts[0].encryptedAddress).toBe("enc_addr_base64_blob");
    });
  });

  // ── GET /api/contacts/:id ────────────────────────────────────────────────

  describe("GET /api/contacts/:id", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app).get("/api/contacts/contact-uuid-1");
      expect(res.status).toBe(401);
    });

    it("returns 200 with contact when found", async () => {
      mockContact.findFirst.mockResolvedValue(SAMPLE_CONTACT);

      const res = await request(app)
        .get("/api/contacts/contact-uuid-1")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(200);
      expect(res.body.contact.id).toBe("contact-uuid-1");
      expect(res.body.contact.encrypted_name).toBe("enc_name_base64_blob");
      expect(mockContact.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "contact-uuid-1", walletAddress: WALLET } })
      );
    });

    it("returns 404 when contact does not exist or belongs to another wallet", async () => {
      mockContact.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/contacts/non-existent")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTACT_NOT_FOUND");
    });
  });

  // ── POST /api/contacts ───────────────────────────────────────────────────

  describe("POST /api/contacts", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app)
        .post("/api/contacts")
        .send({ encryptedName: "enc", encryptedAddress: "addr" });
      expect(res.status).toBe(401);
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", WALLET)
        .send({ encryptedName: "enc" }); // missing encryptedAddress
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_REQUEST");
    });

    it("returns 201 with created contact on success", async () => {
      mockContact.findFirst.mockResolvedValue(null); // no duplicate
      mockContact.create.mockResolvedValue(SAMPLE_CONTACT);

      const res = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", WALLET)
        .send({ encryptedName: "enc_name_base64_blob", encryptedAddress: "enc_addr_base64_blob" });

      expect(res.status).toBe(201);
      expect(res.body.contact.id).toBe("contact-uuid-1");
      expect(res.body.contact.encrypted_name).toBe("enc_name_base64_blob");
    });

    it("returns 409 when a contact with the same encrypted address already exists", async () => {
      mockContact.findFirst.mockResolvedValue(SAMPLE_CONTACT); // duplicate

      const res = await request(app)
        .post("/api/contacts")
        .set("x-wallet-address", WALLET)
        .send({ encryptedName: "enc_name_base64_blob", encryptedAddress: "enc_addr_base64_blob" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DUPLICATE_CONTACT");
    });
  });

  // ── PUT /api/contacts/:id ────────────────────────────────────────────────

  describe("PUT /api/contacts/:id", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app)
        .put("/api/contacts/contact-uuid-1")
        .send({ encryptedName: "new_name" });
      expect(res.status).toBe(401);
    });

    it("returns 404 when contact does not exist", async () => {
      mockContact.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .put("/api/contacts/non-existent")
        .set("x-wallet-address", WALLET)
        .send({ encryptedName: "new_name" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTACT_NOT_FOUND");
    });

    it("returns 200 with updated contact on success", async () => {
      mockContact.findFirst.mockResolvedValue(SAMPLE_CONTACT);
      mockContact.update.mockResolvedValue({
        ...SAMPLE_CONTACT,
        encryptedName: "updated_name",
      });

      const res = await request(app)
        .put("/api/contacts/contact-uuid-1")
        .set("x-wallet-address", WALLET)
        .send({ encryptedName: "updated_name" });

      expect(res.status).toBe(200);
      expect(res.body.contact.encrypted_name).toBe("updated_name");
    });
  });

  // ── DELETE /api/contacts/:id ─────────────────────────────────────────────

  describe("DELETE /api/contacts/:id", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app).delete("/api/contacts/contact-uuid-1");
      expect(res.status).toBe(401);
    });

    it("returns 404 when contact does not exist", async () => {
      mockContact.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .delete("/api/contacts/non-existent")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("CONTACT_NOT_FOUND");
    });

    it("returns 204 on successful deletion", async () => {
      mockContact.findFirst.mockResolvedValue(SAMPLE_CONTACT);
      mockContact.delete.mockResolvedValue(SAMPLE_CONTACT);

      const res = await request(app)
        .delete("/api/contacts/contact-uuid-1")
        .set("x-wallet-address", WALLET);

      expect(res.status).toBe(204);
      expect(mockContact.delete).toHaveBeenCalledWith({ where: { id: "contact-uuid-1" } });
    });
  });

  // ── POST /api/contacts/import ────────────────────────────────────────────

  describe("POST /api/contacts/import", () => {
    it("returns 401 when header is missing", async () => {
      const res = await request(app)
        .post("/api/contacts/import")
        .send({ encryptedBackup: JSON.stringify({ contacts: [] }) });
      expect(res.status).toBe(401);
    });

    it("returns 400 when encryptedBackup is missing", async () => {
      const res = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", WALLET)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_BACKUP");
    });

    it("returns 400 when backup format is invalid (no contacts array)", async () => {
      const res = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", WALLET)
        .send({ encryptedBackup: JSON.stringify({ version: "1.0" }) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_FORMAT");
    });

    it("imports new contacts and returns 200 with the created list", async () => {
      mockContact.findFirst.mockResolvedValue(null); // no duplicate
      mockContact.create.mockResolvedValue(SAMPLE_CONTACT);

      const backup = JSON.stringify({
        version: "1.0",
        contacts: [
          { encryptedName: "enc_name_base64_blob", encryptedAddress: "enc_addr_base64_blob" },
        ],
      });

      const res = await request(app)
        .post("/api/contacts/import")
        .set("x-wallet-address", WALLET)
        .send({ encryptedBackup: backup });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.contacts[0].encrypted_name).toBe("enc_name_base64_blob");
    });
  });
});
