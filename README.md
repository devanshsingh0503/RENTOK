# LLM Gateway

A minimal production-grade LLM Gateway built for the RentOk Backend Intern take-home assignment.

## What it does
- Issues virtual API keys (callers never hold real provider keys)
- Enforces per-key budget limits (USD)
- Logs every request with token counts, cost, and latency
- Routes to Groq (primary) with automatic Gemini fallback
- OpenAI-compatible API format

## Live URL
> https://llm-gateway-xxxx.onrender.com  ← (replace after deployment)

## Quick Test

```bash
# 1. Create a virtual key
curl -X POST https://your-url.onrender.com/admin/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: your_admin_secret" \
  -d '{ "name": "test-key", "budget_limit": 1.00 }'

# 2. Use the key to call the LLM
curl -X POST https://your-url.onrender.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer vk_REPLACE_WITH_YOUR_KEY" \
  -d '{
    "messages": [{ "role": "user", "content": "Say hello in one sentence." }]
  }'

# 3. Check usage
curl "https://your-url.onrender.com/usage?key=vk_REPLACE_WITH_YOUR_KEY"

# 4. Health check
curl https://your-url.onrender.com/health
```

## Local Setup

```bash
git clone <your-repo>
cd llm-gateway
npm install
cp .env.example .env
# Edit .env with your real keys
npm run dev
```

## Stack
- Node.js + Express
- PostgreSQL (Supabase)
- Groq (primary LLM) + Google Gemini Flash (fallback)
- Deployed on Render.com

## See Also
- [DECISIONS.md](./DECISIONS.md) — Architecture decisions and tradeoffs
- [AI-LOG.md](./AI-LOG.md) — AI tool usage log
- [db/schema.sql](./db/schema.sql) — Database schema
