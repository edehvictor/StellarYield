/**
 * Settings modal — slippage tolerance + transaction deadline.
 * Accessible via the gear icon in the navigation bar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, RotateCcw, AlertTriangle } from "lucide-react";
import { useSettings } from "./SettingsContext";
import {
  AUTO_SLIPPAGE_PRESETS,
  SLIPPAGE_MAX,
  SLIPPAGE_MIN,
  DEADLINE_MAX,
  DEADLINE_MIN,
} from "./types";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { settings, updateSettings, resetSettings } = useSettings();
  const [customInput, setCustomInput] = useState(String(settings.customSlippagePct));
  const [deadlineInput, setDeadlineInput] = useState(String(settings.deadlineMinutes));
  const [customError, setCustomError] = useState("");
  const [deadlineError, setDeadlineError] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);

  // Sync inputs when settings change externally (e.g. reset)
  useEffect(() => {
    setCustomInput(String(settings.customSlippagePct));
    setDeadlineInput(String(settings.deadlineMinutes));
    setCustomError("");
    setDeadlineError("");
  }, [settings.customSlippagePct, settings.deadlineMinutes]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handleCustomSlippageChange = useCallback(
    (raw: string) => {
      setCustomInput(raw);
      const val = parseFloat(raw);
      if (isNaN(val) || raw.trim() === "") {
        setCustomError("Enter a valid number");
        return;
      }
      if (val < SLIPPAGE_MIN) {
        setCustomError(`Minimum is ${SLIPPAGE_MIN}%`);
        return;
      }
      if (val > SLIPPAGE_MAX) {
        setCustomError(`Maximum is ${SLIPPAGE_MAX}% to protect your transaction`);
        return;
      }
      setCustomError("");
      updateSettings({ customSlippagePct: val });
    },
    [updateSettings],
  );

  const handleDeadlineChange = useCallback(
    (raw: string) => {
      setDeadlineInput(raw);
      const val = parseInt(raw, 10);
      if (isNaN(val) || raw.trim() === "") {
        setDeadlineError("Enter a valid number");
        return;
      }
      if (val < DEADLINE_MIN) {
        setDeadlineError(`Minimum is ${DEADLINE_MIN} minute`);
        return;
      }
      if (val > DEADLINE_MAX) {
        setDeadlineError(`Maximum is ${DEADLINE_MAX} minutes`);
        return;
      }
      setDeadlineError("");
      updateSettings({ deadlineMinutes: val });
    },
    [updateSettings],
  );

  const handleReset = useCallback(() => {
    resetSettings();
  }, [resetSettings]);

  if (!isOpen) return null;

  const isHighSlippage =
    settings.slippageMode === "custom" && settings.customSlippagePct > 1.0;

  return (
    /* Backdrop */
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Transaction settings"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="glass-panel w-full max-w-sm mx-4 p-6 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-white">Transaction settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-gray-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Slippage tolerance ── */}
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-300">Slippage tolerance</span>
            <span className="text-xs text-gray-500">Max {SLIPPAGE_MAX}%</span>
          </div>

          {/* Auto / Custom toggle */}
          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={() => updateSettings({ slippageMode: "auto" })}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${
                settings.slippageMode === "auto"
                  ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30"
                  : "bg-white/10 text-gray-400 hover:bg-white/20"
              }`}
            >
              Auto
            </button>
            <button
              type="button"
              onClick={() => updateSettings({ slippageMode: "custom" })}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${
                settings.slippageMode === "custom"
                  ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30"
                  : "bg-white/10 text-gray-400 hover:bg-white/20"
              }`}
            >
              Custom
            </button>
          </div>

          {/* Auto presets */}
          {settings.slippageMode === "auto" && (
            <div className="flex gap-2">
              {AUTO_SLIPPAGE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled
                  className="flex-1 py-1.5 rounded-lg text-sm bg-white/5 text-gray-500 cursor-default"
                >
                  {p}%
                </button>
              ))}
            </div>
          )}

          {/* Custom input */}
          {settings.slippageMode === "custom" && (
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min={SLIPPAGE_MIN}
                  max={SLIPPAGE_MAX}
                  step={0.01}
                  value={customInput}
                  onChange={(e) => handleCustomSlippageChange(e.target.value)}
                  aria-label="Custom slippage percentage"
                  className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
                />
                <span className="text-gray-400 text-sm">%</span>
              </div>
              {customError && (
                <p role="alert" className="text-red-400 text-xs mt-1 flex items-center gap-1">
                  <AlertTriangle size={12} /> {customError}
                </p>
              )}
              {isHighSlippage && !customError && (
                <p role="alert" className="text-amber-400 text-xs mt-1 flex items-center gap-1">
                  <AlertTriangle size={12} /> High slippage — your transaction may be front-run
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Transaction deadline ── */}
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-300">Transaction deadline</span>
            <span className="text-xs text-gray-500">
              {DEADLINE_MIN}–{DEADLINE_MAX} min
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={DEADLINE_MIN}
              max={DEADLINE_MAX}
              step={1}
              value={deadlineInput}
              onChange={(e) => handleDeadlineChange(e.target.value)}
              aria-label="Transaction deadline in minutes"
              className="flex-1 bg-white/10 text-white rounded-xl px-3 py-2 text-sm border border-white/10 focus:border-indigo-400 outline-none"
            />
            <span className="text-gray-400 text-sm">min</span>
          </div>
          {deadlineError && (
            <p role="alert" className="text-red-400 text-xs mt-1 flex items-center gap-1">
              <AlertTriangle size={12} /> {deadlineError}
            </p>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Transaction will revert if not confirmed within this window.
          </p>
        </section>

        {/* Reset */}
        <button
          type="button"
          onClick={handleReset}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-sm transition-colors"
        >
          <RotateCcw size={14} /> Reset to defaults
        </button>
      </div>
    </div>
  );
}
