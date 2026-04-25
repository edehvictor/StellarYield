/**
 * Contacts Modal Component
 * Provides UI for managing encrypted contacts (add, edit, delete)
 */

import React, { useState, useEffect } from 'react';
import { X, Plus, Edit2, Trash2, Search, User, Copy, ExternalLink } from 'lucide-react';
import { useContacts } from '../hooks/useContacts';
import { Contact, ContactData } from '../types';

interface ContactsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectContact?: (contact: Contact) => void;
}

interface ContactFormData {
  name: string;
  address: string;
}

/**
 * Contacts Modal Component
 */
export function ContactsModal({ isOpen, onClose, onSelectContact }: ContactsModalProps) {
  const {
    contacts,
    filteredContacts,
    loading,
    error,
    searchQuery,
    addContact,
    editContact,
    removeContact,
    setSearchQuery,
    clearError,
    validateContactData,
    refreshContacts,
  } = useContacts();

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [formData, setFormData] = useState<ContactFormData>({ name: '', address: '' });
  const [formErrors, setFormErrors] = useState<string[]>([]);

  // Reset form when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setShowAddForm(false);
      setEditingContact(null);
      setFormData({ name: '', address: '' });
      setFormErrors([]);
      setSearchQuery('');
      clearError();
    }
  }, [isOpen, setSearchQuery, clearError]);

  // Load contacts when modal opens
  useEffect(() => {
    if (isOpen) {
      refreshContacts();
    }
  }, [isOpen, refreshContacts]);

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validation = validateContactData(formData);
    if (!validation.isValid) {
      setFormErrors(validation.errors);
      return;
    }

    try {
      if (editingContact) {
        await editContact(editingContact.id, formData);
        setEditingContact(null);
      } else {
        await addContact(formData);
        setShowAddForm(false);
      }
      
      setFormData({ name: '', address: '' });
      setFormErrors([]);
    } catch (error) {
      setFormErrors([error instanceof Error ? error.message : 'An error occurred']);
    }
  };

  /**
   * Handle edit contact
   */
  const handleEdit = (contact: Contact) => {
    // Note: This would need decryption of contact data
    // For now, using placeholder data
    setEditingContact(contact);
    setFormData({ 
      name: 'Contact Name', // Would decrypt here
      address: '0x...' // Would decrypt here
    });
    setShowAddForm(false);
  };

  /**
   * Handle delete contact
   */
  const handleDelete = async (contact: Contact) => {
    if (window.confirm('Are you sure you want to delete this contact?')) {
      try {
        await removeContact(contact.id);
      } catch (error) {
        console.error('Failed to delete contact:', error);
      }
    }
  };

  /**
   * Handle copy address to clipboard
   */
  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      // Could show toast notification here
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  };

  /**
   * Handle view on blockchain explorer
   */
  const handleViewOnExplorer = (address: string) => {
    const explorerUrl = `https://etherscan.io/address/${address}`;
    window.open(explorerUrl, '_blank');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-slate-900 rounded-lg w-full max-w-4xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-700">
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <User className="text-indigo-400" size={24} />
            Address Book
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Search and Add */}
        <div className="p-6 border-b border-slate-700">
          <div className="flex gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
              <input
                type="text"
                placeholder="Search contacts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <button
              onClick={() => {
                setShowAddForm(true);
                setEditingContact(null);
                setFormData({ name: '', address: '' });
                setFormErrors([]);
              }}
              className="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors flex items-center gap-2"
            >
              <Plus size={20} />
              Add Contact
            </button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/50 text-red-400 mx-6 mt-4 rounded-lg">
            {error}
          </div>
        )}

        {/* Form */}
        {(showAddForm || editingContact) && (
          <div className="p-6 border-b border-slate-700">
            <h3 className="text-lg font-semibold text-white mb-4">
              {editingContact ? 'Edit Contact' : 'Add New Contact'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Contact Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Enter contact name"
                  className="w-full px-4 py-2 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  maxLength={100}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Wallet Address
                </label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  placeholder="0x..."
                  className="w-full px-4 py-2 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              {formErrors.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg">
                  {formErrors.map((error, index) => (
                    <div key={index}>{error}</div>
                  ))}
                </div>
              )}
              <div className="flex gap-4">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors disabled:opacity-50"
                >
                  {loading ? 'Saving...' : (editingContact ? 'Update' : 'Add')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setEditingContact(null);
                    setFormData({ name: '', address: '' });
                    setFormErrors([]);
                  }}
                  className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Contacts List */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-center text-gray-400 py-8">
              Loading contacts...
            </div>
          ) : filteredContacts.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              {searchQuery ? 'No contacts found' : 'No contacts yet. Add your first contact!'}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredContacts.map((contact) => (
                <div
                  key={contact.id}
                  className="bg-slate-800 rounded-lg p-4 flex items-center justify-between hover:bg-slate-700 transition-colors"
                >
                  <div className="flex-1">
                    <h4 className="font-semibold text-white">
                      {/* Would decrypt name here */}
                      Contact Name
                    </h4>
                    <p className="text-sm text-gray-400 font-mono">
                      {/* Would decrypt address here */}
                      0x1234...5678
                    </p>
                    <p className="text-xs text-gray-500">
                      Added {new Date(contact.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {onSelectContact && (
                      <button
                        onClick={() => onSelectContact(contact)}
                        className="p-2 text-indigo-400 hover:bg-indigo-500/20 rounded-lg transition-colors"
                        title="Select this contact"
                      >
                        <User size={16} />
                      </button>
                    )}
                    <button
                      onClick={() => handleCopyAddress('0x...')} // Would decrypt address
                      className="p-2 text-gray-400 hover:bg-slate-600 rounded-lg transition-colors"
                      title="Copy address"
                    >
                      <Copy size={16} />
                    </button>
                    <button
                      onClick={() => handleViewOnExplorer('0x...')} // Would decrypt address
                      className="p-2 text-gray-400 hover:bg-slate-600 rounded-lg transition-colors"
                      title="View on Etherscan"
                    >
                      <ExternalLink size={16} />
                    </button>
                    <button
                      onClick={() => handleEdit(contact)}
                      className="p-2 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors"
                      title="Edit contact"
                    >
                      <Edit2 size={16} />
                    </button>
                    <button
                      onClick={() => handleDelete(contact)}
                      className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors"
                      title="Delete contact"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
