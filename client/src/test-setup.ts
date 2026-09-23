import React from 'react';
import '@testing-library/jest-dom';
import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

if (typeof globalThis !== 'undefined' && !(globalThis as any).React) {
  (globalThis as any).React = React;
}

// Extend vitest's expect with jest-dom matchers so tests can use
// expect(el).toBeInTheDocument(), .toHaveTextContent(), etc.
expect.extend(matchers);
