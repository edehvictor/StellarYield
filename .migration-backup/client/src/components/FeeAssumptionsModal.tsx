import React from "react";
import { X, HelpCircle, AlertTriangle } from "lucide-react";

interface FeeAssumptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FeeAssumptionsModal: React.FC<FeeAssumptionsModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative glass-panel max-w-lg w-full p-6 border border-white/10 shadow-2xl overflow-y-auto max-h-[90vh] bg-[#0E1118]/95">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          aria-label="Close modal"
        >
          <X size={20} />
        </button>

        <div className="flex items-center gap-2 mb-4">
          <HelpCircle className="text-[#6C5DD3]" size={24} />
          <h3 className="text-xl font-bold text-white">Fee & Yield Assumptions</h3>
        </div>

        <div className="space-y-4 text-sm text-gray-300">
          <p>
            Here is a non-technical summary of how fees are handled in our calculations, treasury simulations, and exit impact estimates:
          </p>

          <div className="space-y-3">
            <div className="bg-white/5 p-3 rounded-lg border border-white/5">
              <h4 className="font-semibold text-white text-xs uppercase tracking-wider mb-1">Fee Drag (Management & Protocol)</h4>
              <p className="text-xs">
                Vaults may charge management fees to cover automated rebalancing costs. Dynamic protocol swap/lending fees from underlying pools are subtracted to calculate your net APY.
              </p>
            </div>

            <div className="bg-white/5 p-3 rounded-lg border border-white/5">
              <h4 className="font-semibold text-white text-xs uppercase tracking-wider mb-1">Execution Costs & Slippage</h4>
              <p className="text-xs">
                Exiting large positions can cause a "price impact" against limited pool depth, which reduces the amount of assets you actually receive.
              </p>
            </div>

            <div className="bg-white/5 p-3 rounded-lg border border-white/5">
              <h4 className="font-semibold text-white text-xs uppercase tracking-wider mb-1">Rotation Costs</h4>
              <p className="text-xs">
                Moving capital between strategies incurs network transaction gas (very low on Stellar) and exchange fees which are deducted from your model output.
              </p>
            </div>
          </div>

          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-200 text-xs flex gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Yield & Fee Estimation Disclaimer</p>
              <p className="mt-0.5 opacity-90">
                All projections and simulation figures are mathematical approximations based on current market data. Real-time rates, dynamic fee curves, and price slippage are highly volatile. No exact fee outcomes are promised or guaranteed.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full btn-primary text-sm py-2.5 flex items-center justify-center"
        >
          Got it
        </button>
      </div>
    </div>
  );
};
