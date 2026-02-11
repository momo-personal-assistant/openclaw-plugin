# How Momo's Memory System Works

> A plain-language guide to how Momo collects, processes, stores, and retrieves your team's decisions.

---

## The Big Picture

Momo connects to your team's tools (Gmail, GitHub, Notion, Slack, Discord), reads through the content, and uses AI to extract **decisions** — things like approvals, commitments, selections, and direction changes. These decisions are stored in a searchable memory that your team can query through chat, API, or plugins like this one.

```
Your Tools                    Momo                         Your Team
───────────                   ────                         ─────────
Gmail        ──┐                                    ┌──  Chat UI
GitHub       ──┤   Fetch → Extract → Embed → Store  ├──  OpenClaw Plugin
Notion       ──┤              ↓                      ├──  Slack Bot
Slack        ──┤        Search ← Query               ├──  API
Discord      ──┘                                    └──  Summaries
```

---

## Step 1: Collecting Data

Each source has its own way of getting data into Momo:

| Source | How | When | What's Collected |
|--------|-----|------|-----------------|
| **Gmail** | OAuth connection | Daily cron + push notifications | Emails (sent prioritized over inbox) |
| **GitHub** | Webhook | Real-time on push/PR events | Commits, PR titles, descriptions |
| **Notion** | OAuth + polling | Periodic sync | Page content, hierarchy |
| **Slack** | Webhook | Real-time on messages | Messages, thread replies |
| **Discord** | Webhook | Real-time on messages | Messages, reactions |

### Gmail Details

Gmail gets special treatment since email is where most decisions happen:

- **First sync (onboarding):** Pulls up to 5,000 emails from the last 90 days. 70% from Sent mail (your decisions matter most), 30% from Starred emails.
- **Daily sync:** Up to 100 new emails per day via cron job.
- **Cleanup before processing:** HTML stripped to plain text, quoted replies removed, signatures stripped, whitespace cleaned up.

---

## Step 2: Extracting Decisions

Raw content (emails, messages, commits) goes through AI extraction to identify structured decisions.

### What Counts as a Decision?

Momo recognizes 10 types:

| Type | Example |
|------|---------|
| **Approval** | "Yes, approved. Go ahead with the proposal." |
| **Rejection** | "Let's not pursue this vendor." |
| **Selection** | "We'll go with React for the frontend." |
| **Delegation** | "Sarah will handle the client onboarding." |
| **Commitment** | "I'll have the draft ready by Friday." |
| **Direction** | "Moving forward, we're focusing on enterprise." |
| **Confirmation** | "Confirmed — meeting at 3pm tomorrow." |
| **Cancellation** | "Let's cancel the Q2 launch event." |
| **Negotiation** | "We can do $50K instead of $65K." |
| **Prioritization** | "Let's focus on security before new features." |

### What Gets Extracted?

For each decision, Momo captures:

- **Title:** "Chose AWS over GCP for infrastructure"
- **Summary:** "Team decided on AWS based on existing expertise and pricing"
- **Full Context:** The original email/message thread (encrypted)
- **Type:** One of the 10 types above
- **Confidence:** High / Medium / Low
- **Status:** Decided / Pending / Reversed
- **People Involved:** Names, emails, roles
- **Related Entities:** Companies, products, services mentioned
- **Related Projects:** Which initiatives this connects to
- **Source:** Gmail / GitHub / Notion / Slack / Discord
- **Source Date:** When it originally happened
- **Source URL:** Link back to the original content

---

## Step 3: Indexing Pipeline

Every piece of content goes through a unified pipeline:

```
Fetch → Normalize → Extract → Embed → Store → Link
```

| Stage | What Happens |
|-------|-------------|
| **Fetch** | Pull content from Gmail API / webhooks |
| **Normalize** | Clean up raw content (strip HTML, signatures, quotes) |
| **Extract** | AI identifies decisions, people, entities |
| **Embed** | Convert to 1536-dim vector for semantic search |
| **Store** | Save to databases (PostgreSQL + Graph DB) |
| **Link** | Create relationships (INVOLVES, SAME_THREAD, etc.) |

---

## Step 4: How It's Stored

Decisions live in two places, each optimized for different queries:

### PostgreSQL + pgvector

The primary database for decisions:
- Full decision records with all fields
- Vector embeddings for semantic search (HNSW index)
- Encrypted fields for sensitive data
- Team isolation via Row Level Security

### Graph Database

The relationship layer:
- Memory nodes with embeddings
- Person, Entity, Project, and Thread nodes
- Relationships between them
- Enables multi-hop discovery (see Step 5)

```
[Email Thread] ──INVOLVES──→ [Jane]
      │                         │
  SAME_THREAD              MENTIONS
      │                         │
      ▼                         ▼
[Follow-up Email] ──RELATES_TO──→ [AWS Migration Project]
      │
   INVOLVES
      │
      ▼
   [John]
```

---

## Step 5: How Search & Retrieval Works

When you ask Momo a question, it goes through a multi-stage retrieval pipeline:

### Stage 1: Understand the Query

Your question is analyzed:
- Is it about a person? A project? A deadline?
- Key terms extracted
- Query converted to a 1536-dimension vector embedding

### Stage 2: Vector Search

The query embedding is compared against all stored memory embeddings using cosine similarity. Returns the top 10 most semantically similar results.

**Scoring:** Hybrid formula combining:
- **Semantic similarity** (70% weight) — how close the meaning is
- **Temporal recency** (30% weight) — newer results get a boost, decaying over time

### Stage 3: Graph Expansion (Multi-Hop)

This is where Momo goes beyond basic RAG. Starting from the vector search results, it traverses the graph to find related information:

```
Query: "What did we decide about the AWS migration?"

Vector Search finds:
  → "Approved AWS migration plan" (score: 0.85)

Graph Expansion (hop 1):
  → Jane (INVOLVES) — she made the decision
  → AWS Migration Project (RELATES_TO) — the project
  → Infrastructure Budget Email (SAME_THREAD) — context

Graph Expansion (hop 2):
  → John (INVOLVES via Jane's email) — he was CC'd
  → GCP Comparison Doc (RELATES_TO via project) — the alternative considered
```

Each hop reduces the relevance score by 10% (decay factor: 0.9). Default: **2 hops maximum** to keep results focused.

### Stage 4: Context Assembly

All discovered nodes are assembled into a context package for the LLM:
- Prioritized by: importance > recency > relevance score
- Token-limited: ~4,000 tokens (configurable via `momo_context` tool's `maxTokens`)
- Formatted as markdown for readability
- Lower-importance items dropped if over budget

### The Full Pipeline

```
"What did we decide about AWS?"
        │
        ▼
   Query Analysis
   (intent: project query)
        │
        ▼
   Generate Embedding
   (1536-dim vector)
        │
        ▼
   Vector Search
   (top 10, min score 0.5)
        │
        ▼
   Graph Expansion
   (2 hops, 0.9 decay)
        │
        ▼
   Subgraph Assembly
   (nodes + relationships)
        │
        ▼
   Context Builder
   (prioritize, format, trim to 4K tokens)
        │
        ▼
   LLM Response
   "Your team approved the AWS migration on Jan 15th.
    Jane led the decision, with input from John..."
```

---

## Step 6: Encryption & Security

### Client-Side Encryption (Vault)

All sensitive data is encrypted client-side using **AES-256-GCM** before it leaves your device. The encryption key is derived from a passphrase that only you know — Momo's servers never see your full content.

| Data | Encryption |
|------|-----------|
| Title, full context, involved persons, related entities | **Encrypted** (AES-256-GCM, client-side) |
| Summary, decision type, confidence, source | **Plaintext** (needed for search and filtering) |

### Team Isolation

- Personal data is isolated per user — only you see your data
- Team data must be explicitly marked as shared
- Default sharing by source:
  - **Gmail:** Private (personal emails)
  - **GitHub/Notion/Slack/Discord:** Shared (team content)

---

## Step 7: Memory Lifecycle (Pruning at Scale)

As users accumulate thousands of decisions, search quality can degrade from stale, redundant, and contradicted memories. The lifecycle system manages this automatically.

### Tiered Detail

When building context for the LLM, decisions are formatted with varying detail based on age:

| Age | Tier | Fields Included |
|-----|------|----------------|
| 0-14 days | Full | title, date, type, summary, full context, rationale, persons, entities |
| 14-60 days | Summary | title, date, type, summary |
| 60+ days | Minimal | title, date, type |

The token budget stays the same, but fits more decisions because older ones use fewer tokens.

### Relevance Decay

Search scoring is tuned for recency:
- Fast recency falloff (14-day decay window)
- Low floor for old decisions (still findable, just ranked lower)
- Revoked and revised decisions are excluded
- Superseded decisions are demoted (score x 0.3)

### Supersession Detection

When a new decision contradicts an old one, the old one gets automatically demoted:

1. During extraction, relationships between decisions are detected
2. The old decision gets a `superseded_by` link to the new one
3. Search multiplies the old decision's score by 0.3

### Memory Compaction

Clusters old similar decisions into summarized "compacted memories":

1. Fetch non-archived, non-superseded decisions older than 90 days
2. Cluster by embedding similarity (threshold: 0.65)
3. For clusters with 3+ decisions: AI summarizes into a single compacted memory
4. Original decisions are **never deleted** — they keep all source links

Compaction runs automatically on a weekly schedule for accounts with 500+ decisions.

---

## Summary

```
1. COLLECT    Connect Gmail/GitHub/Notion/Slack/Discord via OAuth/webhooks
2. NORMALIZE  Clean up raw content (strip HTML, signatures, quotes)
3. EXTRACT    AI identifies decisions, people, entities, projects
4. EMBED      Convert to 1536-dim vectors for semantic search
5. STORE      Dual storage: PostgreSQL (records) + Graph DB (relationships)
6. SEARCH     Vector similarity + graph multi-hop traversal
7. ASSEMBLE   Prioritize and format context within token budget (age-tiered)
8. RESPOND    Answer questions with full decision context
9. LIFECYCLE  Supersede contradictions, compact old clusters weekly
```
