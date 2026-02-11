# Momo Memory — OpenClaw Plugin

Cloud-backed team memory for [OpenClaw](https://openclaw.ai). Connects your Gmail, GitHub, Notion, Slack, and Discord decisions into a searchable memory layer that any AI agent can query.

> **Momo** extracts decisions from your team's tools, indexes them with embeddings + graph relationships, and makes them available through natural language search. This plugin brings that memory into OpenClaw.

## Why Momo vs OpenClaw's Built-in Memory

| | OpenClaw Today | With Momo |
|---|---|---|
| **Storage** | Local-only (markdown, session transcripts) | Cloud-backed, encrypted, persistent |
| **Data Sources** | Conversation-derived memories only | Auto-indexed Gmail/GitHub/Notion/Slack/Discord |
| **Extraction** | Rule-based capture (regex triggers) | AI-powered decision extraction pipeline |
| **Sharing** | Single-user, single-device | Team-shared decision context |
| **Intelligence** | No semantic understanding | Structured decisions (rationale, confidence, entities) |

### What Momo Solves

1. **memory.md doesn't auto-populate** — Momo's `agent_end` hook automatically extracts decisions from every conversation. No trigger words needed.

2. **No clear criteria for long-term memory** — Momo uses 10 explicit decision types (approval, commitment, selection, etc.) with confidence scoring. Structured data, not freeform markdown.

3. **No persistent log or daily summaries** — Every decision is permanently stored with embeddings and graph relationships. The `momo_summary` tool generates period-based summaries (today/week/month).

4. **No automatic categorization** — The extraction pipeline automatically identifies people, companies, projects, and links them via graph relationships. Ask "who have I been working with?" and get structured answers.

5. **No way to view or query organized data** — Search semantically with `momo_search`, get formatted context with `momo_context`, or browse the full graph in Momo's web UI.

6. **External tools can't access memory** — Momo's API endpoints work with any tool, not just OpenClaw. Notion, Slack, and other integrations can read and write to the same memory.

## Quick Start

```bash
openclaw plugin install momo-memory
```

Then configure your API key:

```
OpenClaw Config → Plugins → All → Momo Memory → Momo API Key
```

Get your API key at [app.usemomo.com → Settings → API Keys](https://app.usemomo.com).

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | — | Your Momo API key (`momo_...`). Required. |
| `apiUrl` | string | `https://app.usemomo.com` | Override for self-hosted instances. |
| `autoCapture` | boolean | `true` | Automatically extract decisions from conversations. |
| `autoRecall` | boolean | `true` | Automatically inject relevant memories before each response. |

You can also set the API key via the `MOMO_API_KEY` environment variable.

## Tools

The plugin registers 7 tools that the AI agent can call:

### `momo_search` — Search team decisions

Search across all your indexed sources using natural language.

```
"Search for decisions about the AWS migration"
```

Parameters: `query` (required), `limit` (max 20), `source` (filter by gmail/github/notion/slack/discord/openclaw)

### `momo_store` — Save a decision

Manually store a decision, commitment, or important fact to team memory.

```
"Remember that we chose Stripe over PayPal for payments"
```

Parameters: `title` (required), `summary` (required), `decisionType`, `confidence`, `rationale`, `involvedPersons`

### `momo_context` — Get formatted context

Retrieve a formatted summary of relevant past decisions for a topic — ready to use as LLM context.

Parameters: `query` (required), `maxTokens` (default 4000)

### `momo_summary` — Team activity summary

Get decisions grouped by source for a time period.

Parameters: `period` (today/week/month)

### `momo_schedule` — Create a scheduled task

Set up recurring AI-generated reports (daily brief, weekly summary, etc.) delivered via email, Slack, or in-app.

Parameters: `name`, `prompt`, `scheduledTime` (HH:MM), `frequency` (daily/weekly/monthly), `deliveryChannel`

### `momo_list_schedules` — List scheduled tasks

View all your scheduled tasks with status and next run time.

### `momo_cancel_schedule` — Cancel a scheduled task

Disable a scheduled task by ID.

## Hooks

### Auto-Recall (`before_agent_start`)

When enabled, Momo checks each user message against your team's memory and injects relevant decisions into the LLM context before it responds. This means the agent automatically "remembers" past decisions without being asked.

- Skips short messages (< 30 chars) and casual chat (greetings, "ok", etc.)
- Injects up to 2,000 tokens of context
- Runs at priority 10

### Auto-Capture (`agent_end`)

When enabled, Momo buffers conversation messages and extracts decisions after a 5-minute silence or when the buffer reaches 20 messages. This means decisions made during conversations are automatically saved to team memory.

- Needs at least 4 messages (2 exchanges) before extracting
- Keeps last 4 messages as overlap for continuity across batches
- Buffers are flushed on plugin shutdown

## CLI Commands

```bash
# Search team decisions
openclaw momo search "pricing strategy"
openclaw momo search "AWS" --limit 10 --source github

# Team activity summary
openclaw momo summary          # this week
openclaw momo summary today
openclaw momo summary month

# List scheduled tasks
openclaw momo schedules

# Check connection status
openclaw momo status

# List connected integrations and available tools
openclaw momo tools
```

## Dynamic Integration Tools

Beyond the 7 built-in tools, the plugin automatically discovers and registers tools based on your connected integrations. Tools only appear when the corresponding integration is connected in Momo.

Run `openclaw momo tools` to see what's available for your account.

### Gmail (6 tools)

| Tool | Description |
|------|-------------|
| `gmail_list_emails` | List emails from inbox with search and filtering |
| `gmail_get_email` | Get full content of a specific email |
| `gmail_get_thread` | Get all messages in an email thread |
| `gmail_search_emails` | Search emails using Gmail's advanced search syntax |
| `gmail_send_email` | Send a new email |
| `gmail_reply_to_email` | Reply to an existing email thread |

### Slack (8 tools)

| Tool | Description |
|------|-------------|
| `slack_get_my_identity` | Get current user's Slack identity |
| `slack_list_channels` | List channels user has access to |
| `slack_get_channel_messages` | Get recent messages from a channel |
| `slack_get_thread` | Get all messages in a thread |
| `slack_search_messages` | Search messages across channels |
| `slack_get_my_mentions` | Find messages where you are @mentioned |
| `slack_send_message` | Send a message to a channel |
| `slack_reply_to_thread` | Reply to a thread |

### GitHub (7 tools)

| Tool | Description |
|------|-------------|
| `github_list_repos` | List user's repositories |
| `github_list_connected_repos` | List repos connected to Momo |
| `github_list_commits` | List recent commits for a repo |
| `github_get_commit` | Get commit details including files changed |
| `github_list_prs` | List pull requests |
| `github_get_pr` | Get details of a specific PR |
| `github_list_issues` | List issues for a repo |

### Notion (7 tools)

| Tool | Description |
|------|-------------|
| `notion_search_pages` | Search for pages in workspace |
| `notion_get_page` | Get full content of a page as markdown |
| `notion_list_databases` | List databases in workspace |
| `notion_query_database` | Query a database to get entries/rows |
| `notion_create_page` | Create a new sub-page under an existing page |
| `notion_append_content` | Append content to an existing page |
| `notion_add_database_entry` | Add a new entry to a database |

### Linear (6 tools)

| Tool | Description |
|------|-------------|
| `linear_list_teams` | List all teams in workspace |
| `linear_list_projects` | List projects in workspace |
| `linear_list_issues` | List issues with optional filters |
| `linear_get_issue` | Get details of a specific issue (e.g. `ENG-123`) |
| `linear_create_issue` | Create a new issue |
| `linear_search_issues` | Search issues by keyword |

### Discord (8 tools)

| Tool | Description |
|------|-------------|
| `discord_get_my_identity` | Get current user's Discord identity |
| `discord_list_servers` | List servers (guilds) user has access to |
| `discord_list_channels` | List text channels in a server |
| `discord_get_channel_messages` | Get recent messages from a channel |
| `discord_get_thread` | Get all messages in a thread |
| `discord_search_messages` | Search messages containing specific text |
| `discord_get_my_mentions` | Find messages where you are @mentioned |
| `discord_send_message` | Send a message to a channel |

<!--
## Self-Hosted

If you're running a self-hosted Momo instance, set the `apiUrl` config option:

```
OpenClaw Config → Plugins → All → Momo Memory → Momo API URL → https://your-momo.example.com
```

Or via environment variable:

```bash
export MOMO_API_URL=https://your-momo.example.com
```
-->

## How Memory Works

See [HOW_MEMORY_WORKS.md](./HOW_MEMORY_WORKS.md) for a detailed explanation of how Momo collects, extracts, stores, and retrieves decisions.

## Links

- [Momo App](https://app.usemomo.com/setup) — Sign up and manage your team
- [API Keys](https://app.usemomo.com) — Settings → API Keys
- [OpenClaw](https://openclaw.ai) — The agent framework

## License

MIT
