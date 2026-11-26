const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');

router.get('/', async (req, res) => {
  const { key, limit = 20 } = req.query;

  if (!key) {
    return res.status(400).json({ error: 'Missing required query param: key' });
  }

  try {
    const [keyResult, logsResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT name, budget_limit, current_spend, request_count, is_active, created_at
         FROM virtual_keys WHERE key = $1`,
        [key]
      ),
      pool.query(
        `SELECT model, provider, prompt_tokens, completion_tokens, total_tokens,
                cost_usd, latency_ms, status, error_message, created_at
         FROM usage_logs WHERE virtual_key = $1
         ORDER BY created_at DESC LIMIT $2`,
        [key, Math.min(parseInt(limit), 100)]
      ),
      pool.query(
        `SELECT
           COUNT(*)                                        AS total_requests,
           COALESCE(SUM(total_tokens), 0)                 AS total_tokens,
           COALESCE(SUM(cost_usd), 0)                     AS total_cost_usd,
           COALESCE(AVG(latency_ms), 0)                   AS avg_latency_ms,
           COUNT(*) FILTER (WHERE provider = 'groq')      AS groq_requests,
           COUNT(*) FILTER (WHERE provider = 'gemini')    AS gemini_requests,
           COUNT(*) FILTER (WHERE status = 'fallback')    AS fallback_count,
           COUNT(*) FILTER (WHERE status = 'error')       AS error_count
         FROM usage_logs WHERE virtual_key = $1`,
        [key]
      ),
    ]);

    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }

    const k     = keyResult.rows[0];
    const stats = statsResult.rows[0];
    const budgetLimit   = parseFloat(k.budget_limit);
    const currentSpend  = parseFloat(k.current_spend);

    return res.json({
      key: {
        name:                 k.name,
        is_active:            k.is_active,
        budget_limit_usd:     budgetLimit,
        current_spend_usd:    currentSpend,
        budget_remaining_usd: parseFloat((budgetLimit - currentSpend).toFixed(6)),
        budget_used_pct:      ((currentSpend / budgetLimit) * 100).toFixed(2) + '%',
        request_count:        k.request_count,
        member_since:         k.created_at,
      },
      stats: {
        total_requests:  parseInt(stats.total_requests),
        total_tokens:    parseInt(stats.total_tokens),
        total_cost_usd:  parseFloat(parseFloat(stats.total_cost_usd).toFixed(6)),
        avg_latency_ms:  Math.round(parseFloat(stats.avg_latency_ms)),
        groq_requests:   parseInt(stats.groq_requests),
        gemini_requests: parseInt(stats.gemini_requests),
        fallback_count:  parseInt(stats.fallback_count),
        error_count:     parseInt(stats.error_count),
      },
      recent_requests: logsResult.rows,
    });
  } catch (err) {
    console.error('Usage route error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});

module.exports = router;
