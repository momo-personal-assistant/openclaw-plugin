# Momo Memory — OpenClaw Plugin

Cloud-backed team memory for [OpenClaw](https://openclaw.dev). Connects your Gmail, GitHub, Notion, Slack, and Discord decisions into a searchable memory layer that any AI agent can query.

> **Momo** extracts decisions from your team's tools, indexes them with embeddings + graph relationships, and makes them available through natural language search. This plugin brings that memory into OpenClaw.

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

Beyond the 7 built-in tools, the plugin automatically discovers and registers tools based on your connected integrations. For example, if you've connected Gmail and Slack in Momo, additional tools like `gmail_send_email` or `slack_post_message` become available to the agent.

Run `openclaw momo tools` to see what's available for your account.

## Self-Hosted

If you're running a self-hosted Momo instance, set the `apiUrl` config option:

```
OpenClaw Config → Plugins → All → Momo Memory → Momo API URL → https://your-momo.example.com
```

Or via environment variable:

```bash
export MOMO_API_URL=https://your-momo.example.com
```

## How Memory Works

See [HOW_MEMORY_WORKS.md](./HOW_MEMORY_WORKS.md) for a detailed explanation of how Momo collects, extracts, stores, and retrieves decisions.

## Links

- [Momo App](https://usemomo.com) — Sign up and manage your team
- [API Keys](https://app.usemomo.com) — Settings → API Keys
- [OpenClaw](https://openclaw.dev) — The agent framework

## License

MIT
