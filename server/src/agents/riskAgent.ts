/**
 * AI-Powered Risk Assessment Agent
 *
 * Evaluates the risk of underlying DeFi protocols by analyzing social
 * sentiment, governance activity, and protocol health metrics. Uses an
 * LLM (Google Gemini or OpenAI) to produce a standardized risk report.
 *
 * Prompt Architecture:
 *   SYSTEM: You are a DeFi risk analyst. Evaluate protocols for smart
 *           contract risk, governance risk, and market risk.
 *   USER:   Provides protocol name, recent news, TVL data, and audit info.
 *   OUTPUT: JSON with score (1-100), category, and reasoning.
 */

import { calculateRiskScore } from "../utils/riskScoring";
import { resilientFetch } from "./resilientFetch";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RiskReport {
  protocol: string;
  score: number; // 1-100 (100 = safest)
  category: "low" | "medium" | "high" | "critical";
  reasoning: string;
  factors: {
    smartContractRisk: number;
    governanceRisk: number;
    marketRisk: number;
    sentimentScore: number;
  };
  timestamp: string;
}

export interface ProtocolInput {
  name: string;
  tvlUsd: number;
  ageMonths: number;
  audited: boolean;
  recentNews?: string[];
  governanceActivity?: string;
}

// ── LLM Integration ──────────────────────────────────────────────────────────

const getLLMApiKey = () => process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";
const getLLMProvider = () => process.env.LLM_PROVIDER || "gemini"; // "gemini" | "openai"

const SYSTEM_PROMPT = `You are a DeFi risk analyst specializing in Stellar/Soroban protocols.
Evaluate the given protocol and return a JSON object with:
- score: integer 1-100 (100 = safest)
- category: "low" | "medium" | "high" | "critical"
- reasoning: 2-3 sentence explanation
- factors: { smartContractRisk: 1-100, governanceRisk: 1-100, marketRisk: 1-100, sentimentScore: 1-100 }

Base your assessment on: TVL size, protocol age, audit status, recent news sentiment, and governance activity.
Return ONLY valid JSON, no markdown.`;

function buildUserPrompt(input: ProtocolInput): string {
  const news = input.recentNews?.length
    ? `Recent news:\n${input.recentNews.map((n) => `- ${n}`).join("\n")}`
    : "No recent news available.";

  const governance = input.governanceActivity || "No governance activity data.";

  return `Protocol: ${input.name}
TVL: $${input.tvlUsd.toLocaleString()}
Age: ${input.ageMonths} months
Audited: ${input.audited ? "Yes" : "No"}
${news}
Governance: ${governance}`;
}

function logAudit(metadata: {
  provider: string;
  model: string;
  durationMs: number;
  success: boolean;
  error?: string;
  prompt?: string;
  response?: string;
}) {
  const sanitize = (text?: string): string => {
    if (!text) return "";
    let clean = text;
    // Redact top-level API Key reference
    const apiKey = getLLMApiKey();
    if (apiKey) {
      clean = clean.split(apiKey).join("[REDACTED]");
    }
    // Also scan for common credentials pattern
    clean = clean.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
    clean = clean.replace(/key=[a-zA-Z0-9_\-\.]+/gi, "key=[REDACTED]");
    clean = clean.replace(/api_key=[a-zA-Z0-9_\-\.]+/gi, "api_key=[REDACTED]");
    clean = clean.replace(/apikey=[a-zA-Z0-9_\-\.]+/gi, "apikey=[REDACTED]");

    // Truncate overly large raw payloads
    if (clean.length > 4000) {
      clean = clean.substring(0, 4000) + "... [TRUNCATED]";
    }
    return clean;
  };

  const logEntry = {
    ts: new Date().toISOString(),
    level: metadata.success ? "info" : "error",
    event: "risk_agent_llm_call",
    provider: metadata.provider,
    model: metadata.model,
    durationMs: metadata.durationMs,
    success: metadata.success,
    error: metadata.error,
    prompt: sanitize(metadata.prompt),
    response: sanitize(metadata.response),
  };

  const line = JSON.stringify(logEntry);
  if (!metadata.success) {
    console.error(line);
  } else {
    console.log(line);
const LLM_TIMEOUT_MS = 15_000;
const LLM_MAX_RETRIES = 2;

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!LLM_API_KEY) {
    throw new Error("No LLM API key configured (set GEMINI_API_KEY or OPENAI_API_KEY)");
  }
}

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const provider = getLLMProvider();
  const apiKey = getLLMApiKey();
  const model = provider === "openai" ? "gpt-4o-mini" : "gemini-2.0-flash";
  const start = Date.now();
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  try {
    if (!apiKey) {
      throw new Error("No LLM API key configured (set GEMINI_API_KEY or OPENAI_API_KEY)");
    }

    let result = "";
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
  if (LLM_PROVIDER === "openai") {
    const res = await resilientFetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
      });
      if (!res.ok) {
        throw new Error("OpenAI API failed with status " + res.status);
      }
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      result = data.choices[0].message.content;
    } else {
      // Default: Google Gemini
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
          }),
        },
      );
      if (!res.ok) {
        throw new Error("Gemini API failed with status " + res.status);
      }
      const data = (await res.json()) as {
        candidates: { content: { parts: { text: string }[] } }[];
      };
      result = data.candidates[0].content.parts[0].text;
    }

    logAudit({
      provider,
      model,
      durationMs: Date.now() - start,
      success: true,
      prompt: fullPrompt,
      response: result,
    });

    return result;
  } catch (err: any) {
    logAudit({
      provider,
      model,
      durationMs: Date.now() - start,
      success: false,
      error: err.message || String(err),
      prompt: fullPrompt,
    });
    throw err;
  }
      },
      "openai-risk-agent",
      { timeoutMs: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES },
    );
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }

  // Default: Google Gemini
  const res = await resilientFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${LLM_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      }),
    },
    "gemini-risk-agent",
    { timeoutMs: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES },
  );
  const data = (await res.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  return data.candidates[0].content.parts[0].text;
}


// ── Agent Core ───────────────────────────────────────────────────────────────

/**
 * Assess the risk of a protocol using the AI agent.
 * Falls back to the algorithmic risk scoring if the LLM is unavailable.
 */
export async function assessProtocolRisk(input: ProtocolInput): Promise<RiskReport> {
  try {
    const userPrompt = buildUserPrompt(input);
    const raw = await callLLM(SYSTEM_PROMPT, userPrompt);

    // Parse JSON from LLM response (strip markdown fences if present)
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      score: number;
      category: string;
      reasoning: string;
      factors: {
        smartContractRisk: number;
        governanceRisk: number;
        marketRisk: number;
        sentimentScore: number;
      };
    };

    return {
      protocol: input.name,
      score: Math.max(1, Math.min(100, parsed.score)),
      category: validateCategory(parsed.category),
      reasoning: parsed.reasoning,
      factors: parsed.factors,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // Fallback to algorithmic scoring
    console.warn(`AI risk agent failed for ${input.name}, using algorithmic fallback:`, err);
    return fallbackRiskAssessment(input);
  }
}

function validateCategory(cat: string): "low" | "medium" | "high" | "critical" {
  const valid = ["low", "medium", "high", "critical"];
  return valid.includes(cat) ? (cat as "low" | "medium" | "high" | "critical") : "medium";
}

function fallbackRiskAssessment(input: ProtocolInput): RiskReport {
  const { score, label } = calculateRiskScore({
    tvlUsd: input.tvlUsd,
    ilVolatilityPct: input.audited ? 5 : 15,
    protocolAgeDays: input.ageMonths * 30,
  });

  // Convert 1-10 scale to 1-100
  const score100 = score * 10;
  const category = label === "Low" ? "low" : label === "Medium" ? "medium" : "high";

  return {
    protocol: input.name,
    score: score100,
    category,
    reasoning: `Algorithmic assessment based on TVL ($${input.tvlUsd.toLocaleString()}), age (${input.ageMonths} months), and audit status.`,
    factors: {
      smartContractRisk: input.audited ? 80 : 40,
      governanceRisk: 50,
      marketRisk: Math.round(score100 * 0.8),
      sentimentScore: 50,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run the risk agent for a batch of protocols.
 */
export async function assessAllProtocols(protocols: ProtocolInput[]): Promise<RiskReport[]> {
  const results: RiskReport[] = [];
  for (const protocol of protocols) {
    const report = await assessProtocolRisk(protocol);
    results.push(report);
  }
  return results;
}
