import nodemailer from "nodemailer";
import { renderWeeklyYieldReport } from "../templates/weeklyYieldReportTemplate";

/**
 * Email Service for sending transactional emails
 * Supports SMTP configuration via environment variables
 */

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  from: string;
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

let transporter: nodemailer.Transporter | null = null;

/**
 * Initialize email transporter
 */
export function initializeEmailService(): nodemailer.Transporter {
  if (transporter) {
    return transporter;
  }

  const config: EmailConfig = {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASSWORD || "",
    },
    from: process.env.SMTP_FROM || "noreply@yieldaggregator.com",
  };

  if (!config.auth.user || !config.auth.pass) {
    console.warn(
      "Email service not configured. Set SMTP_USER and SMTP_PASSWORD environment variables.",
    );
  }

  transporter = nodemailer.createTransport(config);

  return transporter;
}

/**
 * Send email
 */
export async function sendEmail(options: EmailOptions): Promise<void> {
  const transport = initializeEmailService();

  try {
    const mailOptions = {
      from: process.env.SMTP_FROM || "noreply@yieldaggregator.com",
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo || process.env.SMTP_REPLY_TO,
    };

    const info = await transport.sendMail(mailOptions);
    console.log(`Email sent to ${options.to}: ${info.messageId}`);
  } catch (error) {
    console.error(`Failed to send email to ${options.to}:`, error);
    throw error;
  }
}

/**
 * Send test email
 */
export async function sendTestEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Test Email from Yield Aggregator",
    html: "<h1>Test Email</h1><p>This is a test email from the Yield Aggregator system.</p>",
    text: "This is a test email from the Yield Aggregator system.",
  });
}

/**
 * Verify email configuration
 */
export async function verifyEmailConfiguration(): Promise<boolean> {
  try {
    const transport = initializeEmailService();
    await transport.verify();
    console.log("Email service verified successfully");
    return true;
  } catch (error) {
    console.error("Email service verification failed:", error);
    return false;
  }
}

/**
 * Send weekly yield report email
 */
export async function sendWeeklyYieldReportEmail(
  userEmail: string,
  reportData: {
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
  },
): Promise<void> {
  const html = renderWeeklyYieldReport(reportData);

  await sendEmail({
    to: userEmail,
    subject: `Your Weekly Yield Report - ${reportData.period.startDate} to ${reportData.period.endDate}`,
    html,
    text: `Weekly Yield Report\n\nHello ${reportData.userName},\n\nYour weekly yield: $${reportData.weeklyYield.toFixed(2)} (${reportData.weeklyYieldPercentage.toFixed(2)}%)\n\nTop performing vaults:\n${reportData.topVaults.map((v) => `- ${v.vaultName}: $${v.yield.toFixed(2)}`).join("\n")}\n\nView your full report on the dashboard.`,
  });
}

/**
 * Send batch emails
 */
export async function sendBatchEmails<T extends object>(
  recipients: Array<{ email: string; data: T }>,
  emailGenerator: (data: T) => EmailOptions,
): Promise<{
  sent: number;
  failed: number;
  errors: Array<{ email: string; error: string }>;
}> {
  const results = {
    sent: 0,
    failed: 0,
    errors: [] as Array<{ email: string; error: string }>,
  };

  for (const recipient of recipients) {
    try {
      const emailOptions = emailGenerator(recipient.data);
      await sendEmail(emailOptions);
      results.sent++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        email: recipient.email,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return results;
}
