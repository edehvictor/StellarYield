/**
 * Send Modal Component
 * Example integration of the encrypted address book with a send/transfer flow
 */

import React, { useState } from 'react';
import { X, Send, ArrowDownRight, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AddressAutocomplete, ContactsModal } from '../index';
import type { Contact, ContactSuggestion } from '../types';
import * as StellarSdk from "@stellar/stellar-sdk";
import { useWallet } from "../../../context/useWallet";
import { executeContractCallOn } from "../../../services/soroban";
import type { TxPhase } from "../../../services/transactionPhase";
import TxStatusTimeline from "../../../components/transaction/TxStatusTimeline";

interface SendModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  balance: string;
}

export function SendModal({ isOpen, onClose, walletAddress, balance }: SendModalProps) {
  const { signTransaction } = useWallet();
  const [recipientAddress, setRecipientAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [showContacts, setShowContacts] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactSuggestion | null>(null);
  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens/closes
  React.useEffect(() => {
    if (!isOpen) {
      setRecipientAddress('');
      setAmount('');
      setSelectedContact(null);
      setError(null);
      setTxPhase("idle");
    }
  }, [isOpen]);

  const handleContactSelect = (contact: ContactSuggestion) => {
    setRecipientAddress(contact.address);
    setSelectedContact(contact);
    setShowContacts(false);
  };

  const handleSavedContactSelect = (contact: Contact) => {
    const suggestion: ContactSuggestion = {
      id: contact.id,
      name: contact.name ?? 'Unnamed Contact',
      address: contact.address ?? '',
      displayText: `${contact.name ?? 'Unnamed Contact'} (${contact.address ?? ''})`,
    };
    handleContactSelect(suggestion);
  };

  const handleSend = async () => {
    if (!recipientAddress || !amount) {
      setError('Please fill in all fields');
      return;
    }

    if (!StellarSdk.StrKey.isValidEd25519PublicKey(recipientAddress)) {
      setError('Invalid recipient address format');
      return;
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setError('Amount must be greater than 0');
      return;
    }

    if (numAmount > parseFloat(balance)) {
      setError('Insufficient balance');
      return;
    }

    setError(null);
    setTxPhase("building");

    try {
      const tokenContract =
        import.meta.env.VITE_USDC_SAC_CONTRACT_ID ||
        import.meta.env.VITE_VAULT_TOKEN_CONTRACT_ID ||
        "";

      if (!tokenContract) {
        throw new Error("Token contract address is not configured");
      }

      // Convert amount to stroops (7 decimals for USDC)
      const stroopsAmount = BigInt(Math.round(numAmount * 10_000_000));

      const fromScVal = new StellarSdk.Address(walletAddress).toScVal();
      const toScVal = new StellarSdk.Address(recipientAddress).toScVal();
      const amountScVal = StellarSdk.nativeToScVal(stroopsAmount, { type: "i128" });

      const res = await executeContractCallOn(
        tokenContract,
        walletAddress,
        "transfer",
        [fromScVal, toScVal, amountScVal],
        (phase) => setTxPhase(phase),
        false,
        signTransaction
      );

      if (!res.success) {
        throw new Error(res.error || "Transaction submission failed");
      }

      setTxPhase("success");
    } catch (err) {
      setTxPhase("failure");
      setError(err instanceof Error ? err.message : 'Transaction failed');
    }
  };

  const handleMaxClick = () => {
    setAmount(balance);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-slate-900 rounded-lg w-full max-w-md mx-4 overflow-hidden border border-slate-700">
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

          {txPhase === "success" ? (
            <div className="p-8 text-center space-y-6">
              <div className="bg-green-500/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto border border-green-500/30">
                <CheckCircle2 className="text-green-500" size={32} />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold text-white">Send Successful</h3>
                <p className="text-gray-400 text-sm">
                  You successfully sent <span className="text-white font-bold">{amount} USDC</span> to{" "}
                  <span className="text-indigo-300 font-mono">
                    {recipientAddress.slice(0, 6)}...{recipientAddress.slice(-4)}
                  </span>.
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-full bg-white text-black py-3 rounded-xl font-bold uppercase text-xs hover:bg-gray-200 transition-all"
              >
                Close
              </button>
            </div>
          ) : (
            <>
              {/* Balance Display */}
              <div className="p-6 border-b border-slate-700">
                <div className="text-sm text-gray-400 mb-1">Available Balance</div>
                <div className="text-2xl font-bold text-white">{balance} USDC</div>
              </div>

              {/* Form */}
              <div className="p-6 space-y-4">
                {txPhase !== "idle" && txPhase !== "failure" ? (
                  <div className="p-4 bg-slate-800 rounded-lg">
                    <TxStatusTimeline
                      steps={[
                        "building",
                        "simulating",
                        "waiting_for_wallet",
                        "submitting",
                        "polling",
                      ]}
                      phase={txPhase}
                      errorMessage={error || undefined}
                    />
                  </div>
                ) : (
                  <>
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
                          className="w-full px-4 py-2 pr-16 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-slate-700"
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
                      <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg flex items-center gap-2 text-xs">
                        <AlertCircle className="shrink-0" size={16} />
                        <span>{error}</span>
                      </div>
                    )}

                    {/* Transaction Summary */}
                    {recipientAddress && amount && !error && (
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
                  </>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={onClose}
                    className="flex-1 px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
                    disabled={txPhase !== "idle" && txPhase !== "failure"}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSend}
                    disabled={txPhase !== "idle" && txPhase !== "failure"}
                    className="flex-1 px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <ArrowDownRight size={16} />
                    Send
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Contacts Modal */}
      <ContactsModal
        isOpen={showContacts}
        onClose={() => setShowContacts(false)}
        onSelectContact={handleSavedContactSelect}
      />
    </>
  );
}
