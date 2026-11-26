# DECISIONS.md
# LLM Gateway — Architecture Decisions & Tradeoffs

> This document explains the **why** behind every significant technical choice made
> in building this gateway. This is the most important document in the submission.

---

## System Overview

The LLM Gateway is an HTTP proxy that sits between API consumers (clients) and LLM
providers (Groq, Gemini). No consumer ever holds a real provider key — they hold
virtual keys issued by this gateway.

### Request Lifecycle

```
Client (vk_abc123)
    │
    │  POST /v1/chat/completions
    │  Authorization: Bearer vk_abc123
    ▼
┌─────────────────────────────────────┐
│          Auth Middleware            │
│  1. Extract virtual key from header │
│  2. Query DB: does key exist?       │
│  3. Is key active?                  │
│  4. current_spend >= budget_limit?  │
│     → YES: return 429 immediately   │
│     → NO: attach key record, next() │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│          Chat Route Handler         │
│  1. Validate messages array         │
│  2. Call LLM service                │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│          LLM Service                │
│  Try Groq (primary, 15s timeout)   │
│    → Success: return result         │
│    → Fail: try Gemini (fallback)    │
│      → Success: return result       │
│      → Fail: throw allFailed error  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│          Usage Logger               │
│  DB Transaction:                    │
│  1. INSERT into usage_logs          │
│  2. UPDATE virtual_keys spend       │
│  COMMIT (or ROLLBACK on error)      │
└──────────────┬──────────────────────┘
               │
               ▼
         OpenAI-format JSON response
         (+ _gateway metadata)
```

---

## Decision 1: Non-Streaming vs. Streaming

**Choice:** Non-streaming (`stream: false`)

**Why:**

Streaming (Server-Sent Events) sends tokens one by one as they are generated.
This gives a better user experience in a UI (you see text appearing in real time),
but it creates a serious problem for a gateway that needs to enforce budgets:

- Token counts (`usage.prompt_tokens`, `usage.completion_tokens`) are only reported
  in the **final chunk** of a streaming response — after all the content has been sent.
- This means you would have to either:
  (a) Buffer the entire stream before forwarding it, defeating the purpose of streaming, OR
  (b) Forward chunks as they arrive, then log usage at the very end — meaning the
      budget check at the start could never account for the cost of *this* request,
      only future ones.

Non-streaming gives us the complete `usage` object in a single JSON response.
We know the exact token counts and can calculate cost **before** sending the response.
This is the right choice for accurate budget enforcement.

**Tradeoff acknowledged:** Callers wait longer (full generation before first byte).
For an internal gateway with controlled clients, this is acceptable.

---

## Decision 2: Why Enforce Budgets at the Gateway?

**Short answer:** Zero-trust. Callers are untrusted.

If budget enforcement lived in the client application:
- Any developer could comment out the check.
- A bug could skip the check accidentally.
- A malicious user could bypass it trivially.

The gateway is the **single choke point** through which all LLM traffic flows.
It is controlled by us (the platform team), not by individual callers.
Enforcement at this layer is authoritative — there is no way to bypass it
without also bypassing the gateway entirely, which would require the real
provider key (which only the gateway has).

This is the same reason banks don't let you set your own overdraft limit.

---

## Decision 3: Fallback Strategy

**Choice:** Groq `qwen/qwen3.8-27b` (primary) → Google `gemini-3.8-flash` (fallback) → 503 error

**Why Groq first?**
- Groq's LPU hardware provides extremely low latency (176ms measured in testing).
- The free tier is generous enough for a gateway demo.
- It uses an OpenAI-compatible API format, making integration trivial.
- Model used: `qwen/qwen3.8-27b` — a 27B parameter model available on Groq's free tier.

**Why Gemini as fallback?**
- Gemini runs on entirely different infrastructure (Google Cloud vs. Groq's LPUs).
- If Groq is down (their entire service), Gemini is almost certainly still up.
- Using two providers from different companies maximizes resilience.
- Both have free tiers, so no cost for this implementation.
- Model used: `gemini-3.8-flash` — Google's latest fast model.

**What triggers fallback?**
- HTTP 5xx responses from Groq (provider-side error)
- Timeout (> 15 seconds) — we don't wait indefinitely
- Network errors (DNS failures, connection refused)

**What does NOT trigger fallback?**
- HTTP 4xx from the gateway itself (bad request, budget exceeded) — these are
  client errors, not provider failures.
- If a model name is invalid, we fail fast rather than silently using a different model.

**15-second timeout rationale:**
P99 latency for most LLM calls is under 10 seconds for short-to-medium prompts.
15 seconds gives a comfortable buffer while preventing indefinite hangs.

---

## Decision 4: Concurrency & the Race Condition

**The Problem:**

Suppose Key X has $0.001 budget remaining.
Two requests arrive simultaneously:

```
Request A:  reads current_spend = $0.999  → budget_limit = $1.00  → PASSES check
Request B:  reads current_spend = $0.999  → budget_limit = $1.00  → PASSES check
                        ↓                              ↓
              Both get forwarded to LLM          Both get forwarded to LLM
              Both log $0.001 cost               Both log $0.001 cost
                        ↓                              ↓
              current_spend becomes $1.001 ← over budget!
```

**Current mitigation:**

The `UPDATE` in logger.js uses `current_spend = current_spend + $1` which is
an atomic operation at the PostgreSQL row level. The two UPDATEs are serialized
by PostgreSQL's row-level locking — so the spend is recorded correctly ($1.001),
just slightly over budget.

**Known limitation:**

The budget check in auth.js and the UPDATE in logger.js are not in the same
transaction. This means both requests can PASS the check before either records
their cost — the atomic UPDATE only ensures accurate accounting, not prevention.

**More robust solution (not implemented, but designed):**

Use `SELECT FOR UPDATE` in auth.js:
```sql
SELECT * FROM virtual_keys WHERE key = $1 FOR UPDATE
```
This would lock the row during the budget check, so Request B would wait until
Request A's transaction commits (with its spend update) before reading the balance.
This is the correct solution for financial-grade accuracy.

**Why not implemented here?**

It adds connection hold time and can create lock contention at high throughput.
For this assignment's scale, the current approach is acceptable. The tradeoff is
documented explicitly — which is more important than blindly implementing the
complex version without understanding it.

---

## Decision 5: PostgreSQL over SQLite

**Choice:** PostgreSQL (Supabase free tier)

**Why not SQLite?**
- SQLite is file-based and single-writer. Under concurrent requests, writes queue up.
- SQLite doesn't support `FOR UPDATE` row locking well (would need WAL mode + careful
  configuration).
- Deployment platforms like Render use ephemeral filesystems — an SQLite file
  would be wiped on every redeploy, losing all keys and logs.

**Why PostgreSQL?**
- True concurrent reads and writes with row-level locking.
- Persistent: data lives in Supabase, not on the server.
- Native DECIMAL type for accurate financial calculations (floats lose precision
  with money — `0.1 + 0.2 ≠ 0.3` in floating point).
- Production databases are always SQL or similar; this is a realistic choice.

---

## What I Would Do Differently at Scale

If this gateway needed to handle 10,000+ requests/second:

1. **Redis for budget checks** — A Redis INCR + EXPIRE per key would be
   microsecond-fast compared to a DB query on every request. Use DB as the
   source of truth synced periodically.

2. **Async logging** — Fire-and-forget usage logs to a queue (e.g., BullMQ, SQS)
   and drain them in a background worker. This removes DB write latency from
   the critical path.

3. **Connection pooling with PgBouncer** — Our current pool of 10 connections
   would not survive high load.

4. **SELECT FOR UPDATE** — Implement the row-locking budget check for financial
   accuracy under concurrency.

---

## Deliberate Cuts (What I Left Out)

| Feature | Why Cut |
|---|---|
| Streaming responses | Accurate token counting is incompatible with naive streaming |
| Rate limiting (req/sec) | Out of scope; budget is the enforced constraint |
| Key rotation | Unnecessary complexity for the assignment |
| Multi-tenant IAM | Explicitly out of scope per the brief |
| Fancy dashboard UI | A JSON endpoint (`GET /usage`) is sufficient and honest |

---

## Least Confident Decision

The **15-second timeout threshold** is a guess based on general LLM latency
experience. I don't have percentile latency data for Groq specifically.
In production, I'd instrument this with a histogram and tune the timeout to
P95 + a reasonable buffer (e.g., P95 + 5s).

---

## Where the System Breaks

1. **Budget race condition** (see Decision 4) — small overage possible under simultaneous requests near the limit.
2. **If Supabase is down**, the entire gateway is down — there is no DB-less fallback.
3. **Cost estimates are approximate** — pricing formulas are hardcoded and will
   drift as providers change their pricing.
4. **The admin secret is a single shared credential** — if leaked, anyone can create keys.
