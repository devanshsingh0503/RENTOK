const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool     = require('../db/client');

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden: invalid admin secret' });
  }
  next();
}

// Create a new virtual key
router.post('/keys', requireAdmin, async (req, res) => {
  const { name, budget_limit } = req.body;

  if (!budget_limit || isNaN(budget_limit) || parseFloat(budget_limit) <= 0) {
    return res.status(400).json({
      error: 'budget_limit is required and must be a positive number (USD)',
      example: { name: 'my-service', budget_limit: 5.00 },
    });
  }

  const key = 'vk_' + uuidv4().replace(/-/g, '').slice(0, 24);

  try {
    const result = await pool.query(
      `INSERT INTO virtual_keys (key, name, budget_limit)
       VALUES ($1, $2, $3)
       RETURNING id, key, name, budget_limit, current_spend, is_active, created_at`,
      [key, name || 'Unnamed', parseFloat(budget_limit)]
    );

    return res.status(201).json({
      message: 'Key created',
      key: result.rows[0],
    });
  } catch (err) {
    console.error('Failed to create key:', err.message);
    return res.status(500).json({ error: 'Failed to create key' });
  }
});

// List all virtual keys
router.get('/keys', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, key, name, budget_limit, current_spend, request_count, is_active, created_at
       FROM virtual_keys ORDER BY created_at DESC`
    );
    return res.json({ keys: result.rows, total: result.rows.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list keys' });
  }
});

// Disable / enable a key
router.patch('/keys/:key', requireAdmin, async (req, res) => {
  const { is_active, budget_limit } = req.body;
  const updates = [];
  const values  = [];

  if (typeof is_active === 'boolean') {
    values.push(is_active);
    updates.push(`is_active = $${values.length}`);
  }

  if (budget_limit !== undefined && !isNaN(budget_limit) && parseFloat(budget_limit) > 0) {
    values.push(parseFloat(budget_limit));
    updates.push(`budget_limit = $${values.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Provide is_active (bool) or budget_limit (number) to update' });
  }

  values.push(req.params.key);
  try {
    const result = await pool.query(
      `UPDATE virtual_keys SET ${updates.join(', ')} WHERE key = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });
    return res.json({ message: 'Key updated', key: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update key' });
  }
});

// Reset spend for a key
router.post('/keys/:key/reset', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE virtual_keys SET current_spend = 0, request_count = 0 WHERE key = $1 RETURNING *`,
      [req.params.key]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });
    return res.json({ message: 'Spend reset to zero', key: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset key' });
  }
});

module.exports = router;
