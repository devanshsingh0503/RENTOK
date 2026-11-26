// src/services/logger.js
// ─────────────────────────────────────────────────────────────
// After every LLM call, we need to:
//   1. Record a row in usage_logs (immutable audit trail)
//   2. Update virtual_keys to increment current_spend + request_count
//
// CONCURRENCY / RACE CONDITION explanation:
//   Problem: If two requests hit the same key simultaneously when it has
//   e.g. $0.001 left, BOTH could pass the budget check in auth.js at the
//   same time (both see current_spend < budget_limit), and BOTH get
//   forwarded to the LLM. This would exceed the budget.
//
//   Our mitigation: We use a PostgreSQL transaction with an atomic UPDATE.
//   The UPDATE uses `current_spend + $1` which is applied atomically by
//   PostgreSQL — the DB locks the row during the UPDATE, so concurrent
//   updates are serialized. This doesn't prevent both requests from being
//   forwarded (we'd need SELECT FOR UPDATE in auth for that), but it
//   ensures the spend is recorded accurately.
//
//   A more robust solution (noted in DECISIONS.md as a known limitation):
//   Use SELECT FOR UPDATE in auth.js to lock the row during the budget
//   check, preventing both requests from passing simultaneously.
//   We document this tradeoff explicitly.
// ─────────────────────────────────────────────────────────────
const pool = require('../db/client');

/**
 * Log a completed LLM request and update the virtual key's spend.
 * This runs AFTER the response is returned to the caller (non-blocking from caller's view,
 * but we await it here to ensure consistency before the HTTP response is sent).
 *
 * @param {string} virtualKey - The virtual API key string (e.g. "vk_abc123")
 * @param {object} llmResult  - Result object from llm.js
 * @param {string} status     - 'success', 'fallback', or 'error'
 * @param {string} [errorMsg] - Error message if status === 'error'
 */
async function logUsage(virtualKey, llmResult, status, errorMsg = null) {
  // Use a transaction so both the INSERT and UPDATE succeed or fail together
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Insert into usage_logs ─────────────────────────
    await client.query(
      `INSERT INTO usage_logs
        (virtual_key, model, provider, prompt_tokens, completion_tokens, total_tokens,
         cost_usd, latency_ms, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        virtualKey,
        llmResult.model             || 'unknown',
        llmResult.provider          || 'unknown',
        llmResult.promptTokens      || 0,
        llmResult.completionTokens  || 0,
        llmResult.totalTokens       || 0,
        llmResult.cost              || 0,
        llmResult.latencyMs         || 0,
        status,
        errorMsg,
      ]
    );

    // ── 2. Update virtual_keys spend + request count ──────
    // This UPDATE is atomic at the DB level — concurrent updates are safe
    await client.query(
      `UPDATE virtual_keys
       SET current_spend  = current_spend  + $1,
           request_count  = request_count  + 1
       WHERE key = $2`,
      [llmResult.cost || 0, virtualKey]
    );

    await client.query('COMMIT');
    console.log(`[Logger] Logged usage for key ${virtualKey}: $${llmResult.cost} (${llmResult.totalTokens} tokens)`);
  } catch (err) {
    await client.query('ROLLBACK');
    // We log the error but DON'T throw — a logging failure shouldn't crash the response
    console.error('[Logger] Failed to log usage:', err.message);
  } finally {
    client.release(); // always return the connection to the pool
  }
}

module.exports = { logUsage };
