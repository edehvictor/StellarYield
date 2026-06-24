/**
 * Offramp Proxy Router — Issue #717
 *
 * Routes MoonPay/offramp API calls through the server so the API key
 * is never exposed to the browser. The OFFRAMP_API_KEY env var is
 * server-only and never prefixed with VITE_.
 */

import { Router } from "express";
import { sendError } from "../utils/errorResponse";

const offrampRouter = Router();

const OFFRAMP_BASE_URL =
  process.env.OFFRAMP_BASE_URL || "https://api.moonpay.com/v1";
const OFFRAMP_API_KEY = process.env.OFFRAMP_API_KEY || "";

if (!OFFRAMP_API_KEY) {
  console.warn(
    "[offramp] OFFRAMP_API_KEY is not set. Offramp proxy will reject requests.",
  );
}

/** POST /api/offramp/withdrawals — proxy withdrawal creation */
offrampRouter.post("/withdrawals", async (req, res) => {
  if (!OFFRAMP_API_KEY) {
    return sendError(res, 503, "OFFRAMP_UNAVAILABLE", "Offramp service not configured.");
  }

  try {
    const upstream = await fetch(`${OFFRAMP_BASE_URL}/withdrawals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OFFRAMP_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = (await upstream.json()) as unknown;
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[offramp] withdrawal proxy error", err);
    sendError(res, 502, "OFFRAMP_PROXY_ERROR", "Failed to reach offramp provider.");
  }
});

/** GET /api/offramp/transactions/:txId — proxy transaction status */
offrampRouter.get("/transactions/:txId", async (req, res) => {
  if (!OFFRAMP_API_KEY) {
    return sendError(res, 503, "OFFRAMP_UNAVAILABLE", "Offramp service not configured.");
  }

  const { txId } = req.params;

  try {
    const upstream = await fetch(
      `${OFFRAMP_BASE_URL}/transactions/${encodeURIComponent(txId)}`,
      {
        headers: {
          Authorization: `Bearer ${OFFRAMP_API_KEY}`,
        },
      },
    );

    const data = (await upstream.json()) as unknown;
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[offramp] status proxy error", err);
    sendError(res, 502, "OFFRAMP_PROXY_ERROR", "Failed to reach offramp provider.");
  }
});

export default offrampRouter;
