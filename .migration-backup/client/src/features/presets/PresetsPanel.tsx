import React, { useEffect, useState, useCallback } from "react";
import { BookMarked, Plus, Trash2, Edit3, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { listPresets, createPreset, updatePreset, deletePreset } from "./presetsApi";
import type { AllocationPreset, PresetAllocation } from "./types";

interface PresetsPanelProps {
  walletAddress: string;
  onApply?: (preset: AllocationPreset) => void;
}

const SUPPORTED_VAULTS: { id: string; name: string }[] = [
  { id: "blend", name: "Blend" },
  { id: "soroswap", name: "Soroswap" },
  { id: "defindex", name: "DeFindex" },
];

function emptyAllocations(): PresetAllocation[] {
  return [{ vaultId: "blend", vaultName: "Blend", percentage: 100 }];
}

const PresetsPanel: React.FC<PresetsPanelProps> = ({ walletAddress, onApply }) => {
  const [presets, setPresets] = useState<AllocationPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formAllocations, setFormAllocations] = useState<PresetAllocation[]>(emptyAllocations);
  const [formError, setFormError] = useState("");

  const loadPresets = useCallback(async () => {
    setLoading(true);
    try {
      setPresets(await listPresets(walletAddress));
    } catch {
      setError("Failed to load presets");
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  function openNewForm() {
    setEditingId(null);
    setFormName("");
    setFormAllocations(emptyAllocations());
    setFormError("");
    setShowForm(true);
  }

  function openEditForm(preset: AllocationPreset) {
    setEditingId(preset.id);
    setFormName(preset.name);
    setFormAllocations([...preset.allocations]);
    setFormError("");
    setShowForm(true);
  }

  function updateAllocationPct(index: number, pct: number) {
    setFormAllocations((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], percentage: pct };
      return next;
    });
  }

  function updateAllocationVault(index: number, vaultId: string) {
    const vault = SUPPORTED_VAULTS.find((v) => v.id === vaultId);
    if (!vault) return;
    setFormAllocations((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], vaultId: vault.id, vaultName: vault.name };
      return next;
    });
  }

  function addAllocationRow() {
    const used = formAllocations.map((a) => a.vaultId);
    const available = SUPPORTED_VAULTS.find((v) => !used.includes(v.id));
    if (!available) return;
    setFormAllocations((prev) => [
      ...prev,
      { vaultId: available.id, vaultName: available.name, percentage: 0 },
    ]);
  }

  function removeAllocationRow(index: number) {
    setFormAllocations((prev) => prev.filter((_, i) => i !== index));
  }

  const totalPct = formAllocations.reduce((s, a) => s + a.percentage, 0);

  async function handleSubmit() {
    setFormError("");
    try {
      if (editingId) {
        const updated = await updatePreset(walletAddress, editingId, formName, formAllocations);
        setPresets((prev) => prev.map((p) => (p.id === editingId ? updated : p)));
      } else {
        const created = await createPreset(walletAddress, formName, formAllocations);
        setPresets((prev) => [...prev, created]);
      }
      setShowForm(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deletePreset(walletAddress, id);
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setError("Failed to delete preset");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookMarked size={20} className="text-indigo-400" />
          <h3 className="text-lg font-semibold">Allocation Presets</h3>
        </div>
        <button
          onClick={openNewForm}
          className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg text-sm font-semibold transition-colors"
        >
          <Plus size={14} /> New Preset
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-6">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500" />
        </div>
      ) : presets.length === 0 ? (
        <p className="text-gray-500 text-sm py-4 text-center">No presets saved. Create one to speed up vault setup.</p>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => (
            <div
              key={preset.id}
              className="glass-card p-4 flex items-center justify-between hover:bg-white/5 transition-colors"
            >
              <div>
                <p className="font-semibold text-white">{preset.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {preset.allocations.map((a) => `${a.vaultName} ${a.percentage}%`).join(" · ")}
                </p>
              </div>
              <div className="flex gap-2">
                {onApply && (
                  <button
                    onClick={() => onApply(preset)}
                    className="flex items-center gap-1 px-2 py-1 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded text-xs font-semibold transition-colors"
                  >
                    <CheckCircle2 size={12} /> Apply
                  </button>
                )}
                <button
                  onClick={() => openEditForm(preset)}
                  className="p-1 hover:bg-white/10 text-gray-400 hover:text-white rounded transition-colors"
                >
                  <Edit3 size={14} />
                </button>
                <button
                  onClick={() => handleDelete(preset.id)}
                  className="p-1 hover:bg-red-500/10 text-gray-400 hover:text-red-400 rounded transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Form */}
      {showForm && (
        <div className="glass-card p-5 space-y-4 border border-indigo-500/20">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold">{editingId ? "Edit Preset" : "New Preset"}</h4>
            <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-white">
              <X size={16} />
            </button>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Preset Name</label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Conservative Mix"
              className="w-full bg-black/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-400 uppercase tracking-widest">Allocations</label>
              <span className={`text-xs font-semibold ${Math.abs(totalPct - 100) < 0.01 ? "text-green-400" : "text-yellow-400"}`}>
                {totalPct.toFixed(1)}% / 100%
              </span>
            </div>
            {formAllocations.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={a.vaultId}
                  onChange={(e) => updateAllocationVault(i, e.target.value)}
                  className="flex-1 bg-black/50 border border-gray-600 rounded px-2 py-1.5 text-white text-sm"
                >
                  {SUPPORTED_VAULTS.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={a.percentage}
                  onChange={(e) => updateAllocationPct(i, parseFloat(e.target.value) || 0)}
                  className="w-20 bg-black/50 border border-gray-600 rounded px-2 py-1.5 text-white text-sm"
                />
                <span className="text-gray-400 text-sm">%</span>
                {formAllocations.length > 1 && (
                  <button onClick={() => removeAllocationRow(i)} className="text-gray-500 hover:text-red-400 transition-colors">
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            {formAllocations.length < SUPPORTED_VAULTS.length && (
              <button
                onClick={addAllocationRow}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
              >
                <Plus size={12} /> Add vault
              </button>
            )}
          </div>

          {formError && (
            <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
              <AlertTriangle size={12} /> {formError}
            </div>
          )}

          <button
            onClick={handleSubmit}
            className="w-full bg-indigo-500 hover:bg-indigo-400 text-white font-semibold py-2 rounded-lg text-sm transition-colors"
          >
            {editingId ? "Save Changes" : "Create Preset"}
          </button>
        </div>
      )}
    </div>
  );
};

export default PresetsPanel;
