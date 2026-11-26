// src/middleware/auth.js
// ─────────────────────────────────────────────────────────────
// This middleware runs BEFORE every request to /v1/chat/completions.
// Responsibilities:
//   1. Extract the virtual key from the Authorization header
//   2. Look it up in the DB (validate it exists and is active)
//   3. Check if the caller is over their budget
//   4. If all good, attach the key record to req.virtualKey → next()
//
// WHY enforce budgets here (at the gateway) instead of trusting callers?
//   → Zero-trust principle: callers are untrusted clients.
//     If budget checks were client-side, anyone could just ignore them.
//     The gateway is the single enforcement point — there is no other.
// ─────────────────────────────────────────────────────────────
const pool = require('../db/client');

async function authMiddleware(req, res, next) {
  // ── Step 1: Extract the key ───────────────────────────────
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or malformed Authorization header.',
      hint: 'Use: Authorization: Bearer vk_your_key_here',
    });
  }

  const virtualKey = authHeader.slice(7).trim(); // remove "Bearer "

  // ── Step 2: Look up the key in DB ─────────────────────────
  let keyRecord;
  try {
    const result = await pool.query(
      'SELECT * FROM virtual_keys WHERE key = $1',
      [virtualKey]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    keyRecord = result.rows[0];
  } catch (err) {
    console.error('[Auth] DB error during key lookup:', err.message);
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }

  // ── Step 3: Check if the key is active ───────────────────
  if (!keyRecord.is_active) {
    return res.status(403).json({ error: 'This API key has been disabled.' });
  }

  // ── Step 4: Check budget ──────────────────────────────────
  // We use parseFloat because PostgreSQL DECIMAL comes back as a string in node-pg
  const currentSpend = parseFloat(keyRecord.current_spend);
  const budgetLimit  = parseFloat(keyRecord.budget_limit);

  if (currentSpend >= budgetLimit) {
    return res.status(429).json({
      error: 'Budget limit exceeded.',
      budget_limit_usd: budgetLimit,
      current_spend_usd: currentSpend,
      hint: 'Contact the administrator to increase your budget.',
    });
  }

  // ── Step 5: Attach key record to request and continue ─────
  // Now every downstream handler knows who is calling
  req.virtualKey = keyRecord;
  next();
}

module.exports = authMiddleware;
