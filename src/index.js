require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('./db/client');

const authMiddleware = require('./middleware/auth');
const chatRoutes     = require('./routes/chat');
const usageRoutes    = require('./routes/usage');
const adminRoutes    = require('./routes/admin');
const dashboardRoute = require('./routes/dashboard');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Attach a unique request ID to every request for traceability
app.use((req, res, next) => {
  req.requestId = uuidv4();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Structured request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      type: 'request',
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      ts: new Date().toISOString(),
    }));
  });
  next();
});

// Routes
app.get('/', dashboardRoute);

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as ts');
    res.json({
      status: 'ok',
      service: 'llm-gateway',
      version: '1.0.0',
      database: 'connected',
      dbTime: result.rows[0].ts,
      uptime: Math.floor(process.uptime()) + 's',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'disconnected', error: err.message });
  }
});

app.use('/v1/chat/completions', authMiddleware, chatRoutes);
app.use('/usage', usageRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    docs: 'GET / for API reference',
  });
});

app.use((err, req, res, next) => {
  console.error(JSON.stringify({ type: 'unhandled_error', requestId: req.requestId, message: err.message, stack: err.stack }));
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('Database connection verified');
  } catch (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`LLM Gateway listening on port ${PORT}`);
  });
}

start();
