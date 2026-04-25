/**
 * Address Autocomplete Component
 * Provides auto-complete suggestions for recipient addresses from the user's address book
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, User, ChevronDown } from 'lucide-react';
import { useContacts } from '../hooks/useContacts';
import type { ContactSuggestion } from '../types';

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelectContact?: (contact: ContactSuggestion) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  showContactsButton?: boolean;
}

/**
 * Address Autocomplete Component
 */
export function AddressAutocomplete({
  value,
  onChange,
  onSelectContact,
  placeholder = "Enter recipient address or search contacts...",
  disabled = false,
  className = "",
  showContactsButton = true,
}: AddressAutocompleteProps) {
  const {
    getSuggestions,
  } = useContacts();

  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * Handle input change
   */
  const handleInputChange = useCallback(async (inputValue: string) => {
    onChange(inputValue);

    if (inputValue.length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsSearching(true);
    setIsOpen(true); // Open dropdown immediately to show loading state
    try {
      const results = await getSuggestions(inputValue);
      setSuggestions(results);
      setIsOpen(true); // Always open dropdown when we have a query ≥ 2 chars
      setHighlightedIndex(-1);
    } catch (error) {
      console.error('Failed to get suggestions:', error);
      setSuggestions([]);
      setIsOpen(false);
    } finally {
      setIsSearching(false);
    }
  }, [onChange, getSuggestions]);

  /**
   * Handle keyboard navigation
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => 
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => 
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
          handleSelectSuggestion(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setHighlightedIndex(-1);
        inputRef.current?.focus();
        break;
    }
  }, [isOpen, suggestions, highlightedIndex]);

  /**
   * Handle suggestion selection
   */
  const handleSelectSuggestion = useCallback((suggestion: ContactSuggestion) => {
    onChange(suggestion.address);
    setIsOpen(false);
    setHighlightedIndex(-1);
    onSelectContact?.(suggestion);
  }, [onChange, onSelectContact]);

  /**
   * Handle clicks outside dropdown
   */
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !inputRef.current?.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Handle contacts button click
   */
  const handleContactsClick = useCallback(() => {
    // This would open the contacts modal
    // Implementation depends on how the modal is managed
    console.log('Open contacts modal');
  }, []);

  return (
    <div className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) {
              setIsOpen(true);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-full px-4 py-2 pr-20 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed ${
            isOpen ? 'ring-2 ring-indigo-500' : ''
          }`}
        />
        
        {/* Input icons */}
        <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-1">
          {isSearching && (
            <div className="animate-spin">
              <Search size={16} className="text-gray-400" />
            </div>
          )}
          {showContactsButton && (
            <button
              type="button"
              onClick={handleContactsClick}
              className="p-1 text-gray-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
              title="Open address book"
            >
              <User size={16} />
            </button>
          )}
          <ChevronDown
            size={16}
            className={`text-gray-400 transition-transform ${
              isOpen ? 'transform rotate-180' : ''
            }`}
          />
        </div>
      </div>

      {/* Dropdown suggestions */}
      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto"
        >
          {isSearching && (
            <div className="px-4 py-3 text-gray-400 text-center" data-testid="searching-indicator">
              Searching...
            </div>
          )}
          {!isSearching && suggestions.length === 0 && (
            <div className="px-4 py-3 text-gray-400 text-center">
              No contacts found
            </div>
          )}
          {!isSearching && suggestions.map((suggestion, index) => (
            <div
              key={suggestion.id}
              className={`px-4 py-3 cursor-pointer transition-colors ${
                index === highlightedIndex
                  ? 'bg-indigo-500/20 text-white'
                  : 'text-gray-300 hover:bg-slate-700'
              }`}
              onClick={() => handleSelectSuggestion(suggestion)}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white truncate">
                    {suggestion.name}
                  </div>
                  <div className="text-sm text-gray-400 font-mono truncate">
                    {suggestion.address}
                  </div>
                </div>
                <User size={16} className="text-gray-400 ml-2 flex-shrink-0" />
              </div>
            </div>
          ))}
          
          {/* Show contacts count */}
          {!isSearching && suggestions.length > 0 && (
            <div className="px-4 py-2 text-xs text-gray-500 border-t border-slate-700">
              {suggestions.length} contact{suggestions.length !== 1 ? 's' : ''} found
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Simplified version for forms without contacts integration
 */
export function AddressInput({
  value,
  onChange,
  placeholder = "Enter recipient address...",
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-4 py-2 bg-slate-800 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}
