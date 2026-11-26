# AI-LOG.md
# AI Tool Usage Log

> This document records how AI tools (Antigravity / Claude) were used during development,
> where they were wrong, and how I verified the sensitive parts myself.

---

## AI Tools Used

- **Antigravity (Claude Sonnet)** — Primary coding assistant for boilerplate generation,
  architecture discussion, and documentation drafts.

---

## What AI Generated

| Component | AI Role |
|---|---|
| `src/db/client.js` | Generated the Pool setup; I verified SSL config for Supabase |
| `src/middleware/auth.js` | AI drafted; I added the `parseFloat()` fix for DECIMAL strings |
| `src/services/llm.js` | AI generated both provider calls; I tested them manually with curl |
| `src/services/logger.js` | AI generated; I added the ROLLBACK and explained the race condition |
| `src/routes/chat.js` | AI drafted; I added the message validation loop |
| `DECISIONS.md` | I directed the architecture; AI helped with structure and prose |

---

## Where AI Was Wrong / Misleading

### 1. Gemini API format
AI initially generated the Gemini request using the wrong `role` field.
Gemini uses `"model"` where OpenAI uses `"assistant"`. The AI wrote `"assistant"`
which caused a 400 error. I caught this by reading the Gemini API docs and
testing with curl. Fixed in `callGemini()` with the explicit mapping:
```js
role: msg.role === 'assistant' ? 'model' : 'user'
```

### 2. Race condition explanation
AI initially glossed over the budget race condition, suggesting `SELECT FOR UPDATE`
was "fully solving" it. It doesn't — the issue is that the check and the LLM call
are not in the same transaction, so locking during the check still allows two
requests to both pass if they arrive before either one records its cost.
I revised the explanation in DECISIONS.md to reflect the actual limitation honestly.

### 3. Token counting for Gemini
AI assumed Gemini's token counts would be in `response.data.usage` (OpenAI style).
They're actually in `response.data.usageMetadata` with different field names
(`promptTokenCount` vs `prompt_tokens`). I found this by reading the Gemini docs
and adding a `|| 0` fallback for safety.

---

## Sensitive Parts I Verified Manually

### Budget Enforcement
- Tested with a key set to $0.001 budget — confirmed it returned 429 on the next request.
- Tested `current_spend` accumulates correctly across multiple requests by querying
  the DB directly after each call.

### Secret Handling
- Verified `.env` is in `.gitignore` — real keys are never committed to the repo.
- Confirmed Render's environment variable system injects secrets at runtime,
  not build time.
- Tested that the GROQ and GEMINI keys are never echoed back in any API response.

### Fallback Logic
- Temporarily set `GROQ_API_KEY` to an invalid value → confirmed gateway returned
  Gemini's response with `status: "fallback"` in the `_gateway` metadata.
- Set both keys to invalid → confirmed 503 response with both error messages.

---

## What I Learned (That I Didn't Know Before)

1. **PostgreSQL returns DECIMAL as strings in node-pg** — This was a subtle bug:
   `keyRecord.current_spend >= keyRecord.budget_limit` with strings does
   lexicographic comparison, not numeric. `"9" > "10"` is `true` in JS.
   Fixed with `parseFloat()`.

2. **Groq's OpenAI-compatibility** — Groq accepts the exact same request body as
   OpenAI's `/v1/chat/completions`. You just change the base URL and key. This
   is a smart design choice — it means anyone using OpenAI can switch to Groq
   with zero code changes.

3. **Non-streaming for accounting** — Before this project, I assumed streaming was
   always better. I now understand the tradeoff: streaming is better for UX,
   non-streaming is better for accurate token accounting at the gateway layer.
