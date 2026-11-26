const express = require('express');
const router  = express.Router();
const { callLLMWithFallback } = require('../services/llm');
const { logUsage }             = require('../services/logger');

router.post('/', async (req, res) => {
  const { messages, model } = req.body;
  const virtualKey  = req.virtualKey.key;
  const requestId   = req.requestId;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'messages must be a non-empty array',
      example: { messages: [{ role: 'user', content: 'Hello!' }] },
    });
  }

  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({ error: 'Each message requires role and content fields' });
    }
    if (!['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).json({ error: `Invalid role: "${msg.role}". Use user, assistant, or system` });
    }
  }

  let llmResult;
  try {
    llmResult = await callLLMWithFallback(messages, model);
  } catch (err) {
    if (err.allFailed) {
      await logUsage(virtualKey, {
        model: model || 'unknown', provider: 'none',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs: 0,
      }, 'error', err.message);

      return res.status(503).json({
        error: 'All upstream LLM providers are currently unavailable',
        providers_tried: ['groq', 'gemini'],
        requestId,
      });
    }
    console.error('Unexpected error in chat route:', err.message);
    return res.status(500).json({ error: 'Internal server error', requestId });
  }

  await logUsage(virtualKey, llmResult, llmResult.status);

  // Remaining budget after this request
  const remainingBudget = parseFloat(req.virtualKey.budget_limit) -
                          parseFloat(req.virtualKey.current_spend) -
                          llmResult.cost;

  res.setHeader('X-Cost-USD', llmResult.cost);
  res.setHeader('X-Provider', llmResult.provider);
  res.setHeader('X-Latency-MS', llmResult.latencyMs);

  return res.status(200).json({
    ...llmResult.rawResponse,
    _gateway: {
      requestId,
      provider:    llmResult.provider,
      status:      llmResult.status,
      model:       llmResult.model,
      cost_usd:    llmResult.cost,
      latency_ms:  llmResult.latencyMs,
      budget_remaining_usd: parseFloat(remainingBudget.toFixed(6)),
      ...(llmResult.status === 'fallback' && {
        fallback_reason: llmResult.primaryError,
      }),
    },
  });
});

module.exports = router;
