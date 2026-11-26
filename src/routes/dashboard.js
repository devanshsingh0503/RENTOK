// Minimal live dashboard served at GET /
// Shows service info and API reference — no frameworks, plain HTML
const pool = require('../db/client');

async function dashboardRoute(req, res) {
  let dbStatus = 'connected';
  let totalRequests = 0;
  let totalKeys = 0;
  let totalCost = '0.000000';

  try {
    const [statsRes, keysRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS reqs, COALESCE(SUM(cost_usd),0) AS cost FROM usage_logs`),
      pool.query(`SELECT COUNT(*) AS keys FROM virtual_keys`),
    ]);
    totalRequests = parseInt(statsRes.rows[0].reqs);
    totalCost     = parseFloat(statsRes.rows[0].cost).toFixed(6);
    totalKeys     = parseInt(keysRes.rows[0].keys);
  } catch {
    dbStatus = 'error';
  }

  const uptime = formatUptime(process.uptime());

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>LLM Gateway</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;padding:2rem}
    .container{max-width:900px;margin:0 auto}
    header{margin-bottom:2.5rem}
    h1{font-size:1.6rem;font-weight:700;color:#fff;letter-spacing:-0.5px}
    h1 span{color:#6366f1}
    .subtitle{color:#94a3b8;margin-top:.35rem;font-size:.9rem}
    .badge{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .75rem;border-radius:9999px;font-size:.75rem;font-weight:600}
    .badge.ok{background:#052e16;color:#4ade80;border:1px solid #166534}
    .badge.error{background:#450a0a;color:#f87171;border:1px solid #991b1b}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;margin-bottom:2rem}
    .stat{background:#1e2130;border:1px solid #2d3148;border-radius:.75rem;padding:1.1rem 1.25rem}
    .stat-value{font-size:1.6rem;font-weight:700;color:#fff;line-height:1}
    .stat-label{font-size:.75rem;color:#94a3b8;margin-top:.4rem;text-transform:uppercase;letter-spacing:.05em}
    .section{background:#1e2130;border:1px solid #2d3148;border-radius:.75rem;padding:1.5rem;margin-bottom:1.25rem}
    .section h2{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:1rem}
    .endpoint{display:flex;align-items:flex-start;gap:.75rem;padding:.75rem 0;border-bottom:1px solid #2d3148}
    .endpoint:last-child{border-bottom:none;padding-bottom:0}
    .method{font-size:.7rem;font-weight:700;padding:.2rem .5rem;border-radius:.3rem;min-width:48px;text-align:center;flex-shrink:0;margin-top:2px}
    .get{background:#0c2a4a;color:#60a5fa}.post{background:#1a1a4a;color:#818cf8}.patch{background:#1a3a1a;color:#4ade80}
    .path{font-family:'Courier New',monospace;font-size:.85rem;color:#e2e8f0}
    .desc{font-size:.8rem;color:#94a3b8;margin-top:.2rem}
    .code-block{background:#0f1117;border:1px solid #2d3148;border-radius:.5rem;padding:1rem;font-family:'Courier New',monospace;font-size:.78rem;color:#94a3b8;overflow-x:auto;white-space:pre;margin-top:.75rem;line-height:1.6}
    .tag{display:inline-block;background:#1e2130;border:1px solid #2d3148;border-radius:.3rem;padding:.1rem .4rem;font-family:monospace;font-size:.75rem;color:#a5b4fc}
    footer{text-align:center;color:#475569;font-size:.75rem;margin-top:2rem}
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>LLM <span>Gateway</span></h1>
    <div class="subtitle">OpenAI-compatible proxy · Virtual keys · Budget enforcement · Fallback routing</div>
    <div style="margin-top:.75rem">
      <span class="badge ${dbStatus === 'connected' ? 'ok' : 'error'}">
        ${dbStatus === 'connected' ? '● Live' : '● Degraded'}
      </span>
      <span style="color:#475569;font-size:.8rem;margin-left:.75rem">uptime ${uptime}</span>
    </div>
  </header>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${totalRequests.toLocaleString()}</div>
      <div class="stat-label">Total Requests</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalKeys}</div>
      <div class="stat-label">Virtual Keys</div>
    </div>
    <div class="stat">
      <div class="stat-value">$${totalCost}</div>
      <div class="stat-label">Total Spend (USD)</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="color:#4ade80">Groq</div>
      <div class="stat-label">Primary Provider</div>
    </div>
  </div>

  <div class="section">
    <h2>Endpoints</h2>
    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="path">/health</div>
        <div class="desc">Service health check — database connectivity + uptime</div>
      </div>
    </div>
    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="path">/v1/chat/completions</div>
        <div class="desc">OpenAI-compatible LLM proxy. Requires <span class="tag">Authorization: Bearer vk_xxx</span></div>
      </div>
    </div>
    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="path">/usage?key=vk_xxx</div>
        <div class="desc">Spend summary, token counts, latency stats, and recent request log for a key</div>
      </div>
    </div>
    <div class="endpoint">
      <span class="method post">POST</span>
      <div>
        <div class="path">/admin/keys</div>
        <div class="desc">Create a virtual key with a USD budget. Requires <span class="tag">X-Admin-Secret</span></div>
      </div>
    </div>
    <div class="endpoint">
      <span class="method get">GET</span>
      <div>
        <div class="path">/admin/keys</div>
        <div class="desc">List all virtual keys. Requires <span class="tag">X-Admin-Secret</span></div>
      </div>
    </div>
    <div class="endpoint">
      <span class="method patch">PATCH</span>
      <div>
        <div class="path">/admin/keys/:key</div>
        <div class="desc">Enable/disable a key or update its budget. Requires <span class="tag">X-Admin-Secret</span></div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Quick Start</h2>
<div class="code-block"># 1. Create a virtual key
curl -X POST ${req.protocol}://${req.headers.host}/admin/keys \\
  -H "Content-Type: application/json" \\
  -H "X-Admin-Secret: &lt;admin_secret&gt;" \\
  -d '{"name":"my-app","budget_limit":5.00}'

# 2. Call the LLM
curl -X POST ${req.protocol}://${req.headers.host}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer vk_&lt;your_key&gt;" \\
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'

# 3. Check spend
curl "${req.protocol}://${req.headers.host}/usage?key=vk_&lt;your_key&gt;"</div>
  </div>

  <div class="section">
    <h2>Provider Routing</h2>
    <div class="endpoint">
      <span class="method post" style="background:#0c2a4a;color:#60a5fa">1st</span>
      <div>
        <div class="path">Groq — qwen/qwen3.8-27b</div>
        <div class="desc">Primary. 15s timeout. LPU-accelerated, sub-300ms typical latency.</div>
      </div>
    </div>
    <div class="endpoint">
      <span class="method post" style="background:#1a1a2e;color:#818cf8">2nd</span>
      <div>
        <div class="path">Google Gemini — gemini-3.8-flash</div>
        <div class="desc">Fallback. Activated automatically on Groq timeout or 5xx error.</div>
      </div>
    </div>
  </div>

  <footer>
    LLM Gateway · Built for RentOk Backend Intern Assignment ·
    <a href="https://github.com/devanshsingh0503/RENTOK" style="color:#6366f1;text-decoration:none">GitHub</a>
  </footer>
</div>
</body>
</html>`);
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = dashboardRoute;
