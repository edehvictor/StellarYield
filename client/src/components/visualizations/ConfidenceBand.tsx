import React from 'react';

export interface AllocationBand {
  assetId: string;
  recommendedAllocation: number;
  lowerBound: number;
  upperBound: number;
  bandWidth: number;
  confidenceScore: number;
  volatility: number;
  disclaimer: string;
}

export interface ConfidenceBandProps {
  bands: AllocationBand[];
  portfolioConfidence: number;
  totalAllocation: number;
  interpretation: string;
  showDisclaimer?: boolean;
  compact?: boolean;
}

const getConfidenceLabel = (score: number): string => {
  if (score >= 0.85) return 'Very High';
  if (score >= 0.65) return 'High';
  if (score >= 0.45) return 'Medium';
  if (score >= 0.25) return 'Low';
  return 'Very Low';
};

const getConfidenceColor = (score: number): string => {
  if (score >= 0.85) return '#4caf50';
  if (score >= 0.65) return '#8bc34a';
  if (score >= 0.45) return '#ff9800';
  if (score >= 0.25) return '#f44336';
  return '#d32f2f';
};

const ConfidenceBand: React.FC<ConfidenceBandProps> = ({
  bands,
  portfolioConfidence,
  totalAllocation,
  interpretation,
  showDisclaimer = true,
  compact = false,
}) => {
  if (bands.length === 0) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-blue-700">
        No allocation confidence data available.
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* Portfolio Overview */}
      <div className={`bg-white rounded-lg shadow-md p-${compact ? '4' : '6'} mb-4`}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-gray-500">Portfolio Confidence</p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`font-bold ${compact ? 'text-xl' : 'text-2xl'}`}>
                {(portfolioConfidence * 100).toFixed(1)}%
              </span>
              <span
                className="text-white text-xs px-2 py-1 rounded-full"
                style={{ backgroundColor: getConfidenceColor(portfolioConfidence) }}
              >
                {getConfidenceLabel(portfolioConfidence)}
              </span>
            </div>
          </div>
          <div>
            <p className="text-sm text-gray-500">Total Allocation</p>
            <span className={`font-bold ${compact ? 'text-xl' : 'text-2xl'} mt-1 block`}>
              {totalAllocation.toFixed(1)}%
            </span>
          </div>
          <div>
            <p className="text-sm text-gray-500">Assets</p>
            <span className={`font-bold ${compact ? 'text-xl' : 'text-2xl'} mt-1 block`}>
              {bands.length}
            </span>
          </div>
        </div>
      </div>

      {/* Confidence Bands */}
      <div className="flex flex-col gap-3">
        {bands.map((band) => (
          <div
            key={band.assetId}
            className="bg-white rounded-lg shadow-sm p-4 transition-transform hover:-translate-y-0.5 hover:shadow-lg"
          >
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
              {/* Asset Info */}
              <div className="sm:col-span-3">
                <h3 className="font-bold text-lg">{band.assetId}</h3>
                <div
                  className="group relative inline-block cursor-help ml-1"
                  title={band.disclaimer}
                >
                  <svg
                    className="w-4 h-4 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
              </div>

              {/* Recommended Allocation */}
              <div className="sm:col-span-2">
                <p className="text-sm text-gray-500">Recommended</p>
                <span className="font-bold text-xl block">
                  {band.recommendedAllocation.toFixed(1)}%
                </span>
              </div>

              {/* Confidence Band Visualization */}
              <div className="sm:col-span-4">
                <p className="text-sm text-gray-500">Confidence Range</p>
                <div className="mt-1 relative">
                  {/* Band Bar */}
                  <div className="relative h-6 bg-gray-100 rounded overflow-hidden">
                    {/* Lower to Upper Range */}
                    <div
                      className="absolute h-full rounded border-2"
                      style={{
                        left: `${band.lowerBound}%`,
                        width: `${band.bandWidth}%`,
                        backgroundColor: `${getConfidenceColor(band.confidenceScore)}40`,
                        borderColor: getConfidenceColor(band.confidenceScore),
                      }}
                    />
                    {/* Recommended Marker */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5"
                      style={{
                        left: `${band.recommendedAllocation}%`,
                        backgroundColor: getConfidenceColor(band.confidenceScore),
                        transform: 'translateX(-50%)',
                      }}
                    />
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-xs text-gray-500">
                      {band.lowerBound.toFixed(1)}%
                    </span>
                    <span className="text-xs text-gray-500">
                      {band.upperBound.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Confidence Score */}
              <div className="sm:col-span-3">
                <p className="text-sm text-gray-500">Confidence</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-bold text-xl">
                    {(band.confidenceScore * 100).toFixed(0)}%
                  </span>
                  <span
                    className="text-white text-xs px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor: getConfidenceColor(band.confidenceScore),
                      fontSize: '0.65rem',
                    }}
                  >
                    {getConfidenceLabel(band.confidenceScore)}
                  </span>
                </div>
                {!compact && (
                  <span className="text-xs text-gray-500 mt-1 block">
                    ±{(band.bandWidth / 2).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>

            {/* Band Width Indicator */}
            {!compact && (
              <div className="mt-3">
                <hr className="mb-2" />
                <div className="flex justify-between items-center">
                  <span className="text-xs text-gray-500">
                    Band Width: {band.bandWidth.toFixed(1)}%
                  </span>
                  <div
                    className="group relative inline-block cursor-help"
                    title={interpretation}
                  >
                    <svg
                      className="w-4 h-4 text-gray-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                </div>
                <span className="text-xs text-gray-500 mt-1 block">
                  Volatility: {(band.volatility * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Disclaimer */}
      {showDisclaimer && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4 flex gap-2">
          <svg
            className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm text-blue-700">
            <strong>Disclaimer:</strong> Confidence bands represent estimation uncertainty, not guaranteed
            execution ranges or guaranteed outcomes. Actual allocations may vary based on market conditions.
          </p>
        </div>
      )}
    </div>
  );
};

export default ConfidenceBand;
