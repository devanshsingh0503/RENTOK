# DECISIONS.md

## LLM Gateway — Architecture & Design Decisions

This document explains the thinking behind the key decisions I made while building the gateway. I've tried to be honest about tradeoffs and limitations rather than just defending every choice.

---

## How a Request Flows Through the System

```
Client
  │  POST /v1/chat/completions
  │  Authorization: Bearer vk_xxx
  ▼
Auth Middleware
  ├─ Is the key valid and active?         → 401 if not
  ├─ Has it exceeded its budget?          → 429 if yes
  └─ Attach key record to req → next()
  ▼
Chat Route
  ├─ Validate messages array
  └─ Call LLM service
  ▼
LLM Service
  ├─ Try Groq (qwen/qwen3.8-27b, 15s timeout)
  │    Success → return result
  │    Fail    → try Gemini
  ├─ Try Gemini (gemini-3.8-flash, 25s timeout)
  │    Success → return result (status: "fallback")
  │    Fail    → throw allFailed error
  └─ 503 if both fail
  ▼
Usage Logger (DB transaction)
  ├─ INSERT into usage_logs
  └─ UPDATE virtual_keys.current_spend
  ▼
OpenAI-format JSON response (+ _gateway metadata)
```

---

## Decision 1: Non-Streaming

I went with non-streaming (`stream: false`) and I think it's the only honest choice for a budget-enforcing gateway.

The token counts you need to calculate cost (`usage.prompt_tokens`, `usage.completion_tokens`) only appear in the final response object. With streaming, those numbers don't arrive until the last SSE chunk — after all the content has already been sent to the client. That means you either:

(a) Buffer the whole stream before forwarding it — which eliminates every benefit of streaming, or  
(b) Forward chunks as they arrive and log usage at the end — but then the budget check at the start has no way to account for the cost of *this* request, only future ones.

Non-streaming keeps the accounting clean: one response, exact token counts, one log entry. The tradeoff is that callers wait longer before getting the first byte. For an internal API gateway with controlled clients, that's a reasonable tradeoff.

If I were building this for a user-facing product, I'd look at pre-estimating cost from input tokens and doing a provisional hold, then adjusting on completion. That's significantly more complex.

---

## Decision 2: Budget Enforcement at the Gateway Layer

The question of *where* to enforce budgets seems obvious until you think about the alternative.

If budget enforcement lived in the client application, any developer (or attacker) could bypass it by commenting out one check or just not calling it. The real provider key would still be in their environment and they could call it directly.

By enforcing at the gateway, we establish a single authoritative choke point. The client only has a virtual key — a meaningless token without the gateway. The real provider keys never leave our server. Even if a client's code is fully compromised, the worst they can do is exhaust their own budget, not ours.

This is the same reason a bank controls your spending limit server-side rather than trusting your phone app to enforce it.

---

## Decision 3: Fallback Strategy (Groq → Gemini)

**Why Groq first?**

Groq's LPU hardware is genuinely fast — in my testing I saw ~170–300ms end-to-end latency on short prompts. It uses an OpenAI-compatible API, so the integration is a straight base-URL swap. The free tier is generous enough for a demo.

Model: `qwen/qwen3.8-27b` — a 27B parameter model, strong reasoning, available on Groq's free tier.

**Why Gemini as the fallback?**

The key design principle is *infrastructure diversity*. If I used two Groq models, a Groq outage takes both out simultaneously. By using Google's Gemini, I'm hedging against a full provider failure.

Model: `gemini-3.8-flash` — fast, cheap, different infrastructure.

**What triggers the fallback?**
- Groq returns a 5xx error
- Groq times out (> 15 seconds)
- Any network-level failure connecting to Groq

**What doesn't trigger it:**
- 4xx errors from the gateway itself (bad input, budget exceeded) — those are client errors, not provider failures
- If a specific model name is invalid, I fail fast rather than silently routing to a different model

**15-second timeout:**
Based on observed P99 latencies for short-to-medium prompts. Long enough to be generous, short enough to prevent the caller from waiting indefinitely on a hanging connection. I'd tune this with actual percentile data in production.

---

## Decision 4: The Concurrency Problem

This is the most interesting edge case in the whole project, and I want to be honest about where my current solution falls short.

**The scenario:**

Key X has $0.001 budget remaining. Two requests arrive at exactly the same moment.

Both hit `auth.js` simultaneously. Both read `current_spend < budget_limit`. Both pass. Both get forwarded to the LLM. Both come back and each tries to log $0.001 of spend.

The atomic `UPDATE current_spend = current_spend + $1` in my logger ensures the final DB value is accurate ($1.001) — PostgreSQL serializes row-level writes. But it doesn't *prevent* both requests from passing the initial check.

**What I implemented:**
Atomic increments in the UPDATE query. This prevents double-counting. The spend is correct; it's just slightly over budget.

**What would fully solve it:**
Using `SELECT FOR UPDATE` in `auth.js` to lock the row during the budget check:

```sql
SELECT * FROM virtual_keys WHERE key = $1 FOR UPDATE
```

Request B would block until Request A's transaction commits with its updated spend, then re-read the balance and correctly reject. This is the right solution for a payment-critical system.

**Why I didn't implement it:**
It holds a DB connection open for the entire LLM call duration (potentially seconds), creating lock contention at scale. The right solution at high throughput is to move budget checks to Redis (atomic INCR with a cap) and use the DB only for authoritative reconciliation. I document this explicitly rather than implementing it naively and pretending there's no issue.

---

## Decision 5: PostgreSQL (Supabase) over SQLite

SQLite would have worked fine locally, but it has two problems for this use case:

1. **Ephemeral filesystem on Render** — SQLite files live on disk. Render's free tier can reset the filesystem between deploys, wiping all keys and logs.
2. **Single-writer limitation** — SQLite's WAL mode helps, but under concurrent LLM requests, write contention would become a real issue.

PostgreSQL on Supabase gives me a persistent external database, true concurrent writes with row-level locking, and native DECIMAL types (important for financial calculations — floating point arithmetic is unreliable for money).

The free Supabase tier is more than sufficient for this project's scale.

---

## What I'd Change at Scale

**1. Redis for budget checks**
Move the hot path (budget check per request) to a Redis DECR with a floor at 0. Fast, atomic, no DB round-trip on the critical path. Sync back to Postgres periodically.

**2. Async usage logging**
Right now I await the DB write before returning the response. That adds 10–30ms of latency. At scale, I'd push log entries to an in-memory queue or a message broker (BullMQ, SQS) and drain them in a background worker.

**3. PgBouncer / connection pooling**
My current pool of 10 connections would saturate quickly at high concurrency.

**4. Cost pre-estimation**
Estimate cost from input token count (using tiktoken or similar), do a provisional budget hold, then reconcile on completion. This enables streaming without sacrificing accuracy.

---

## Deliberate Cuts

| Cut | Reason |
|---|---|
| Streaming | Accurate accounting requires complete token counts; buffering kills the point |
| Rate limiting (req/sec) | Budget is the enforced constraint; per-second rate limits are out of scope |
| Key rotation / expiry | Out of scope for this assignment |
| Multi-tenant IAM | Explicitly excluded in the brief |
| Fancy frontend | Assignment says "a simple /usage endpoint is enough" — I took that literally |

---

## Weakest Part of the System

The budget race condition under simultaneous near-limit requests (Decision 4). I understand the problem, I understand the solution, and I've chosen the simpler implementation with explicit acknowledgment of its limits rather than adding complexity I can't fully justify at this scale.

The second weakest is cost estimation: pricing is hardcoded per model and will drift as providers change their rates. In production I'd pull pricing from an admin-editable config or the provider's pricing API.
