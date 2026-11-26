// src/routes/chat.js
// ─────────────────────────────────────────────────────────────
// POST /v1/chat/completions
//
// This is the MAIN route — the core of the entire gateway.
// It is OpenAI-compatible: clients that work with OpenAI can point
// their base URL here and it just works.
//
// Request flow:
//   1. auth middleware already validated the key and attached req.virtualKey
//   2. We validate the request body
//   3. We call the LLM (with fallback)
//   4. We log usage to DB
//   5. We return the response in OpenAI format
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

const { callLLMWithFallback } = require('../services/llm');
const { logUsage }             = require('../services/logger');

router.post('/', async (req, res) => {
  const { messages, model } = req.body;
  const virtualKey = req.virtualKey.key; // set by auth middleware

  // ── Validate request body ─────────────────────────────────
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'Request body must include a non-empty "messages" array.',
      example: { messages: [{ role: 'user', content: 'Hello!' }] },
    });
  }

  // Basic message format validation
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({
        error: 'Each message must have "role" and "content" fields.',
      });
    }
    if (!['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).json({
        error: `Invalid role "${msg.role}". Must be "user", "assistant", or "system".`,
      });
    }
  }

  // ── Call LLM with fallback ────────────────────────────────
  let llmResult;
  try {
    llmResult = await callLLMWithFallback(messages, model);
  } catch (err) {
    // Both providers failed — log it and return 503
    if (err.allFailed) {
      // Log a failed attempt (cost = 0, tokens = 0)
      await logUsage(virtualKey, { model: 'unknown', provider: 'none', promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs: 0 }, 'error', err.message);

      return res.status(503).json({
        error: 'All LLM providers are currently unavailable. Please try again later.',
        primary_error:  err.primaryError,
        fallback_error: err.fallbackError,
      });
    }
    // Unexpected error
    console.error('[Chat Route] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }

  // ── Log usage to DB ───────────────────────────────────────
  // We await this BEFORE sending the response to ensure the spend
  // is recorded. If we fired-and-forgot, a crash could cause unlogged spend.
  await logUsage(virtualKey, llmResult, llmResult.status);

  // ── Return OpenAI-compatible response ─────────────────────
  // We always return in OpenAI format regardless of which provider was used.
  // This means clients never need to change their parsing code.
  return res.status(200).json({
    // OpenAI-standard fields
    ...llmResult.rawResponse,
    // Gateway metadata (extra fields our gateway adds — harmless to clients)
    _gateway: {
      provider:    llmResult.provider,
      status:      llmResult.status,
      cost_usd:    llmResult.cost,
      latency_ms:  llmResult.latencyMs,
      ...(llmResult.status === 'fallback' && { primary_error: llmResult.primaryError }),
    },
  });
});

module.exports = router;
