// src/index.js
// ─────────────────────────────────────────────────────────────
// Entry point. Sets up Express, registers all routes and middleware,
// verifies DB connectivity, and starts listening.
// ─────────────────────────────────────────────────────────────
require('dotenv').config(); // Load .env file (only matters locally; Render uses its own env vars)

const express = require('express');
const pool    = require('./db/client');

const authMiddleware = require('./middleware/auth');
const chatRoutes     = require('./routes/chat');
const usageRoutes    = require('./routes/usage');
const adminRoutes    = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Global Middleware ─────────────────────────────────────────
app.use(express.json()); // Parse JSON request bodies

// Simple request logger so you can see what's coming in
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ───────────────────────────────────────────────────

// Health check — no auth needed
// Deployment platforms ping this to know the service is alive
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1'); // quick DB connectivity check
    res.status(200).json({
      status:    'ok',
      service:   'llm-gateway',
      timestamp:  new Date().toISOString(),
      database:  'connected',
    });
  } catch (err) {
    res.status(503).json({
      status:   'degraded',
      database: 'disconnected',
      error:    err.message,
    });
  }
});

// Main chat completions endpoint — protected by auth middleware
// The auth middleware runs first, then the route handler
app.use('/v1/chat/completions', authMiddleware, chatRoutes);

// Usage dashboard — no auth needed (key itself is the identifier)
app.use('/usage', usageRoutes);

// Admin route — protected by X-Admin-Secret header
app.use('/admin', adminRoutes);

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found.',
    available_routes: [
      'GET  /health',
      'POST /v1/chat/completions  (requires Authorization: Bearer vk_xxx)',
      'GET  /usage?key=vk_xxx',
      'POST /admin/keys           (requires X-Admin-Secret header)',
    ],
  });
});

// ── Global Error Handler ──────────────────────────────────────
// Catches any unhandled errors that bubble up from route handlers
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'An unexpected error occurred.', message: err.message });
});

// ── Start Server ──────────────────────────────────────────────
async function start() {
  // Test DB connection before accepting traffic
  try {
    await pool.query('SELECT 1');
    console.log('[Startup] ✅ Database connected');
  } catch (err) {
    console.error('[Startup] ❌ Database connection failed:', err.message);
    console.error('[Startup] Make sure DATABASE_URL is set correctly in your .env file');
    process.exit(1); // crash early with a clear error rather than silently fail later
  }

  app.listen(PORT, () => {
    console.log(`[Startup] ✅ LLM Gateway running on http://localhost:${PORT}`);
    console.log(`[Startup]    Health: http://localhost:${PORT}/health`);
    console.log(`[Startup]    Chat:   POST http://localhost:${PORT}/v1/chat/completions`);
    console.log(`[Startup]    Usage:  GET  http://localhost:${PORT}/usage?key=vk_xxx`);
  });
}

start();
