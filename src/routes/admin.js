// src/routes/admin.js
// ─────────────────────────────────────────────────────────────
// POST /admin/keys  — Create a new virtual key
//
// Protected by ADMIN_SECRET header so random people can't create keys.
// In production, this would be a full auth system, but for this
// assignment a simple shared secret is sufficient and honest.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/client');

router.post('/keys', async (req, res) => {
  // ── Admin auth ────────────────────────────────────────────
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Invalid admin secret.' });
  }

  const { name, budget_limit } = req.body;

  if (!budget_limit || isNaN(budget_limit) || budget_limit <= 0) {
    return res.status(400).json({
      error: 'budget_limit is required and must be a positive number (in USD).',
      example: { name: 'my-app', budget_limit: 5.00 },
    });
  }

  // ── Generate a unique virtual key ─────────────────────────
  // Format: vk_ + first 8 chars of a UUID (collision-resistant for our scale)
  const newKey = 'vk_' + uuidv4().replace(/-/g, '').slice(0, 24);

  try {
    const result = await pool.query(
      `INSERT INTO virtual_keys (key, name, budget_limit)
       VALUES ($1, $2, $3)
       RETURNING id, key, name, budget_limit, current_spend, is_active, created_at`,
      [newKey, name || 'Unnamed Key', parseFloat(budget_limit)]
    );

    const created = result.rows[0];

    return res.status(201).json({
      message: 'Virtual key created successfully.',
      key: {
        id:            created.id,
        key:           created.key,
        name:          created.name,
        budget_limit:  parseFloat(created.budget_limit),
        current_spend: parseFloat(created.current_spend),
        is_active:     created.is_active,
        created_at:    created.created_at,
      },
    });
  } catch (err) {
    console.error('[Admin] Failed to create key:', err.message);
    return res.status(500).json({ error: 'Failed to create virtual key.' });
  }
});

module.exports = router;
