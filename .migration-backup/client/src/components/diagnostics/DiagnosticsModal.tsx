import { useEffect, useRef } from "react";
import DiagnosticsPanel from "./DiagnosticsPanel";

export interface DiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DiagnosticsModal({ isOpen, onClose }: DiagnosticsModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diagnostics-modal-title"
    >
      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl animate-in zoom-in-95 duration-200">
        <DiagnosticsPanel onClose={onClose} />
      </div>
    </div>
  );
}
