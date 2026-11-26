# AI-LOG.md

## AI Tools Used

**Antigravity (Claude Sonnet)** — used throughout for initial scaffolding and boilerplate generation. I directed the architecture and reviewed every file.

---

## What I Used AI For

Generating the initial structure of route handlers and middleware — the kind of repetitive Express boilerplate that's tedious to write from scratch. It saved me maybe 2 hours on the mechanical parts.

I didn't use it for:
- Architecture decisions (those are in DECISIONS.md and are mine)
- Database schema design
- The concurrency analysis
- Debugging the actual failures

---

## Where AI Got It Wrong

### 1. Groq model name
AI generated `llama-3.3-70b-versatile` as the default model. When I ran it, Groq returned:

```json
{ "error": { "message": "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it." } }
```

I checked the live Groq API (`GET /openai/v1/models`) and found the available chat models. Switched to `qwen/qwen3.8-27b` which works on the free tier.

### 2. Gemini model deprecation
AI wrote `gemini-1.5-flash` as the fallback model. The API rejected it:

```
"models/gemini-1.5-flash is not found for API version v1beta"
```

The error message itself told me to use `gemini-3.8-flash`. I updated the model and confirmed the endpoint still works.

### 3. Gemini role mapping
AI wrote the message conversion using `role: msg.role` directly. Gemini doesn't accept `"assistant"` — it uses `"model"`. This caused a 400 error on the first real test. Fixed:

```js
role: msg.role === 'assistant' ? 'model' : 'user'
```

### 4. DECIMAL type from node-pg
AI's budget check used `>=` to compare `keyRecord.current_spend` and `keyRecord.budget_limit` directly. PostgreSQL returns DECIMAL columns as strings in node-pg, so `"0.5" >= "1.00"` evaluates as a string comparison, not numeric.

The comparison silently broke for any spend value whose string is lexicographically larger than the limit string (e.g., `"9" > "10"` is `true` as a string). Fixed by wrapping both values in `parseFloat()`.

### 5. Supabase connection — IPv6
AI generated a direct connection string (`db.akexapgzaliyftcqsqej.supabase.co`). My Supabase project is IPv6-only, and my local network doesn't support IPv6 outbound. Got `ENOTFOUND`. 

Fixed by switching to Supabase's Session Pooler URL (`aws-1-ap-northeast-1.pooler.supabase.com:5432`) which has IPv4 addresses.

---

## Parts I Verified Manually

**Budget enforcement** — created a key with a $0.000001 budget, confirmed it rejected immediately with 429. Created a normal key, made several requests, confirmed `current_spend` incremented correctly in the DB after each call.

**Secret handling** — confirmed `.gitignore` excludes `.env` before the first push. Verified no API keys appear anywhere in the HTTP responses. Environment variables on Render are injected at runtime, not embedded in the build.

**Fallback** — temporarily set `GROQ_API_KEY` to an invalid string locally, confirmed the response came back from Gemini with `status: "fallback"` in the `_gateway` metadata.

**DB transactions** — added a deliberate error in the UPDATE to verify the ROLLBACK fires correctly and doesn't partially commit.

---

## What I Learned

The PostgreSQL string vs number bug (item 4 above) is a real gotcha with node-pg that I hadn't hit before. It's the kind of thing that would pass code review and only surface in edge cases — like a user whose spend happens to have a certain digit pattern that sorts differently as a string.

The IPv6-only Supabase DB was also new to me. Direct connections work from cloud hosts (Render has IPv6 support) but fail from many residential ISPs in India that don't support IPv6 egress. The session pooler exists specifically for this scenario.
