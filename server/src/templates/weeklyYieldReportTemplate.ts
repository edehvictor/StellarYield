/**
 * Weekly Yield Report Email Template
 * Generates HTML email for weekly yield reports
 */

export interface WeeklyYieldReportData {
  userName: string;
  walletAddress: string;
  weeklyYield: number;
  weeklyYieldPercentage: number;
  totalYield: number;
  topVaults: Array<{
    vaultName: string;
    yield: number;
    yieldPercentage: number;
    apy: number;
    tvl: number;
  }>;
  vaultCount: number;
  period: {
    startDate: string;
    endDate: string;
  };
}

export function renderWeeklyYieldReport(data: WeeklyYieldReportData): string {
  const topVaultsHtml = data.topVaults
    .map(
      (vault, index) => `
    <tr style="border-bottom: 1px solid #e0e0e0;">
      <td style="padding: 12px; text-align: center; font-weight: bold; color: #1976d2;">
        #${index + 1}
      </td>
      <td style="padding: 12px; font-weight: 500; color: #333;">
        ${escapeHtml(vault.vaultName)}
      </td>
      <td style="padding: 12px; text-align: right; color: #4caf50; font-weight: bold;">
        $${vault.yield.toFixed(2)}
      </td>
      <td style="padding: 12px; text-align: right; color: #666;">
        ${vault.yieldPercentage.toFixed(2)}%
      </td>
      <td style="padding: 12px; text-align: right; color: #666;">
        ${vault.apy.toFixed(2)}%
      </td>
    </tr>
  `,
    )
    .join("");

  const walletDisplay = `${data.walletAddress.substring(0, 6)}...${data.walletAddress.substring(
    data.walletAddress.length - 4,
  )}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Yield Report</title>
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
    .greeting {
      font-size: 16px;
      margin-bottom: 20px;
      color: #333;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin: 25px 0;
    }
    .stat-card {
      background-color: #f9f9f9;
      border-left: 4px solid #1976d2;
      padding: 15px;
      border-radius: 4px;
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
    .stat-value.positive {
      color: #4caf50;
    }
    .stat-value.percentage {
      font-size: 18px;
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
    .vaults-table th:nth-child(3),
    .vaults-table th:nth-child(4),
    .vaults-table th:nth-child(5) {
      text-align: right;
    }
    .vaults-table td {
      padding: 12px;
    }
    .vaults-table tr:hover {
      background-color: #f9f9f9;
    }
    .highlight-box {
      background-color: #e3f2fd;
      border-left: 4px solid #1976d2;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .highlight-box p {
      margin: 0;
      color: #1565c0;
      font-size: 14px;
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
    .cta-button:hover {
      background-color: #1565c0;
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
    .empty-state {
      text-align: center;
      padding: 20px;
      color: #999;
    }
    .badge {
      display: inline-block;
      background-color: #4caf50;
      color: white;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      margin-left: 8px;
    }
    @media (max-width: 600px) {
      .stats-grid {
        grid-template-columns: 1fr;
      }
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
      <h1>📊 Weekly Yield Report</h1>
      <p>${data.period.startDate} to ${data.period.endDate}</p>
    </div>

    <!-- Content -->
    <div class="content">
      <!-- Greeting -->
      <div class="greeting">
        <p>Hello <strong>${escapeHtml(data.userName)}</strong>,</p>
        <p>Here's your weekly yield summary. Keep earning with the Yield Aggregator!</p>
      </div>

      <!-- Wallet Address -->
      <div style="text-align: center; margin: 15px 0;">
        <span class="wallet-address">${walletDisplay}</span>
      </div>

      <!-- Key Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Weekly Yield</div>
          <div class="stat-value positive">$${data.weeklyYield.toFixed(2)}</div>
          <div style="font-size: 12px; color: #4caf50; margin-top: 5px;">
            +${data.weeklyYieldPercentage.toFixed(2)}%
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Yield</div>
          <div class="stat-value">$${data.totalYield.toFixed(2)}</div>
          <div style="font-size: 12px; color: #666; margin-top: 5px;">
            All time
          </div>
        </div>
      </div>

      <!-- Highlight Box -->
      <div class="highlight-box">
        <p>
          🎯 You're earning yield across <strong>${data.vaultCount}</strong> vault${data.vaultCount !== 1 ? "s" : ""}. 
          Keep it up!
        </p>
      </div>

      <!-- Top Vaults Section -->
      ${
        data.topVaults.length > 0
          ? `
        <div class="section-title">
          🏆 Top Performing Vaults
        </div>
        <table class="vaults-table">
          <thead>
            <tr>
              <th style="width: 40px;">Rank</th>
              <th>Vault Name</th>
              <th>Yield</th>
              <th>Return %</th>
              <th>APY</th>
            </tr>
          </thead>
          <tbody>
            ${topVaultsHtml}
          </tbody>
        </table>
      `
          : `
        <div class="empty-state">
          <p>No vault activity this week. Start earning by depositing into a vault!</p>
        </div>
      `
      }

      <!-- Call to Action -->
      <div style="text-align: center;">
        <a href="${process.env.DASHBOARD_URL || "https://app.yieldaggregator.com"}/dashboard" class="cta-button">
          View Full Dashboard
        </a>
      </div>

      <!-- Additional Info -->
      <div style="background-color: #f9f9f9; padding: 15px; border-radius: 4px; margin-top: 20px; font-size: 13px; color: #666;">
        <p style="margin: 0 0 10px 0;">
          <strong>💡 Tip:</strong> Diversifying across multiple vaults can help optimize your yield while managing risk.
        </p>
        <p style="margin: 0;">
          <strong>📈 Next Steps:</strong> Review your portfolio allocation and consider rebalancing if needed.
        </p>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p style="margin: 0 0 10px 0;">
        © ${new Date().getFullYear()} Yield Aggregator. All rights reserved.
      </p>
      <p style="margin: 0;">
        <a href="${process.env.DASHBOARD_URL || "https://app.yieldaggregator.com"}/settings/notifications">Manage Preferences</a> | 
        <a href="${process.env.DASHBOARD_URL || "https://app.yieldaggregator.com"}/help">Help Center</a> | 
        <a href="${process.env.DASHBOARD_URL || "https://app.yieldaggregator.com"}/privacy">Privacy Policy</a>
      </p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}
