import { TrendingUp, AlertTriangle } from 'lucide-react';

interface ExecutionQualityCardProps {
  score: number;
  materialImpact: boolean;
}

/**
 * ExecutionQualityCard displays the execution quality score with color-coded gauge.
 * Color coding: >70 (green), 50-70 (yellow), <50 (red)
 * Shows material impact warning when score < 70
 * 
 * Requirements: 4.2, 4.3, 4.5
 */
export default function ExecutionQualityCard({
  score,
  materialImpact,
}: ExecutionQualityCardProps) {
  const getQualityConfig = (score: number) => {
    if (score >= 70) {
      return {
        color: 'border-green-500',
        bgColor: 'bg-green-500/20',
        textColor: 'text-green-400',
        iconColor: 'text-green-500',
        label: 'Good',
      };
    } else if (score >= 50) {
      return {
        color: 'border-yellow-500',
        bgColor: 'bg-yellow-500/20',
        textColor: 'text-yellow-400',
        iconColor: 'text-yellow-500',
        label: 'Fair',
      };
    } else {
      return {
        color: 'border-red-500',
        bgColor: 'bg-red-500/20',
        textColor: 'text-red-400',
        iconColor: 'text-red-500',
        label: 'Poor',
      };
    }
  };

  const config = getQualityConfig(score);

  return (
    <div className={`glass-card border-l-4 ${config.color} p-6`}>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-sm font-medium tracking-wide text-gray-400">
            EXECUTION QUALITY
          </p>
          <h3 className="mt-1 text-3xl font-bold shadow-sm">
            {score.toFixed(1)}
          </h3>
          <span className={`mt-2 inline-block rounded px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider ${config.bgColor} ${config.textColor}`}>
            {config.label}
          </span>
        </div>
        <div className={`rounded-xl ${config.bgColor} p-3 ${config.iconColor}`}>
          <TrendingUp size={24} />
        </div>
      </div>
      {materialImpact && (
        <div className="flex items-center gap-2 text-sm font-medium text-red-400">
          <AlertTriangle size={16} />
          Material impact detected
        </div>
      )}
      {!materialImpact && (
        <div className="text-sm text-gray-400">
          Trade execution quality is optimal
        </div>
      )}
    </div>
  );
}
