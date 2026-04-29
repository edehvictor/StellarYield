/**
 * Send Modal Component
 * Example integration of the encrypted address book with a send/transfer flow
 */

import React, { useState } from 'react';
import { X, Send, ArrowDownRight } from 'lucide-react';
import { AddressAutocomplete, ContactsModal } from '../index';
import { ContactSuggestion } from '../types';

interface SendModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  balance: string;
}

/**
 * Send Modal Component - Example integration
 */
export function SendModal({ isOpen, onClose, walletAddress, balance }: SendModalProps) {
  const [recipientAddress, setRecipientAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [showContacts, setShowContacts] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactSuggestion | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens/closes
  React.useEffect(() => {
    if (!isOpen) {
      setRecipientAddress('');
      setAmount('');
      setSelectedContact(null);
      setError(null);
    }
  }, [isOpen]);

  /**
   * Handle contact selection from address book
   */
  const handleContactSelect = (contact: ContactSuggestion) => {
    setRecipientAddress(contact.address);
    setSelectedContact(contact);
    setShowContacts(false);
  };

  /**
   * Handle send transaction
   */
  const handleSend = async () => {
    if (!recipientAddress || !amount) {
      setError('Please fill in all fields');
      return;
    }

    if (parseFloat(amount) <= 0) {
      setError('Amount must be greater than 0');
      return;
    }

    if (parseFloat(amount) > parseFloat(balance)) {
      setError('Insufficient balance');
      return;
    }

    setIsSending(true);
    setError(null);

    try {
      // Simulate transaction processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // In a real implementation, this would integrate with the actual transaction service
      console.log('Sending transaction:', {
        from: walletAddress,
        to: recipientAddress,
        amount,
        contact: selectedContact,
      });

      // Close modal on success
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setIsSending(false);
    }
  };

  /**
   * Handle max amount click
   */
  const handleMaxClick = () => {
    setAmount(balance);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-slate-900 rounded-lg w-full max-w-md mx-4">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-slate-700">
            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
              <Send className="text-indigo-400" size={24} />
              Send
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-gray-400 hover:text-white transition-colors"
            >
              <X size={24} />
            </button>
          </div>

          {/* Balance Display */}
          <div className="p-6 border-b border-slate-700">
            <div className="text-sm text-gray-400 mb-1">Available Balance</div>
            <div className="text-2xl font-bold text-white">{balance} USDC</div>
          </div>

          {/* Form */}
          <div className="p-6 space-y-4">
            {/* Recipient Address with Auto-complete */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Recipient Address
              </label>
              <div className="relative">
                <AddressAutocomplete
                  value={recipientAddress}
                  onChange={setRecipientAddress}
                  onSelectContact={handleContactSelect}
                  placeholder="Enter recipient address or search contacts..."
                  className="w-full"
                />
              </div>
              {selectedContact && (
                <div className="mt-2 text-sm text-green-400 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Sending to {selectedContact.name}
                </div>
              )}
            </div>

            {/* Amount */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Amount (USDC)
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-4 py-2 pr-16 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  min="0"
                  step="0.01"
                />
                <button
                  type="button"
                  onClick={handleMaxClick}
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 px-2 py-1 text-xs bg-indigo-500 text-white rounded hover:bg-indigo-600 transition-colors"
                >
                  MAX
                </button>
              </div>
            </div>

            {/* Error Display */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg">
                {error}
              </div>
            )}

            {/* Transaction Summary */}
            {recipientAddress && amount && (
              <div className="bg-slate-800 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">To:</span>
                  <span className="text-white font-mono">
                    {recipientAddress.slice(0, 6)}...{recipientAddress.slice(-4)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">Amount:</span>
                  <span className="text-white font-semibold">{amount} USDC</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">Network Fee:</span>
                  <span className="text-white">~0.001 USDC</span>
                </div>
                <div className="border-t border-slate-700 pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-300">Total:</span>
                    <span className="text-white font-bold">
                      {(parseFloat(amount) + 0.001).toFixed(3)} USDC
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                disabled={isSending}
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={isSending}
                className="flex-1 px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isSending ? (
                  <>
                    <div className="animate-spin">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                    Sending...
                  </>
                ) : (
                  <>
                    <ArrowDownRight size={16} />
                    Send
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Contacts Modal */}
      <ContactsModal
        isOpen={showContacts}
        onClose={() => setShowContacts(false)}
        onSelectContact={handleContactSelect}
      />
    </>
  );
}
