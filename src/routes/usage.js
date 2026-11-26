// src/routes/usage.js
// ─────────────────────────────────────────────────────────────
// GET /usage?key=vk_xxx
//
// Returns a summary of spend, request count, and recent request logs
// for a specific virtual key. This is the "simple dashboard" the
// assignment asks for — no fancy UI needed.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');

router.get('/', async (req, res) => {
  const { key } = req.query;

  if (!key) {
    return res.status(400).json({
      error: 'Missing query param: ?key=vk_your_key_here',
    });
  }

  try {
    // ── Fetch key summary ───────────────────────────────────
    const keyResult = await pool.query(
      `SELECT name, budget_limit, current_spend, request_count, is_active, created_at
       FROM virtual_keys
       WHERE key = $1`,
      [key]
    );

    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    const keyInfo = keyResult.rows[0];

    // ── Fetch recent logs (last 50) ─────────────────────────
    const logsResult = await pool.query(
      `SELECT model, provider, prompt_tokens, completion_tokens, total_tokens,
              cost_usd, latency_ms, status, error_message, created_at
       FROM usage_logs
       WHERE virtual_key = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [key]
    );

    // ── Aggregate stats ─────────────────────────────────────
    const statsResult = await pool.query(
      `SELECT
         COUNT(*)                               AS total_requests,
         SUM(total_tokens)                      AS total_tokens,
         SUM(cost_usd)                          AS total_cost_usd,
         AVG(latency_ms)                        AS avg_latency_ms,
         COUNT(*) FILTER (WHERE status = 'fallback') AS fallback_count,
         COUNT(*) FILTER (WHERE status = 'error')    AS error_count
       FROM usage_logs
       WHERE virtual_key = $1`,
      [key]
    );

    const stats = statsResult.rows[0];

    return res.status(200).json({
      key: {
        name:              keyInfo.name,
        is_active:         keyInfo.is_active,
        budget_limit_usd:  parseFloat(keyInfo.budget_limit),
        current_spend_usd: parseFloat(keyInfo.current_spend),
        budget_remaining_usd: parseFloat(keyInfo.budget_limit) - parseFloat(keyInfo.current_spend),
        budget_used_pct:   ((parseFloat(keyInfo.current_spend) / parseFloat(keyInfo.budget_limit)) * 100).toFixed(1) + '%',
        request_count:     keyInfo.request_count,
        created_at:        keyInfo.created_at,
      },
      stats: {
        total_requests:  parseInt(stats.total_requests),
        total_tokens:    parseInt(stats.total_tokens) || 0,
        total_cost_usd:  parseFloat(stats.total_cost_usd || 0).toFixed(6),
        avg_latency_ms:  Math.round(parseFloat(stats.avg_latency_ms || 0)),
        fallback_count:  parseInt(stats.fallback_count),
        error_count:     parseInt(stats.error_count),
      },
      recent_logs: logsResult.rows,
    });
  } catch (err) {
    console.error('[Usage Route] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch usage data.' });
  }
});

module.exports = router;
