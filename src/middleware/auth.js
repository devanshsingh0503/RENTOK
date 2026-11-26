const pool = require('../db/client');

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing Authorization header',
      expected: 'Authorization: Bearer vk_your_key',
    });
  }

  const virtualKey = authHeader.slice(7).trim();

  let keyRecord;
  try {
    const result = await pool.query(
      'SELECT * FROM virtual_keys WHERE key = $1',
      [virtualKey]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    keyRecord = result.rows[0];
  } catch (err) {
    console.error('Auth DB error:', err.message);
    return res.status(500).json({ error: 'Authentication failed due to a server error' });
  }

  if (!keyRecord.is_active) {
    return res.status(403).json({ error: 'This key has been disabled' });
  }

  const currentSpend = parseFloat(keyRecord.current_spend);
  const budgetLimit  = parseFloat(keyRecord.budget_limit);

  if (currentSpend >= budgetLimit) {
    return res.status(429).json({
      error: 'Budget limit reached',
      budget_limit_usd:  budgetLimit,
      current_spend_usd: currentSpend,
    });
  }

  req.virtualKey = keyRecord;
  next();
}

module.exports = authMiddleware;
