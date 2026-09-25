# Encrypted Address Book

A secure, client-side encrypted address book for StellarYield users to save and manage frequently used wallet addresses.

## 🛡️ Security Features

- **Client-side encryption**: All contact names and addresses are encrypted on the client before being sent to the server
- **Zero-knowledge architecture**: The server never sees plaintext contact data
- **AES-GCM encryption**: Uses Web Crypto API with authenticated encryption
- **Wallet-derived keys**: Encryption keys are derived from the user's wallet address
- **No plaintext storage**: Only encrypted blobs are stored in the database

## 📁 Structure

```
contacts/
├── components/
│   ├── ContactsModal.tsx      # Main contacts management modal
│   └── AddressAutocomplete.tsx # Auto-complete dropdown component
├── hooks/
│   └── useContacts.ts         # React hook for contacts state management
├── utils/
│   ├── encryption.ts          # Client-side encryption utilities
│   └── api.ts                 # API service functions
├── types/
│   └── index.ts               # TypeScript type definitions
├── __tests__/
│   ├── encryption.test.ts     # Encryption utility tests
│   ├── api.test.ts            # API service tests
│   ├── ContactsModal.test.tsx # Modal component tests
│   └── AddressAutocomplete.test.tsx # Auto-complete tests
└── index.ts                   # Main exports
```

## 🚀 Usage

### Basic Setup

```tsx
import { ContactsModal, AddressAutocomplete, useContacts } from '@/features/contacts';

function YourComponent() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [recipientAddress, setRecipientAddress] = useState('');
  
  const handleContactSelect = (contact) => {
    setRecipientAddress(contact.address);
  };

  return (
    <div>
      {/* Auto-complete for address input */}
      <AddressAutocomplete
        value={recipientAddress}
        onChange={setRecipientAddress}
        onSelectContact={handleContactSelect}
        placeholder="Enter recipient address..."
      />

      {/* Button to open contacts modal */}
      <button onClick={() => setIsModalOpen(true)}>
        Open Address Book
      </button>

      {/* Contacts management modal */}
      <ContactsModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelectContact={handleContactSelect}
      />
    </div>
  );
}
```

### Advanced Usage with Custom Hooks

```tsx
import { useContacts, encryptContactData, decryptContactData } from '@/features/contacts';

function AdvancedContactsExample() {
  const {
    contacts,
    loading,
    error,
    addContact,
    editContact,
    removeContact,
    search,
    validateContactData
  } = useContacts();

  const handleAddContact = async () => {
    try {
      const contactData = {
        name: 'Alice',
        address: '0x1234567890123456789012345678901234567890'
      };

      const validation = validateContactData(contactData);
      if (!validation.isValid) {
        console.error('Validation errors:', validation.errors);
        return;
      }

      await addContact(contactData);
      console.log('Contact added successfully');
    } catch (error) {
      console.error('Failed to add contact:', error);
    }
  };

  return (
    // Your JSX here
  );
}
```

## 🔧 API Reference

### Components

#### `ContactsModal`

Main modal for managing contacts with full CRUD operations.

**Props:**
- `isOpen: boolean` - Whether the modal is open
- `onClose: () => void` - Callback when modal is closed
- `onSelectContact?: (contact: Contact) => void` - Optional callback when a contact is selected

#### `AddressAutocomplete`

Auto-complete dropdown for address inputs with contact suggestions.

**Props:**
- `value: string` - Current input value
- `onChange: (value: string) => void` - Change handler
- `onSelectContact?: (contact: ContactSuggestion) => void` - Optional selection handler
- `placeholder?: string` - Input placeholder text
- `disabled?: boolean` - Whether input is disabled
- `className?: string` - Additional CSS classes
- `showContactsButton?: boolean` - Whether to show contacts button

#### `AddressInput`

Simplified address input without auto-complete functionality.

**Props:**
- `value: string` - Current input value
- `onChange: (value: string) => void` - Change handler
- `placeholder?: string` - Input placeholder text
- `disabled?: boolean` - Whether input is disabled
- `className?: string` - Additional CSS classes

### Hooks

#### `useContacts`

Main hook for managing contacts state and operations.

**Returns:**
```typescript
{
  contacts: Contact[];
  filteredContacts: Contact[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  refreshContacts: () => Promise<void>;
  addContact: (data: ContactData) => Promise<Contact>;
  editContact: (id: string, data: Partial<ContactData>) => Promise<Contact>;
  removeContact: (id: string) => Promise<void>;
  search: (query: string) => Promise<Contact[]>;
  setSearchQuery: (query: string) => void;
  clearError: () => void;
  getSuggestions: (query: string) => Promise<ContactSuggestion[]>;
  validateContactData: (data: ContactData) => ValidationResult;
  isDuplicate: (name: string, address: string, excludeId?: string) => boolean;
}
```

### Encryption Utilities

#### `deriveEncryptionKey(walletAddress: string): Promise<CryptoKey>`

Derives an encryption key from a wallet address using PBKDF2.

#### `encryptContactData(data: ContactData, key: CryptoKey): Promise<{encryptedData: string; iv: string}>`

Encrypts contact data using AES-GCM.

#### `decryptContactData(encryptedData: string, key: CryptoKey): Promise<ContactData>`

Decrypts contact data using AES-GCM.

### API Functions

#### `getContacts(key: CryptoKey): Promise<Contact[]>`

Fetches all contacts for the authenticated user.

#### `createContact(data: ContactData, key: CryptoKey): Promise<Contact>`

Creates a new contact.

#### `updateContact(id: string, data: Partial<ContactData>, key: CryptoKey): Promise<Contact>`

Updates an existing contact.

#### `deleteContact(id: string): Promise<void>`

Deletes a contact.

#### `searchContacts(query: string, key: CryptoKey): Promise<Contact[]>`

Searches contacts (limited due to encryption).

## 🔒 Security Considerations

### Encryption Details

- **Algorithm**: AES-GCM (Galois/Counter Mode)
- **Key Length**: 256 bits
- **IV Length**: 96 bits (12 bytes)
- **Key Derivation**: PBKDF2 with 100,000 iterations
- **Encoding**: Base64 for encrypted data storage

### Threat Model

1. **Server Compromise**: Even if the server is compromised, contact data remains encrypted
2. **Database Access**: Direct database access only yields encrypted blobs
3. **Network Interception**: All data is encrypted before transmission
4. **Cross-Contamination**: Each user has unique encryption keys

### Limitations

- **Search Limitations**: Due to client-side encryption, server-side search is limited
- **Key Management**: Keys are derived from wallet addresses (consider enhancing with user passwords)
- **Backup Security**: Encrypted backups require secure key management

## 🧪 Testing

Run the test suite:

```bash
npm test contacts
```

Run with coverage:

```bash
npm run test:coverage -- contacts
```

Test files are located in `__tests__/` and cover:
- Encryption utilities (90%+ coverage required)
- API service functions
- React components
- Error handling
- Edge cases

## 🔧 Configuration

### Environment Variables

```bash
# API endpoint for contacts service
VITE_API_URL=http://localhost:3001
```

### Database Schema

The contacts table uses the following schema:

```sql
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  encrypted_name TEXT NOT NULL,
  encrypted_address TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contacts_wallet_created ON contacts(wallet_address, created_at);
CREATE UNIQUE INDEX idx_contacts_wallet_address ON contacts(wallet_address, encrypted_address);
```

## 🚀 Deployment

### Backend Requirements

1. **Database**: PostgreSQL with Prisma ORM
2. **Node.js**: Version 18 or higher
3. **Dependencies**: Express.js, Prisma Client, Zod for validation

### Frontend Requirements

1. **Browser Support**: Modern browsers with Web Crypto API support
2. **React**: Version 18 or higher
3. **TypeScript**: Version 5 or higher

### Migration Steps

1. **Database Migration**: Run Prisma migrations to add contacts table
2. **Backend Deployment**: Deploy updated server with contacts API
3. **Frontend Deployment**: Deploy updated client with contacts UI

## 📝 Future Enhancements

1. **Enhanced Key Management**: Support for user-defined passwords
2. **Contact Groups**: Organize contacts into categories
3. **Transaction History**: Associate transactions with contacts
4. **Import/Export**: Enhanced backup and restore functionality
5. **Multi-chain Support**: Support for addresses from different blockchains
6. **Contact Notes**: Add additional metadata to contacts

## 🐛 Troubleshooting

### Common Issues

1. **Encryption Key Errors**: Ensure wallet address is properly formatted
2. **API Connection Errors**: Check VITE_API_URL configuration
3. **Search Not Working**: Remember that search is limited due to encryption
4. **Browser Compatibility**: Ensure Web Crypto API is supported

### Debug Mode

Enable debug logging:

```typescript
// In development
localStorage.setItem('contacts-debug', 'true');
```

## 📄 License

This feature is part of the StellarYield project and follows the same license terms.
