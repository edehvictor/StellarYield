import { render, screen, waitFor } from '@testing-library/react';
import { ExportBundle } from './ExportBundle';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ExportBundle', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should fetch and display metadata preview', async () => {
    const mockMetadata = {
      generatedAt: new Date().toISOString(),
      appVersion: '1.0.0',
      metadata: {
        totalOpportunities: 42,
        scoringMethodology: 'Test methodology',
        sourceFreshness: 0.95,
        filtersApplied: {}
      }
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockMetadata,
    });

    render(<ExportBundle />);

    // Initially shows loading
    expect(screen.getByText(/Loading bundle details.../i)).toBeInTheDocument();

    // Eventually shows metadata
    await waitFor(() => {
      expect(screen.getByText(/v1.0.0/i)).toBeInTheDocument();
      expect(screen.getByText(/42 entries/i)).toBeInTheDocument();
      expect(screen.getByText(/95%/i)).toBeInTheDocument();
      expect(screen.getByText(/Test methodology/i)).toBeInTheDocument();
    });
  });

  it('should handle preview fetch failure gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Fetch failed'));

    render(<ExportBundle />);

    await waitFor(() => {
      expect(screen.queryByText(/Loading bundle details.../i)).not.toBeInTheDocument();
    });
    
    // Download button should still be visible
    expect(screen.getByText(/Export Snapshot/i)).toBeInTheDocument();
  });
});
