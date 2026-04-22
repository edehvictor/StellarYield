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

const LLM_API_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_PROVIDER = process.env.LLM_PROVIDER || "gemini"; // "gemini" | "openai"

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

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!LLM_API_KEY) {
    throw new Error("No LLM API key configured (set GEMINI_API_KEY or OPENAI_API_KEY)");
  }

  if (LLM_PROVIDER === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }

  // Default: Google Gemini
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${LLM_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      }),
    },
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
