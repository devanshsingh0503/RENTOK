// src/db/client.js
// ─────────────────────────────────────────────────────────────
// Sets up a single shared PostgreSQL connection pool.
// Using a pool (not a single connection) is important:
//   - Pools reuse connections → faster than reconnecting each time
//   - pg's Pool handles reconnection automatically
// ─────────────────────────────────────────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; this disables certificate validation
  // (acceptable for a hobby project, in production use ssl: { ca: ... })
  ssl: { rejectUnauthorized: false },
  max: 10,              // max 10 simultaneous DB connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Quick sanity-check on startup
pool.on('connect', () => {
  console.log('[DB] New client connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
});

module.exports = pool;
