/**
 * Digest Email Template
 * Generates HTML email for notification digests
 * Requirements: 6.6, 7.3, 7.4
 */

import type { DigestPayload, RankedClusterEntry, EventType } from '../services/digest/types';

const SECTION_HEADERS: Record<EventType, string> = {
  alert: '🔔 Alerts',
  recommendation: '💡 Recommendations',
  watchlist: '👁 Watchlist',
};

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

function truncateWallet(address: string): string {
  if (address.length <= 10) return address;
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

function importanceBadgeColor(score: number): string {
  if (score >= 70) return '#e53935';
  if (score >= 40) return '#fb8c00';
  return '#43a047';
}

function renderClusterEntry(entry: RankedClusterEntry): string {
  const badgeColor = importanceBadgeColor(entry.topImportanceScore);
  return `
    <tr style="border-bottom: 1px solid #e0e0e0;">
      <td style="padding: 12px; color: #333; font-size: 14px;">
        ${escapeHtml(entry.summary)}
      </td>
      <td style="padding: 12px; text-align: center; color: #666; font-size: 13px;">
        ${entry.eventCount}
      </td>
      <td style="padding: 12px; text-align: center;">
        <span style="
          display: inline-block;
          background-color: ${badgeColor};
          color: white;
          padding: 3px 8px;
          border-radius: 3px;
          font-size: 11px;
          font-weight: 600;
        ">${entry.topImportanceScore}</span>
      </td>
    </tr>
  `;
}

function renderSection(eventType: EventType, entries: RankedClusterEntry[]): string {
  if (entries.length === 0) return '';
  const header = SECTION_HEADERS[eventType];
  const rows = entries.map(renderClusterEntry).join('');
  return `
    <div class="section-title">${escapeHtml(header)}</div>
    <table class="vaults-table">
      <thead>
        <tr>
          <th>Summary</th>
          <th style="text-align: center; width: 80px;">Events</th>
          <th style="text-align: center; width: 100px;">Importance</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

export function renderDigestEmail(payload: DigestPayload): string {
  const walletDisplay = truncateWallet(payload.walletAddress);
  const generatedDate = new Date(payload.generatedAt).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  // Group clusters by eventType
  const byType: Record<EventType, RankedClusterEntry[]> = {
    alert: [],
    recommendation: [],
    watchlist: [],
  };
  for (const cluster of payload.clusters) {
    byType[cluster.eventType].push(cluster);
  }

  const sectionsHtml = (
    renderSection('alert', byType.alert) +
    renderSection('recommendation', byType.recommendation) +
    renderSection('watchlist', byType.watchlist)
  );

  const totalCount = payload.clusters.reduce((sum, c) => sum + c.eventCount, 0);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notification Digest</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #f5f5f5;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }
    .header {
      background: linear-gradient(135deg, #1976d2 0%, #1565c0 100%);
      color: white;
      padding: 40px 20px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
    }
    .header p {
      margin: 8px 0 0 0;
      font-size: 14px;
      opacity: 0.9;
    }
    .content {
      padding: 30px 20px;
    }
    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: #333;
      margin: 30px 0 15px 0;
      border-bottom: 2px solid #1976d2;
      padding-bottom: 10px;
    }
    .vaults-table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
    }
    .vaults-table th {
      background-color: #f0f0f0;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #666;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .vaults-table td {
      padding: 12px;
    }
    .vaults-table tr:hover {
      background-color: #f9f9f9;
    }
    .stat-card {
      background-color: #f9f9f9;
      border-left: 4px solid #1976d2;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
    }
    .stat-label {
      font-size: 12px;
      color: #999;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #1976d2;
    }
    .wallet-address {
      background-color: #f0f0f0;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      color: #666;
      display: inline-block;
      margin: 10px 0;
    }
    .cta-button {
      display: inline-block;
      background-color: #1976d2;
      color: white;
      padding: 12px 30px;
      text-decoration: none;
      border-radius: 4px;
      font-weight: 600;
      margin: 20px 0;
      text-align: center;
    }
    .footer {
      background-color: #f5f5f5;
      padding: 20px;
      text-align: center;
      font-size: 12px;
      color: #999;
      border-top: 1px solid #e0e0e0;
    }
    .footer a {
      color: #1976d2;
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 600px) {
      .vaults-table {
        font-size: 12px;
      }
      .vaults-table th,
      .vaults-table td {
        padding: 8px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>📬 Your Notification Digest</h1>
      <p>${escapeHtml(generatedDate)}</p>
    </div>

    <!-- Content -->
    <div class="content">
      <!-- Wallet Address -->
      <div style="text-align: center; margin: 15px 0;">
        <span class="wallet-address">${escapeHtml(walletDisplay)}</span>
      </div>

      <!-- Summary stat -->
      <div class="stat-card">
        <div class="stat-label">Total Updates</div>
        <div class="stat-value">${totalCount}</div>
      </div>

      <!-- Sections grouped by event type -->
      ${sectionsHtml || '<p style="color: #999; text-align: center;">No new notifications in this digest.</p>'}

      <!-- Call to Action -->
      <div style="text-align: center; margin-top: 30px;">
        <a href="${process.env.DASHBOARD_URL || 'https://app.yieldaggregator.com'}/dashboard" class="cta-button">
          View Full Dashboard
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p style="margin: 0 0 10px 0;">
        © ${new Date().getFullYear()} Yield Aggregator. All rights reserved.
      </p>
      <p style="margin: 0;">
        <a href="${process.env.DASHBOARD_URL || 'https://app.yieldaggregator.com'}/settings/notifications">Manage Preferences</a> |
        <a href="${process.env.DASHBOARD_URL || 'https://app.yieldaggregator.com'}/help">Help Center</a> |
        <a href="${process.env.DASHBOARD_URL || 'https://app.yieldaggregator.com'}/privacy">Privacy Policy</a>
      </p>
    </div>
  </div>
</body>
</html>
  `;
}
