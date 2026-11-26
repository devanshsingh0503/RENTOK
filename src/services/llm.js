// src/services/llm.js
// ─────────────────────────────────────────────────────────────
// Handles all communication with LLM providers.
//
// DESIGN DECISIONS explained here:
//
// 1. NON-STREAMING chosen deliberately:
//    - We need the EXACT token counts (prompt_tokens, completion_tokens)
//      to calculate cost accurately before logging.
//    - With streaming (SSE chunks), you'd have to buffer all chunks,
//      reassemble them, and tokens often aren't reported until the last chunk.
//    - Non-streaming gives us the full response object in one shot,
//      including response.usage — clean and reliable.
//
// 2. FALLBACK STRATEGY:
//    - Primary: Groq (qwen/qwen3.8-27b) — fast, free, great for most queries
//    - Fallback: Google Gemini (gemini-3.8-flash) — different infrastructure, so if Groq is down,
//      Gemini is likely still up. Using two providers = resilience.
//    - If BOTH fail, we return a 503 with a clear error — no silent failures.
//
// 3. TIMEOUT:
//    - We set a 15-second timeout on each provider call.
//    - If Groq doesn't respond in 15s, we don't wait — we try Gemini immediately.
//    - This prevents the caller from waiting indefinitely.
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

// ── Cost per 1000 tokens in USD (approximate, update as pricing changes) ──
const PRICING = {
  'qwen/qwen3.8-27b': { prompt: 0.00029, completion: 0.00049 }, // Groq (Qwen3.8)
  'gemini-3.8-flash': { prompt: 0.000075, completion: 0.0003 }, // Gemini
};

/**
 * Calculate cost for a request.
 * Formula: (tokens / 1000) * price_per_1k_tokens
 */
function calculateCost(model, promptTokens, completionTokens) {
  const pricing = PRICING[model] || { prompt: 0.001, completion: 0.001 }; // safe default
  const cost =
    (promptTokens    / 1000) * pricing.prompt +
    (completionTokens / 1000) * pricing.completion;
  return parseFloat(cost.toFixed(6)); // round to 6 decimal places (fractions of a cent)
}

/**
 * Call Groq API (Primary Provider)
 * Groq uses an OpenAI-compatible API format — same request/response shape.
 */
async function callGroq(messages, model = 'qwen/qwen3.8-27b') {
  const startTime = Date.now();

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model,
      messages,
      stream: false, // ← explicitly non-streaming
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000, // 15-second timeout
    }
  );

  const latencyMs = Date.now() - startTime;
  const usage = response.data.usage;

  return {
    provider: 'groq',
    model,
    content: response.data.choices[0].message.content,
    promptTokens:     usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens:      usage.total_tokens,
    cost:             calculateCost(model, usage.prompt_tokens, usage.completion_tokens),
    latencyMs,
    rawResponse:      response.data,
  };
}

/**
 * Call Google Gemini API (Fallback Provider)
 * Gemini uses a different API format, so we adapt it here.
 */
async function callGemini(messages) {
  const startTime = Date.now();
  const model = 'gemini-3.8-flash';

  // Convert OpenAI message format → Gemini format
  // OpenAI: [{ role: "user", content: "Hello" }]
  // Gemini: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] }
  const geminiContents = messages.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user', // Gemini uses "model" not "assistant"
    parts: [{ text: msg.content }],
  }));

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { contents: geminiContents },
    {
      headers: { 'Content-Type': 'application/json' },
      params:  { key: process.env.GEMINI_API_KEY },
      timeout: 25000, // Gemini can be slower on some networks
    }
  );

  const latencyMs = Date.now() - startTime;

  // Extract content from Gemini's response structure
  const content    = response.data.candidates[0].content.parts[0].text;
  const usageMeta  = response.data.usageMetadata || {};

  const promptTokens     = usageMeta.promptTokenCount     || 0;
  const completionTokens = usageMeta.candidatesTokenCount || 0;
  const totalTokens      = usageMeta.totalTokenCount      || promptTokens + completionTokens;

  return {
    provider: 'gemini',
    model,
    content,
    promptTokens,
    completionTokens,
    totalTokens,
    cost: calculateCost(model, promptTokens, completionTokens),
    latencyMs,
    // Normalize to OpenAI-style so our route handler doesn't need to care about provider
    rawResponse: {
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
      model,
    },
  };
}

/**
 * Main function: Try Groq first, fall back to Gemini on failure.
 * Returns a unified result object regardless of which provider succeeded.
 */
async function callLLMWithFallback(messages, preferredModel) {
  // ── Try Primary (Groq) ────────────────────────────────────
  try {
    console.log('[LLM] Trying primary provider: Groq');
    const result = await callGroq(messages, preferredModel);
    result.status = 'success';
    return result;
  } catch (primaryError) {
    const reason = primaryError.response?.data?.error?.message || primaryError.message;
    console.warn(`[LLM] Groq failed (${reason}), trying fallback: Gemini`);

    // ── Try Fallback (Gemini) ───────────────────────────────
    try {
      const result = await callGemini(messages);
      result.status = 'fallback'; // mark that fallback was used
      result.primaryError = reason;
      return result;
    } catch (fallbackError) {
      const fallbackReason = fallbackError.response?.data?.error?.message || fallbackError.message;
      console.error(`[LLM] Gemini also failed: ${fallbackReason}`);

      // Both providers failed — throw so the route handler can return 503
      const err = new Error('All LLM providers failed.');
      err.primaryError   = reason;
      err.fallbackError  = fallbackReason;
      err.allFailed      = true;
      throw err;
    }
  }
}

module.exports = { callLLMWithFallback, calculateCost };
