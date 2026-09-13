import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProposalAttachments from "./ProposalAttachments";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("ProposalAttachments", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("shows guidance and no rows when empty", () => {
    render(<ProposalAttachments />);
    expect(screen.getByText(/Attach the manifest, runbook, or transaction payload/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /validate attachments/i })).not.toBeInTheDocument();
  });

  it("adds an attachment row on 'Add attachment' and defaults to manifest kind", () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));
    expect(screen.getByLabelText(/attachment 1 kind/i)).toHaveValue("manifest");
  });

  it("shows a missing-manifest-reference error until the field is filled in", () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));

    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json"), {
      target: { value: "manifest.json" },
    });
    fireEvent.change(screen.getByPlaceholderText('{"version": "1.0.0", ...}'), {
      target: { value: '{"a":1}' },
    });

    expect(
      screen.getByText(/manifestReference is required/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json@<commit>"), {
      target: { value: "deployment-manifest.json@abc123" },
    });

    expect(screen.queryByText(/manifestReference is required/i)).not.toBeInTheDocument();
  });

  it("rejects a filename with path traversal characters", () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));

    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json"), {
      target: { value: "../../etc/passwd" },
    });

    expect(screen.getByText(/Filename is required/i)).toBeInTheDocument();
  });

  it("computes and displays a SHA-256 hash once content is entered", async () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));

    fireEvent.change(screen.getByPlaceholderText('{"version": "1.0.0", ...}'), {
      target: { value: '{"version":"1.0.0"}' },
    });

    await waitFor(() => {
      expect(screen.getByText(/^[a-f0-9]{64}$/)).toBeInTheDocument();
    });
  });

  it("keeps the submit button disabled while any attachment is invalid", () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));
    // No filename/manifestReference/content yet.
    expect(screen.getByRole("button", { name: /validate attachments/i })).toBeDisabled();
  });

  it("enables submit once the attachment is fully valid, then posts to the server", async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse(200, { valid: true, errors: [], attachments: [] }),
    );

    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));

    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json"), {
      target: { value: "manifest.json" },
    });
    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json@<commit>"), {
      target: { value: "deployment-manifest.json@abc123" },
    });
    fireEvent.change(screen.getByPlaceholderText('{"version": "1.0.0", ...}'), {
      target: { value: '{"version":"1.0.0"}' },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /validate attachments/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /validate attachments/i }));

    await waitFor(() => {
      expect(screen.getByText(/Attachments validated/i)).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/governance/proposals/attachments/validate"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces server-side validation errors returned on submit", async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse(400, {
        valid: false,
        errors: [{ index: 0, field: "sha256", message: "sha256 does not match the SHA-256 digest of the provided xdr." }],
      }),
    );

    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));

    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json"), {
      target: { value: "manifest.json" },
    });
    fireEvent.change(screen.getByPlaceholderText("deployment-manifest.json@<commit>"), {
      target: { value: "deployment-manifest.json@abc123" },
    });
    fireEvent.change(screen.getByPlaceholderText('{"version": "1.0.0", ...}'), {
      target: { value: '{"version":"1.0.0"}' },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /validate attachments/i })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /validate attachments/i }));

    await waitFor(() => {
      expect(screen.getByText(/Server rejected these attachments/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/does not match the SHA-256 digest/i)).toBeInTheDocument();
  });

  it("removes an attachment row", () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));
    expect(screen.getByLabelText(/attachment 1 kind/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /remove attachment 1/i }));
    expect(screen.queryByLabelText(/attachment 1 kind/i)).not.toBeInTheDocument();
  });

  it("switches accepted content by kind when selecting transaction_payload", () => {
    render(<ProposalAttachments />);
    fireEvent.click(screen.getByRole("button", { name: /add attachment/i }));

    fireEvent.change(screen.getByLabelText(/attachment 1 kind/i), {
      target: { value: "transaction_payload" },
    });

    expect(screen.getByPlaceholderText("set-keeper-fee.xdr")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("AAAAAgAAAAB...")).toBeInTheDocument();
  });
});
