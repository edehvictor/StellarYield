/**
 * Contacts API Routes
 * Provides CRUD operations for encrypted contacts
 * 
 * Security Note: All contact data is encrypted on the client side.
 * The server only stores encrypted blobs and cannot access plaintext data.
 */

import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const router = Router();
const prisma = new PrismaClient();

// Validation schemas
const createContactSchema = z.object({
  encryptedName: z.string().min(1, "Encrypted name is required"),
  encryptedAddress: z.string().min(1, "Encrypted address is required"),
});

const updateContactSchema = z.object({
  encryptedName: z.string().min(1, "Encrypted name is required").optional(),
  encryptedAddress: z.string().min(1, "Encrypted address is required").optional(),
});

// Middleware to extract wallet address from authenticated user
const getWalletAddress = (req: Request): string => {
  // In a real implementation, this would extract from JWT token or session
  // For now, we'll use a header or param
  return (req.headers['x-wallet-address'] as string) || 
         (req.params.walletAddress as string) || 
         req.body?.walletAddress;
};

/**
 * GET /api/contacts
 * Fetch all contacts for the authenticated user
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const walletAddress = getWalletAddress(req);
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    const contacts = await prisma.contact.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        encryptedName: true,
        encryptedAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      contacts: contacts.map(contact => ({
        id: contact.id,
        encrypted_name: contact.encryptedName,
        encrypted_address: contact.encryptedAddress,
        created_at: contact.createdAt.toISOString(),
        updated_at: contact.updatedAt.toISOString(),
      })),
      total: contacts.length,
    });
  } catch (error) {
    console.error("Failed to fetch contacts:", error);
    res.status(500).json({ 
      error: "Failed to fetch contacts",
      code: "FETCH_FAILED"
    });
  }
});

/**
 * GET /api/contacts/:id
 * Fetch a single contact by ID
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const walletAddress = getWalletAddress(req);
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    const contact = await prisma.contact.findFirst({
      where: { 
        id,
        walletAddress, // Ensure user can only access their own contacts
      },
      select: {
        id: true,
        encryptedName: true,
        encryptedAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!contact) {
      return res.status(404).json({ 
        error: "Contact not found",
        code: "CONTACT_NOT_FOUND"
      });
    }

    res.json({
      contact: {
        id: contact.id,
        encrypted_name: contact.encryptedName,
        encrypted_address: contact.encryptedAddress,
        created_at: contact.createdAt.toISOString(),
        updated_at: contact.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to fetch contact:", error);
    res.status(500).json({ 
      error: "Failed to fetch contact",
      code: "FETCH_FAILED"
    });
  }
});

/**
 * POST /api/contacts
 * Create a new contact
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const walletAddress = getWalletAddress(req);
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    const validation = createContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Invalid request body",
        code: "INVALID_REQUEST",
        details: validation.error.errors
      });
    }

    const { encryptedName, encryptedAddress } = validation.data;

    // Check for duplicate address (encrypted uniqueness is handled by DB constraint)
    const existingContact = await prisma.contact.findFirst({
      where: {
        walletAddress,
        encryptedAddress,
      },
    });

    if (existingContact) {
      return res.status(409).json({ 
        error: "Contact with this address already exists",
        code: "DUPLICATE_CONTACT"
      });
    }

    const contact = await prisma.contact.create({
      data: {
        walletAddress,
        encryptedName,
        encryptedAddress,
      },
      select: {
        id: true,
        encryptedName: true,
        encryptedAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json({
      contact: {
        id: contact.id,
        encrypted_name: contact.encryptedName,
        encrypted_address: contact.encryptedAddress,
        created_at: contact.createdAt.toISOString(),
        updated_at: contact.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to create contact:", error);
    
    // Handle unique constraint violation
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return res.status(409).json({ 
        error: "Contact with this address already exists",
        code: "DUPLICATE_CONTACT"
      });
    }

    res.status(500).json({ 
      error: "Failed to create contact",
      code: "CREATE_FAILED"
    });
  }
});

/**
 * PUT /api/contacts/:id
 * Update an existing contact
 */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const walletAddress = getWalletAddress(req);
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    const validation = updateContactSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Invalid request body",
        code: "INVALID_REQUEST",
        details: validation.error.errors
      });
    }

    // Check if contact exists and belongs to user
    const existingContact = await prisma.contact.findFirst({
      where: { id, walletAddress },
    });

    if (!existingContact) {
      return res.status(404).json({ 
        error: "Contact not found",
        code: "CONTACT_NOT_FOUND"
      });
    }

    const { encryptedName, encryptedAddress } = validation.data;

    // If updating address, check for duplicates
    if (encryptedAddress && encryptedAddress !== existingContact.encryptedAddress) {
      const duplicateContact = await prisma.contact.findFirst({
        where: {
          walletAddress,
          encryptedAddress,
          id: { not: id }, // Exclude current contact
        },
      });

      if (duplicateContact) {
        return res.status(409).json({ 
          error: "Contact with this address already exists",
          code: "DUPLICATE_CONTACT"
        });
      }
    }

    const updateData: { encryptedName?: string; encryptedAddress?: string } = {};
    if (encryptedName) updateData.encryptedName = encryptedName;
    if (encryptedAddress) updateData.encryptedAddress = encryptedAddress;

    const contact = await prisma.contact.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        encryptedName: true,
        encryptedAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      contact: {
        id: contact.id,
        encrypted_name: contact.encryptedName,
        encrypted_address: contact.encryptedAddress,
        created_at: contact.createdAt.toISOString(),
        updated_at: contact.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to update contact:", error);
    
    // Handle unique constraint violation
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return res.status(409).json({ 
        error: "Contact with this address already exists",
        code: "DUPLICATE_CONTACT"
      });
    }

    res.status(500).json({ 
      error: "Failed to update contact",
      code: "UPDATE_FAILED"
    });
  }
});

/**
 * DELETE /api/contacts/:id
 * Delete a contact
 */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const walletAddress = getWalletAddress(req);
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    // Check if contact exists and belongs to user
    const existingContact = await prisma.contact.findFirst({
      where: { id, walletAddress },
    });

    if (!existingContact) {
      return res.status(404).json({ 
        error: "Contact not found",
        code: "CONTACT_NOT_FOUND"
      });
    }

    await prisma.contact.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete contact:", error);
    res.status(500).json({ 
      error: "Failed to delete contact",
      code: "DELETE_FAILED"
    });
  }
});

/**
 * GET /api/contacts/search
 * Search contacts (limited implementation since data is encrypted)
 */
router.get("/search", async (req: Request, res: Response) => {
  try {
    const walletAddress = getWalletAddress(req);
    const { q } = req.query;
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ 
        error: "Search query is required",
        code: "INVALID_QUERY"
      });
    }

    // Since data is encrypted, we can't search by content
    // We'll return all contacts and let the client filter after decryption
    const contacts = await prisma.contact.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        encryptedName: true,
        encryptedAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      contacts: contacts.map(contact => ({
        id: contact.id,
        encrypted_name: contact.encryptedName,
        encrypted_address: contact.encryptedAddress,
        created_at: contact.createdAt.toISOString(),
        updated_at: contact.updatedAt.toISOString(),
      })),
      total: contacts.length,
    });
  } catch (error) {
    console.error("Failed to search contacts:", error);
    res.status(500).json({ 
      error: "Failed to search contacts",
      code: "SEARCH_FAILED"
    });
  }
});

/**
 * GET /api/contacts/export
 * Export all contacts as encrypted backup
 */
router.get("/export", async (req: Request, res: Response) => {
  try {
    const walletAddress = getWalletAddress(req);
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    const contacts = await prisma.contact.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
    });

    // Create encrypted backup (client will handle the actual encryption)
    const backupData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      contacts: contacts.map(contact => ({
        id: contact.id,
        encryptedName: contact.encryptedName,
        encryptedAddress: contact.encryptedAddress,
        createdAt: contact.createdAt.toISOString(),
        updatedAt: contact.updatedAt.toISOString(),
      })),
    };

    // In a real implementation, this would be encrypted on the client side
    // For now, we'll return the data as-is
    res.json({
      encryptedBackup: JSON.stringify(backupData),
    });
  } catch (error) {
    console.error("Failed to export contacts:", error);
    res.status(500).json({ 
      error: "Failed to export contacts",
      code: "EXPORT_FAILED"
    });
  }
});

/**
 * POST /api/contacts/import
 * Import contacts from encrypted backup
 */
router.post("/import", async (req: Request, res: Response) => {
  try {
    const walletAddress = getWalletAddress(req);
    const { encryptedBackup } = req.body;
    
    if (!walletAddress) {
      return res.status(401).json({ 
        error: "Wallet address required",
        code: "WALLET_ADDRESS_REQUIRED"
      });
    }

    if (!encryptedBackup) {
      return res.status(400).json({ 
        error: "Encrypted backup is required",
        code: "INVALID_BACKUP"
      });
    }

    // In a real implementation, the client would decrypt this data
    // For now, we'll parse it as JSON
    const backupData = JSON.parse(encryptedBackup);
    
    if (!backupData.contacts || !Array.isArray(backupData.contacts)) {
      return res.status(400).json({ 
        error: "Invalid backup format",
        code: "INVALID_FORMAT"
      });
    }

    const importedContacts = [];
    
    for (const contactData of backupData.contacts) {
      try {
        // Check for duplicates
        const existingContact = await prisma.contact.findFirst({
          where: {
            walletAddress,
            encryptedAddress: contactData.encryptedAddress,
          },
        });

        if (!existingContact) {
          const contact = await prisma.contact.create({
            data: {
              walletAddress,
              encryptedName: contactData.encryptedName,
              encryptedAddress: contactData.encryptedAddress,
            },
            select: {
              id: true,
              encryptedName: true,
              encryptedAddress: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          importedContacts.push({
            id: contact.id,
            encrypted_name: contact.encryptedName,
            encrypted_address: contact.encryptedAddress,
            created_at: contact.createdAt.toISOString(),
            updated_at: contact.updatedAt.toISOString(),
          });
        }
      } catch (error) {
        console.error("Failed to import contact:", error);
        // Continue with other contacts
      }
    }

    res.json({
      contacts: importedContacts,
      total: importedContacts.length,
    });
  } catch (error) {
    console.error("Failed to import contacts:", error);
    res.status(500).json({ 
      error: "Failed to import contacts",
      code: "IMPORT_FAILED"
    });
  }
});

export default router;
