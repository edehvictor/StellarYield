import '@testing-library/jest-dom';
import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extend vitest's expect with jest-dom matchers so tests can use
// expect(el).toBeInTheDocument(), .toHaveTextContent(), etc.
expect.extend(matchers);
