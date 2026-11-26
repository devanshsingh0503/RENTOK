const pool = require('../db/client');

async function logUsage(virtualKey, llmResult, status, errorMsg = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO usage_logs
        (virtual_key, model, provider, prompt_tokens, completion_tokens,
         total_tokens, cost_usd, latency_ms, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        virtualKey,
        llmResult.model            || 'unknown',
        llmResult.provider         || 'unknown',
        llmResult.promptTokens     || 0,
        llmResult.completionTokens || 0,
        llmResult.totalTokens      || 0,
        llmResult.cost             || 0,
        llmResult.latencyMs        || 0,
        status,
        errorMsg,
      ]
    );

    await client.query(
      `UPDATE virtual_keys
       SET current_spend = current_spend + $1,
           request_count = request_count + 1
       WHERE key = $2`,
      [llmResult.cost || 0, virtualKey]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Usage log failed (non-fatal):', err.message);
  } finally {
    client.release();
  }
}

module.exports = { logUsage };
