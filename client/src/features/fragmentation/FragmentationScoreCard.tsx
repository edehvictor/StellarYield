import { Activity } from 'lucide-react';
import type { FragmentationCategory } from './types';

interface FragmentationScoreCardProps {
  score: number;
  category: FragmentationCategory;
  categoryDescription: string;
}

/**
 * FragmentationScoreCard displays the fragmentation score with visual indicators.
 * Color coding: Low (green), Medium (yellow), High (red)
 * 
 * Requirements: 4.1, 5.1, 5.2, 5.3, 5.4, 5.5
 */
export default function FragmentationScoreCard({
  score,
  category,
  categoryDescription,
}: FragmentationScoreCardProps) {
  const categoryConfig = {
    Low: {
      color: 'border-green-500',
      bgColor: 'bg-green-500/20',
      textColor: 'text-green-400',
      iconColor: 'text-green-500',
    },
    Medium: {
      color: 'border-yellow-500',
      bgColor: 'bg-yellow-500/20',
      textColor: 'text-yellow-400',
      iconColor: 'text-yellow-500',
    },
    High: {
      color: 'border-red-500',
      bgColor: 'bg-red-500/20',
      textColor: 'text-red-400',
      iconColor: 'text-red-500',
    },
  };

  const config = categoryConfig[category];

  return (
    <div className={`glass-card border-l-4 ${config.color} p-6`}>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-sm font-medium tracking-wide text-gray-400">
            FRAGMENTATION SCORE
          </p>
          <h3 className="mt-1 text-3xl font-bold shadow-sm">
            {score.toFixed(1)}
          </h3>
          <span className={`mt-2 inline-block rounded px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider ${config.bgColor} ${config.textColor}`}>
            {category}
          </span>
        </div>
        <div className={`rounded-xl ${config.bgColor} p-3 ${config.iconColor}`}>
          <Activity size={24} />
        </div>
      </div>
      <div className="text-sm text-gray-400">
        {categoryDescription}
      </div>
    </div>
  );
}
