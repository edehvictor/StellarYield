import React, { useState, useEffect, useRef } from "react";
import { CreditCard, ArrowRight, CheckCircle2, ShieldCheck, DollarSign, AlertCircle } from "lucide-react";
import { apiUrl } from "../../lib/api";

interface OnRampModalProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
}

interface Quote {
  quoteId: string;
  provider: string;
  amountFiat: number;
  currency: string;
  amountUsdc: number;
  expiresAt: number;
}

const OnRampModal: React.FC<OnRampModalProps> = ({ isOpen, onClose, walletAddress }) => {
  const [fiatAmount, setFiatAmount] = useState<number>(100);
  const [currency, setCurrency] = useState("USD");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch quote helper
  const fetchQuote = async (amount: number, curr: string) => {
    if (amount <= 0) return;
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/onramp/quote"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountFiat: amount, currency: curr }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to fetch quote");
      }
      const data = (await res.json()) as Quote;
      setQuote(data);
      setTimeLeft(Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000)));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Error getting quote");
      setQuote(null);
    }
  };

  // Debounced quote fetch
  useEffect(() => {
    if (!isOpen) return;
    const handler = setTimeout(() => {
      fetchQuote(fiatAmount, currency);
    }, 400);

    return () => clearTimeout(handler);
  }, [fiatAmount, currency, isOpen]);

  // Expiration countdown ticker
  useEffect(() => {
    if (!quote) return;

    const ticker = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((quote.expiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(ticker);
      }
    }, 1000);

    return () => clearInterval(ticker);
  }, [quote]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const handleCancel = async () => {
    if (!txId) {
      onClose();
      return;
    }
    try {
      await fetch(apiUrl("/api/onramp/cancel"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txId }),
      });
    } catch (err) {
      console.error("Cancel failed", err);
    } finally {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      setTxId(null);
      setIsProcessing(false);
      onClose();
    }
  };

  const handlePurchase = async () => {
    if (!quote || timeLeft <= 0) {
      setError("Quote is expired. Please refresh the quote.");
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProcessingStatus("Creating intent...");

    try {
      const res = await fetch(apiUrl("/api/onramp/intent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteId: quote.quoteId,
          walletAddress,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to confirm intent");
      }

      const { transaction } = await res.json();
      const currentTxId = transaction.providerTxId;
      setTxId(currentTxId);
      setProcessingStatus("Waiting for payment processing...");

      // Start status polling
      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(apiUrl(`/api/onramp/status/${currentTxId}`));
          if (statusRes.ok) {
            const { status } = await statusRes.json();
            if (status === "COMPLETED") {
              if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
              setIsProcessing(false);
              setIsCompleted(true);
            } else if (status === "FAILED") {
              if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
              setIsProcessing(false);
              setError("Payment failed. Please try again.");
            }
          }
        } catch (pollErr) {
          console.error("Status poll error", pollErr);
        }
      }, 2000);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to initiate purchase");
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  const isQuoteExpired = timeLeft <= 0;
  const estimatedUsdc = quote ? quote.amountUsdc.toFixed(2) : (fiatAmount * 0.98).toFixed(2);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-xl animate-in fade-in duration-300" onClick={handleCancel}></div>
      
      <div className="glass-panel w-full max-w-lg overflow-hidden border border-white/10 shadow-[0_0_100px_rgba(79,70,229,0.3)] z-[101] animate-in zoom-in-95 duration-300">
        {!isCompleted ? (
          <div className="p-8 space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-black tracking-tight flex items-center gap-3">
                <CreditCard className="text-indigo-400" size={28} />
                BUY USDC
              </h2>
              <div className="bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20">
                <span className="text-[10px] font-black tracking-widest text-indigo-400 uppercase">Secure Quote</span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest">You Pay</label>
                <div className="flex items-center gap-3">
                  <input 
                    type="number"
                    value={fiatAmount}
                    disabled={isProcessing}
                    onChange={(e) => setFiatAmount(parseFloat(e.target.value) || 0)}
                    className="bg-transparent text-3xl font-black w-full outline-none focus:text-indigo-400 transition-colors"
                  />
                  <select 
                    value={currency}
                    disabled={isProcessing}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="bg-white/10 rounded-xl px-3 py-1 text-sm font-bold border-none outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-center -my-2 relative z-10">
                <div className="bg-indigo-600 p-2 rounded-full border-4 border-slate-900 shadow-xl">
                  <ArrowRight size={20} className="rotate-90 text-white" />
                </div>
              </div>

              <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest">You Receive</label>
                <div className="flex items-center justify-between">
                  <span className="text-3xl font-black text-white">{estimatedUsdc}</span>
                  <div className="flex items-center gap-2">
                    <img src="https://cryptologos.cc/logos/usd-coin-usdc-logo.png" className="w-6 h-6" alt="USDC" />
                    <span className="font-bold">USDC</span>
                  </div>
                </div>
              </div>
            </div>

            {quote && !isProcessing && (
              <div className="flex justify-between items-center px-2 text-xs">
                {isQuoteExpired ? (
                  <span className="text-red-400 font-bold flex items-center gap-1">
                    <AlertCircle size={14} /> Quote expired
                  </span>
                ) : (
                  <span className="text-gray-400">
                    Quote expires in <span className="text-indigo-400 font-bold">{timeLeft}s</span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => fetchQuote(fiatAmount, currency)}
                  className="text-indigo-400 hover:text-indigo-300 font-bold underline transition-colors"
                >
                  Refresh Quote
                </button>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
                <AlertCircle className="shrink-0" size={16} />
                <span>{error}</span>
              </div>
            )}

            <div className="p-4 bg-indigo-500/5 rounded-2xl border border-indigo-500/20 flex gap-4 items-center">
              <ShieldCheck className="text-indigo-400 shrink-0" size={24} />
              <div className="text-xs space-y-1">
                <p className="text-gray-300 font-bold uppercase tracking-wide">Secure Transaction</p>
                <p className="text-gray-500">Funds will be sent directly to <span className="text-indigo-300 font-mono">{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span></p>
              </div>
            </div>

            <div className="flex gap-3">
              <button 
                type="button"
                onClick={handleCancel}
                className="flex-1 py-4 rounded-2xl font-black tracking-widest uppercase text-sm border border-white/10 hover:bg-white/5 transition-all text-white"
              >
                Cancel
              </button>
              <button 
                onClick={handlePurchase}
                disabled={isProcessing || isQuoteExpired || !quote}
                className={`flex-[2] py-4 rounded-2xl font-black tracking-widest uppercase text-sm transition-all shadow-xl shadow-indigo-500/20 active:scale-[0.98] ${
                  isProcessing || isQuoteExpired || !quote ? 'bg-indigo-800 cursor-not-allowed opacity-50' : 'bg-indigo-500 hover:bg-indigo-400 text-white'
                }`}
              >
                {isProcessing ? (
                  <div className="flex items-center justify-center gap-3">
                    <div className="animate-spin h-5 w-5 border-2 border-white/30 border-t-white rounded-full"></div>
                    {processingStatus?.toUpperCase()}
                  </div>
                ) : (
                  `PAY ${fiatAmount} ${currency}`
                )}
              </button>
            </div>
            <p className="text-center text-[10px] text-gray-600 font-medium">Estimated arrival: Within 2 minutes</p>
          </div>
        ) : (
          <div className="p-12 text-center space-y-8 animate-in slide-in-from-bottom-8 duration-500">
            <div className="bg-green-500/20 w-24 h-24 rounded-full flex items-center justify-center mx-auto shadow-2xl shadow-green-500/20 border border-green-500/30">
              <CheckCircle2 className="text-green-500" size={48} />
            </div>
            
            <div className="space-y-4">
              <h2 className="text-3xl font-black tracking-tight">PURCHASE SUCCESS!</h2>
              <p className="text-gray-400 text-lg">
                Your <span className="text-white font-bold">{estimatedUsdc} USDC</span> is on its way to your Stellar wallet.
              </p>
            </div>

            <div className="p-6 bg-white/5 rounded-3xl border border-white/10 space-y-4">
              <div className="flex items-center justify-center gap-3 text-indigo-400">
                <DollarSign size={24} />
                <span className="font-black text-xl">START EARNING</span>
              </div>
              <p className="text-gray-500 text-sm">Now that you have USDC, deposit it into our High-Yield Vault to earn up to <span className="text-green-400 font-bold">12.5% APY</span>.</p>
              <button 
                onClick={onClose}
                className="w-full bg-white text-black py-3 rounded-xl font-black uppercase text-xs hover:bg-gray-200 transition-all transition-all active:scale-[0.98]"
              >
                Go to Vault
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default OnRampModal;
