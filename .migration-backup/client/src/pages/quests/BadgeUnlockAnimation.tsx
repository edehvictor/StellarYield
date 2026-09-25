import { motion, AnimatePresence } from "framer-motion";
import { Trophy } from "lucide-react";

interface Props {
  show: boolean;
  questTitle: string;
  points: number;
  onDone: () => void;
}

/**
 * Celebratory full-screen overlay shown when a badge NFT is successfully minted.
 * Uses Framer Motion for entrance/exit animations and particle burst effect.
 */
export default function BadgeUnlockAnimation({ show, questTitle, points, onDone }: Props) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onDone}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          />

          {/* Particle burst */}
          {Array.from({ length: 20 }).map((_, i) => (
            <motion.div
              key={i}
              className="absolute w-2 h-2 rounded-full"
              style={{
                background: `hsl(${(i * 18) % 360}, 80%, 60%)`,
                top: "50%",
                left: "50%",
              }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{
                x: (Math.cos((i / 20) * Math.PI * 2) * 200),
                y: (Math.sin((i / 20) * Math.PI * 2) * 200),
                opacity: 0,
                scale: 0,
              }}
              transition={{ duration: 1.2, delay: 0.2, ease: "easeOut" }}
            />
          ))}

          {/* Badge card */}
          <motion.div
            className="relative glass-panel p-10 flex flex-col items-center gap-4 max-w-sm w-full mx-4 text-center"
            initial={{ scale: 0.5, y: 60, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            {/* Pulsing glow ring */}
            <motion.div
              className="w-24 h-24 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-2xl"
              animate={{ boxShadow: ["0 0 20px rgba(108,93,211,0.4)", "0 0 60px rgba(108,93,211,0.8)", "0 0 20px rgba(108,93,211,0.4)"] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              <Trophy size={40} className="text-white" />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <p className="text-xs text-indigo-400 uppercase tracking-widest font-semibold mb-1">
                Achievement Unlocked
              </p>
              <h2 className="text-2xl font-extrabold text-white">{questTitle}</h2>
              <p className="text-indigo-300 mt-2 font-semibold">+{points} XP</p>
              <p className="text-gray-400 text-sm mt-3">Badge NFT minted on-chain</p>
            </motion.div>

            <motion.p
              className="text-xs text-gray-500 mt-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1 }}
            >
              Tap anywhere to continue
            </motion.p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
