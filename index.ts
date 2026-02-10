/**
 * Momo Memory Plugin for OpenClaw
 *
 * Cloud-backed team memory with auto-indexing from Gmail, GitHub, Notion, Slack, Discord.
 * Replaces OpenClaw's local-only memory with structured decision memory + graph relationships.
 *
 * Tools: momo_search, momo_store, momo_context, momo_summary
 * Hooks: auto-recall (before_agent_start), auto-capture (agent_end, debounced)
 * CLI: openclaw momo search|summary|status
 */

// Types — OpenClaw plugin SDK types (referenced, not imported at build time)
interface OpenClawPluginApi {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  registerTool: (tool: any, opts?: any) => void;
  registerCli: (registrar: any, opts?: any) => void;
  registerService: (service: any) => void;
  on: (hookName: string, handler: any, opts?: any) => void;
}

// =============================================================================
// CONFIG
// =============================================================================

interface MomoConfig {
  apiKey: string;
  apiUrl: string;
  autoCapture: boolean;
  autoRecall: boolean;
}

function resolveConfig(pluginConfig: Record<string, unknown> = {}): MomoConfig {
  return {
    apiKey: (pluginConfig.apiKey as string) || process.env.MOMO_API_KEY || "",
    apiUrl: (pluginConfig.apiUrl as string) || process.env.MOMO_API_URL || "https://app.usemomo.com",
    autoCapture: pluginConfig.autoCapture !== false, // default true
    autoRecall: pluginConfig.autoRecall !== false, // default true
  };
}

// =============================================================================
// HTTP HELPERS
// =============================================================================

function makeHeaders(config: MomoConfig) {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function momoFetch(
  config: MomoConfig,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const url = `${config.apiUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...makeHeaders(config), ...(options.headers || {}) },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`Momo API error (${res.status}): ${text}`);
  }

  return res.json();
}

// =============================================================================
// MESSAGE BUFFER (for debounced auto-capture)
// =============================================================================

interface BufferedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const messageBuffers = new Map<string, BufferedMessage[]>();
const silenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const SILENCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER_SIZE = 20; // Force extract at 20 messages

function getChannelKey(event: any): string {
  return event?.session?.channelId || event?.session?.id || "default";
}

async function flushBuffer(
  channelKey: string,
  config: MomoConfig,
  logger: OpenClawPluginApi["logger"]
) {
  const messages = messageBuffers.get(channelKey);
  if (!messages || messages.length < 4) {
    // Need at least 2 exchanges
    messageBuffers.delete(channelKey);
    return;
  }

  try {
    const result = await momoFetch(config, "/api/ext/extract", {
      method: "POST",
      body: JSON.stringify({
        messages,
        source: "openclaw",
        channel: channelKey,
      }),
    });

    if (result.decisionsFound > 0) {
      logger.info(
        `[momo] Captured ${result.decisionsFound} decision(s) from conversation`
      );
    }
  } catch (err) {
    logger.warn("[momo] Auto-capture failed:", err);
  }

  messageBuffers.delete(channelKey);
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

const momoPlugin = {
  id: "momo-memory",
  name: "Momo Memory",
  description:
    "Cloud-backed team memory with auto-indexing from Gmail, GitHub, Notion, Slack, Discord",
  kind: "memory" as const,

  async register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    if (!config.apiKey) {
      api.logger.error(
        "[momo] No API key configured. Set it up at OpenClaw Config → Plugins → All → Momo Memory → Momo API Key"
      );
      return;
    }

    api.logger.info(`[momo] Connecting to ${config.apiUrl}`);

    // =========================================================================
    // TOOL 1: momo_search — Search team decisions
    // =========================================================================

    api.registerTool({
      name: "momo_search",
      label: "Search Momo Memory",
      description:
        "Search your team's decision memory across Gmail, GitHub, Notion, Slack, and Discord. " +
        "Returns relevant decisions with context, people involved, and source links.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for (natural language)",
          },
          limit: {
            type: "number",
            description: "Max results (default 5, max 20)",
          },
          source: {
            type: "string",
            enum: ["gmail", "github", "notion", "slack", "discord", "openclaw"],
            description: "Filter by source (optional)",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: any) {
        try {
          const qs = new URLSearchParams({
            query: params.query,
            limit: String(Math.min(params.limit || 5, 20)),
          });
          if (params.source) qs.set("source", params.source);

          const data = await momoFetch(
            config,
            `/api/ext/search?${qs.toString()}`
          );

          if (!data.success || !data.results?.length) {
            return {
              content: [{ type: "text", text: "No relevant decisions found." }],
            };
          }

          const text = data.results
            .map(
              (r: any, i: number) =>
                `${i + 1}. **${r.title}** (${r.source}, ${formatDate(r.sourceDate)})\n` +
                `   ${r.summary}\n` +
                `   Type: ${r.decisionType} | Confidence: ${r.confidence}` +
                (r.involvedPersons?.length
                  ? `\n   People: ${r.involvedPersons.map((p: any) => p.name).join(", ")}`
                  : "")
            )
            .join("\n\n");

          return {
            content: [{ type: "text", text }],
            details: { resultCount: data.results.length },
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `Search failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // TOOL 2: momo_store — Save a decision directly
    // =========================================================================

    api.registerTool({
      name: "momo_store",
      label: "Store in Momo Memory",
      description:
        "Save a decision, commitment, or important fact to team memory. " +
        "Use this when you notice an important decision in the conversation. " +
        "The decision will be searchable by the whole team.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short title (5-10 words)",
          },
          summary: {
            type: "string",
            description: "1-2 sentence description of what was decided",
          },
          decisionType: {
            type: "string",
            enum: [
              "approval", "rejection", "selection", "delegation",
              "commitment", "direction", "confirmation", "cancellation",
              "negotiation", "prioritization",
            ],
            description: "Type of decision",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "How clear is this decision",
          },
          rationale: {
            type: "string",
            description: "Why this was decided (if known)",
          },
          involvedPersons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string" },
              },
            },
            description: "People involved in the decision",
          },
        },
        required: ["title", "summary"],
      },
      async execute(_toolCallId: string, params: any) {
        try {
          const data = await momoFetch(config, "/api/ext/store", {
            method: "POST",
            body: JSON.stringify({
              decisions: [
                {
                  title: params.title,
                  summary: params.summary,
                  decisionType: params.decisionType || "direction",
                  confidence: params.confidence || "medium",
                  rationale: params.rationale || "",
                  involvedPersons: params.involvedPersons || [],
                  source: "openclaw",
                },
              ],
            }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${params.title}" (${data.stored} saved, ${data.neo4jSynced || 0} graphed)`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `Store failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // TOOL 3: momo_context — Get formatted context for a topic
    // =========================================================================

    api.registerTool({
      name: "momo_context",
      label: "Get Momo Context",
      description:
        "Retrieve formatted decision context for a topic. " +
        "Returns a summary of relevant past decisions ready for reference. " +
        "Use this to get background before answering a question about past work.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Topic to get context for",
          },
          maxTokens: {
            type: "number",
            description: "Max context size in tokens (default 4000)",
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: any) {
        try {
          const qs = new URLSearchParams({
            query: params.query,
            maxTokens: String(params.maxTokens || 4000),
          });

          const data = await momoFetch(
            config,
            `/api/ext/context?${qs.toString()}`
          );

          if (!data.context) {
            return {
              content: [
                { type: "text", text: "No relevant context found." },
              ],
            };
          }

          return {
            content: [{ type: "text", text: data.context }],
            details: {
              decisionsIncluded: data.decisionsIncluded,
              estimatedTokens: data.estimatedTokens,
            },
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `Context retrieval failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // TOOL 4: momo_summary — Get team activity summary
    // =========================================================================

    api.registerTool({
      name: "momo_summary",
      label: "Momo Team Summary",
      description:
        "Get a summary of team activity for a time period. " +
        "Shows decisions grouped by source (Gmail, GitHub, Slack, etc.).",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["today", "week", "month"],
            description: "Time period (default: week)",
          },
        },
      },
      async execute(_toolCallId: string, params: any) {
        try {
          const qs = new URLSearchParams({
            period: params.period || "week",
          });

          const data = await momoFetch(
            config,
            `/api/ext/summary?${qs.toString()}`
          );

          if (!data.totalDecisions) {
            return {
              content: [
                {
                  type: "text",
                  text: `No activity found for ${params.period || "this week"}.`,
                },
              ],
            };
          }

          let text = `**Team Activity (${data.period})** — ${data.totalDecisions} decisions\n\n`;

          for (const [source, info] of Object.entries(data.bySource || {}) as any) {
            text += `### ${source.charAt(0).toUpperCase() + source.slice(1)} (${info.count})\n`;
            for (const d of info.decisions.slice(0, 5)) {
              text += `- ${d.title}`;
              if (d.decisionType) text += ` (${d.decisionType})`;
              text += `\n`;
            }
            if (info.count > 5) {
              text += `- ... and ${info.count - 5} more\n`;
            }
            text += `\n`;
          }

          return {
            content: [{ type: "text", text }],
            details: { totalDecisions: data.totalDecisions },
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `Summary failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // TOOL 5: momo_schedule — Create a scheduled task
    // =========================================================================

    api.registerTool({
      name: "momo_schedule",
      label: "Schedule Momo Task",
      description:
        "Create a recurring scheduled task (daily brief, weekly summary, etc.). " +
        "Momo will generate AI content on the schedule and deliver via email, Slack, or in-app.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short name (e.g. 'Daily Summary', 'Weekly Report')",
          },
          prompt: {
            type: "string",
            description:
              "What to generate each run (e.g. 'Summarize all decisions I made today')",
          },
          scheduledTime: {
            type: "string",
            description: "Time in HH:MM format (e.g. '17:00')",
          },
          frequency: {
            type: "string",
            enum: ["daily", "weekly", "monthly"],
            description: "How often to run",
          },
          dayOfWeek: {
            type: "number",
            description: "Day of week for weekly (0=Sun, 1=Mon, ..., 6=Sat)",
          },
          dayOfMonth: {
            type: "number",
            description: "Day of month for monthly (1-31)",
          },
          deliveryChannel: {
            type: "string",
            enum: ["email", "slack", "in_app"],
            description: "How to deliver (default: in_app)",
          },
        },
        required: ["name", "prompt", "scheduledTime", "frequency"],
      },
      async execute(_toolCallId: string, params: any) {
        try {
          const data = await momoFetch(config, "/api/ext/scheduled-tasks", {
            method: "POST",
            body: JSON.stringify({
              name: params.name,
              prompt: params.prompt,
              scheduledTime: params.scheduledTime,
              frequency: params.frequency,
              dayOfWeek: params.dayOfWeek,
              dayOfMonth: params.dayOfMonth,
              deliveryChannel: params.deliveryChannel || "in_app",
            }),
          });

          if (!data.success) {
            return {
              content: [
                { type: "text", text: `Failed: ${data.error}` },
              ],
            };
          }

          return {
            content: [{ type: "text", text: data.message }],
            details: { taskId: data.task.id, schedule: data.task.schedule },
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `Schedule failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // TOOL 6: momo_list_schedules — List scheduled tasks
    // =========================================================================

    api.registerTool({
      name: "momo_list_schedules",
      label: "List Momo Schedules",
      description:
        "List all your scheduled tasks (daily briefs, weekly reports, etc.) " +
        "with their status, next run time, and delivery channel.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        try {
          const data = await momoFetch(config, "/api/ext/scheduled-tasks");

          if (!data.tasks?.length) {
            return {
              content: [
                { type: "text", text: "No scheduled tasks found." },
              ],
            };
          }

          const text = data.tasks
            .map(
              (t: any) =>
                `${t.enabled ? "●" : "○"} **${t.name}**\n` +
                `  ${t.schedule} → ${t.deliveryChannel}\n` +
                `  Runs: ${t.runCount || 0} | Last: ${t.lastRunStatus || "never"}` +
                (t.enabled ? "" : " (disabled)")
            )
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `**Scheduled Tasks** (${data.activeCount} active / ${data.count} total)\n\n${text}`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `List failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // TOOL 7: momo_cancel_schedule — Cancel a scheduled task
    // =========================================================================

    api.registerTool({
      name: "momo_cancel_schedule",
      label: "Cancel Momo Schedule",
      description:
        "Cancel a scheduled task by ID. The task is disabled, not deleted.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The task ID to cancel",
          },
        },
        required: ["taskId"],
      },
      async execute(_toolCallId: string, params: any) {
        try {
          const data = await momoFetch(
            config,
            `/api/ext/scheduled-tasks/${params.taskId}`,
            { method: "DELETE" }
          );

          return {
            content: [
              {
                type: "text",
                text: data.message || "Task cancelled.",
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              { type: "text", text: `Cancel failed: ${err.message}` },
            ],
          };
        }
      },
    });

    // =========================================================================
    // HOOK: Auto-Recall (before_agent_start)
    // =========================================================================

    if (config.autoRecall) {
      api.on(
        "before_agent_start",
        async (event: any) => {
          // Extract the LAST USER MESSAGE specifically, not the full prompt
          let userMessage = "";

          if (event.messages && Array.isArray(event.messages)) {
            // Walk backwards to find the last user message
            for (let i = event.messages.length - 1; i >= 0; i--) {
              const msg = event.messages[i];
              if (msg.role === "user") {
                userMessage =
                  typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join(" ")
                      : "";
                break;
              }
            }
          }

          // Fallback to prompt if no messages
          if (!userMessage && typeof event.prompt === "string") {
            userMessage = event.prompt;
          }

          // Skip short messages and casual chat
          if (!userMessage || userMessage.length < 30) return {};
          if (looksLikeCasualChat(userMessage)) return {};

          api.logger.info(
            `[momo] Auto-recall check: "${userMessage.slice(0, 80)}..."`
          );

          try {
            const qs = new URLSearchParams({
              query: userMessage.slice(0, 500),
              maxTokens: "2000",
            });

            const data = await momoFetch(
              config,
              `/api/ext/context?${qs.toString()}`
            );

            if (data.context && data.decisionsIncluded > 0) {
              api.logger.info(
                `[momo] Auto-recall: injecting ${data.decisionsIncluded} decision(s)`
              );
              return {
                prependContext: `<momo-memory source="team-decisions">\n${data.context}\n</momo-memory>`,
              };
            }
          } catch (err) {
            api.logger.warn("[momo] Auto-recall failed:", err);
          }

          return {};
        },
        { priority: 10 }
      );
    }

    // =========================================================================
    // HOOK: Auto-Capture (agent_end, debounced)
    // =========================================================================

    if (config.autoCapture) {
      api.on("agent_end", async (event: any) => {
        const channelKey = getChannelKey(event);
        const now = new Date().toISOString();

        // Extract messages from the event
        const newMessages: BufferedMessage[] = [];
        if (event.messages) {
          for (const msg of event.messages) {
            if (msg.role === "user" || msg.role === "assistant") {
              const content =
                typeof msg.content === "string"
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text)
                        .join("\n")
                    : "";

              if (content && content.length > 5) {
                newMessages.push({
                  role: msg.role as "user" | "assistant",
                  content,
                  timestamp: now,
                });
              }
            }
          }
        }

        if (newMessages.length === 0) return;

        // Add to buffer
        if (!messageBuffers.has(channelKey)) {
          messageBuffers.set(channelKey, []);
        }
        messageBuffers.get(channelKey)!.push(...newMessages);

        // Clear existing silence timer
        if (silenceTimers.has(channelKey)) {
          clearTimeout(silenceTimers.get(channelKey)!);
        }

        const buffer = messageBuffers.get(channelKey)!;

        // Force extract if buffer is large
        if (buffer.length >= MAX_BUFFER_SIZE) {
          api.logger.info(
            `[momo] Buffer full (${buffer.length} msgs), extracting now`
          );

          // Keep last 4 messages as context overlap for next batch
          const toExtract = [...buffer];
          messageBuffers.set(channelKey, buffer.slice(-4));

          // Temporarily swap buffer for extraction
          const tempKey = `${channelKey}__flush`;
          messageBuffers.set(tempKey, toExtract);
          await flushBuffer(tempKey, config, api.logger);
          return;
        }

        // Set silence timer
        silenceTimers.set(
          channelKey,
          setTimeout(async () => {
            silenceTimers.delete(channelKey);
            await flushBuffer(channelKey, config, api.logger);
          }, SILENCE_TIMEOUT_MS)
        );
      });
    }

    // =========================================================================
    // CLI COMMANDS
    // =========================================================================

    api.registerCli(
      ({ program }: any) => {
        const momo = program
          .command("momo")
          .description("Momo team memory commands");

        momo
          .command("search <query>")
          .description("Search team decisions")
          .option("-l, --limit <n>", "Max results", "5")
          .option("-s, --source <source>", "Filter by source")
          .action(async (query: string, opts: any) => {
            try {
              const qs = new URLSearchParams({
                query,
                limit: opts.limit,
              });
              if (opts.source) qs.set("source", opts.source);

              const data = await momoFetch(
                config,
                `/api/ext/search?${qs.toString()}`
              );

              if (!data.results?.length) {
                console.log("No results found.");
                return;
              }

              for (const r of data.results) {
                console.log(
                  `\n  ${r.title}`
                );
                console.log(
                  `  ${r.source} | ${r.decisionType} | ${formatDate(r.sourceDate)}`
                );
                console.log(`  ${r.summary}`);
                if (r.involvedPersons?.length) {
                  console.log(
                    `  People: ${r.involvedPersons.map((p: any) => p.name).join(", ")}`
                  );
                }
              }
              console.log(
                `\n  ${data.results.length} result(s) in ${data.stats?.searchTimeMs || "?"}ms`
              );
            } catch (err: any) {
              console.error("Search failed:", err.message);
            }
          });

        momo
          .command("summary [period]")
          .description("Team activity summary (today/week/month)")
          .action(async (period: string = "week") => {
            try {
              const qs = new URLSearchParams({ period });
              const data = await momoFetch(
                config,
                `/api/ext/summary?${qs.toString()}`
              );

              console.log(
                `\n  Team Activity (${data.period}) — ${data.totalDecisions} decisions\n`
              );

              for (const [source, info] of Object.entries(
                data.bySource || {}
              ) as any) {
                console.log(
                  `  ${source.toUpperCase()} (${info.count})`
                );
                for (const d of info.decisions.slice(0, 3)) {
                  console.log(`    - ${d.title}`);
                }
                if (info.count > 3)
                  console.log(`    ... +${info.count - 3} more`);
                console.log();
              }
            } catch (err: any) {
              console.error("Summary failed:", err.message);
            }
          });

        momo
          .command("schedules")
          .description("List scheduled tasks")
          .action(async () => {
            try {
              const data = await momoFetch(config, "/api/ext/scheduled-tasks");

              if (!data.tasks?.length) {
                console.log("\n  No scheduled tasks.\n");
                return;
              }

              console.log(
                `\n  Scheduled Tasks (${data.activeCount} active / ${data.count} total)\n`
              );

              for (const t of data.tasks) {
                const status = t.enabled ? "●" : "○";
                console.log(`  ${status} ${t.name}`);
                console.log(`    ${t.schedule} → ${t.deliveryChannel}`);
                console.log(
                  `    Runs: ${t.runCount || 0} | Last: ${t.lastRunStatus || "never"}`
                );
                if (!t.enabled) console.log("    (disabled)");
                console.log();
              }
            } catch (err: any) {
              console.error("List schedules failed:", err.message);
            }
          });

        momo
          .command("tools")
          .description("List available integration tools")
          .action(async () => {
            try {
              const data = await momoFetch(config, "/api/ext/capabilities");

              if (!data.integrations?.length) {
                console.log("\n  No integrations connected.");
                console.log("  Connect apps at app.usemomo.com → Settings → Integrations\n");
                return;
              }

              console.log(
                `\n  Connected: ${data.integrations.join(", ")}`
              );
              console.log(`  Available tools: ${data.toolCount}\n`);

              // Group tools by prefix
              const grouped: Record<string, any[]> = {};
              for (const t of data.tools) {
                const prefix = t.name.split("_")[0];
                if (!grouped[prefix]) grouped[prefix] = [];
                grouped[prefix].push(t);
              }

              for (const [prefix, tools] of Object.entries(grouped)) {
                console.log(`  ${prefix.toUpperCase()} (${tools.length})`);
                for (const t of tools) {
                  console.log(`    ${t.name}`);
                  console.log(`      ${t.description.slice(0, 80)}${t.description.length > 80 ? "..." : ""}`);
                }
                console.log();
              }
            } catch (err: any) {
              console.error("Failed to list tools:", err.message);
            }
          });

        momo
          .command("status")
          .description("Check Momo connection and memory stats")
          .action(async () => {
            try {
              console.log(`\n  Momo API: ${config.apiUrl}`);
              console.log(`  API Key: ${config.apiKey.slice(0, 12)}...`);
              console.log(
                `  Auto-Recall: ${config.autoRecall ? "on" : "off"}`
              );
              console.log(
                `  Auto-Capture: ${config.autoCapture ? "on" : "off"}`
              );

              // Try fetching insights to verify connection
              const data = await momoFetch(config, "/api/ext/insights");

              if (data.success) {
                console.log("  Connection: OK");
                if (data.data?.generatedAt) {
                  console.log(
                    `  Last insights: ${formatDate(data.data.generatedAt)}`
                  );
                }
              }

              // Check buffer state
              const totalBuffered = Array.from(messageBuffers.values()).reduce(
                (sum, buf) => sum + buf.length,
                0
              );
              if (totalBuffered > 0) {
                console.log(
                  `  Buffered messages: ${totalBuffered} (across ${messageBuffers.size} channel(s))`
                );
              }

              console.log();
            } catch (err: any) {
              console.log(`  Connection: FAILED (${err.message})`);
            }
          });
      },
      { commands: ["momo"] }
    );

    // =========================================================================
    // DYNAMIC TOOL REGISTRATION (app action tools based on connected integrations)
    // =========================================================================

    // Fetch capabilities and register integration tools (Gmail, Slack, Notion, etc.)
    // Awaited so tools are registered before register() returns (OpenClaw compiles tool list at that point).
    try {
      const caps = await momoFetch(config, "/api/ext/capabilities");
      if (caps.success && caps.tools?.length) {
        // Skip tools we already registered above (momo_* tools)
        const momoToolNames = new Set([
          "momo_search", "momo_store", "momo_context", "momo_summary",
          "momo_schedule", "momo_list_schedules", "momo_cancel_schedule",
        ]);

        let registered = 0;
        for (const tool of caps.tools) {
          if (momoToolNames.has(tool.name)) continue;

          const parameters = tool.parameters || { type: "object", properties: {} };

          api.registerTool({
            name: tool.name,
            label: toolNameToLabel(tool.name),
            description: tool.description,
            parameters,
            async execute(_toolCallId: string, params: any) {
              try {
                const data = await momoFetch(config, "/api/ext/tools/execute", {
                  method: "POST",
                  body: JSON.stringify({ tool: tool.name, params }),
                });

                if (!data.success) {
                  return {
                    content: [{ type: "text", text: `Failed: ${data.error}` }],
                  };
                }

                const resultText = typeof data.result === "string"
                  ? data.result
                  : JSON.stringify(data.result, null, 2);

                return {
                  content: [{ type: "text", text: resultText }],
                };
              } catch (err: any) {
                return {
                  content: [{ type: "text", text: `${tool.name} failed: ${err.message}` }],
                };
              }
            },
          });
          registered++;
        }

        if (registered > 0) {
          api.logger.info(
            `[momo] Registered ${registered} integration tool(s) (${caps.integrations.join(", ")})`
          );
        }
      } else {
        api.logger.info(
          `[momo] No integration tools available (integrations: ${caps.integrations?.join(", ") || "none"})`
        );
      }
    } catch (err: any) {
      api.logger.warn("[momo] Failed to load integration tools:", err.message);
    }

    // =========================================================================
    // SERVICE (cleanup on shutdown)
    // =========================================================================

    api.registerService({
      id: "momo-memory",
      start: () => {
        api.logger.info("[momo] Memory service started");
      },
      stop: async () => {
        // Flush all buffers on shutdown
        for (const [channelKey] of messageBuffers) {
          if (silenceTimers.has(channelKey)) {
            clearTimeout(silenceTimers.get(channelKey)!);
            silenceTimers.delete(channelKey);
          }
          await flushBuffer(channelKey, config, api.logger);
        }
        api.logger.info("[momo] Memory service stopped, buffers flushed");
      },
    });

    api.logger.info(
      `[momo] Plugin ready (recall: ${config.autoRecall}, capture: ${config.autoCapture})`
    );
  },
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Detect casual/greeting messages that don't need memory context.
 * Returns true if the message is likely casual chat.
 */
function looksLikeCasualChat(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // Greetings and small talk
  const casualPatterns = [
    /^(hi|hey|hello|yo|sup|hola|howdy|hiya|heya)\b/,
    /^(good\s*(morning|afternoon|evening|night))\b/,
    /^(thanks|thank you|thx|ty)\b/,
    /^(ok|okay|sure|got it|sounds good|cool|nice|great|awesome|perfect)\b/,
    /^(bye|goodbye|see you|later|gn|ttyl)\b/,
    /^(yes|no|yep|nope|yeah|nah)\b/,
    /^(lol|lmao|haha|heh|😂|👍|🙏)/,
    /^(how are you|what's up|whats up|wassup)\b/,
  ];

  for (const pattern of casualPatterns) {
    if (pattern.test(lower)) return true;
  }

  // Very short messages with no question marks or keywords
  if (lower.length < 40 && !lower.includes("?") && !hasMemoryKeywords(lower)) {
    return true;
  }

  return false;
}

/**
 * Check if text contains keywords that suggest memory/decision relevance.
 */
function hasMemoryKeywords(text: string): boolean {
  const keywords = [
    "decide", "decision", "chose", "choice", "agreed", "approved",
    "committed", "plan", "strategy", "priorit", "delegate",
    "what did", "when did", "who said", "remember", "last time",
    "previously", "before", "history", "recap", "summary",
    "meeting", "discussed", "update", "status", "progress",
    "deadline", "schedule", "budget", "roadmap", "milestone",
  ];
  return keywords.some((kw) => text.includes(kw));
}

/**
 * Convert tool name like "gmail_send_email" to a label like "Gmail: Send Email"
 */
function toolNameToLabel(name: string): string {
  const prefixMap: Record<string, string> = {
    gmail: "Gmail",
    notion: "Notion",
    github: "GitHub",
    linear: "Linear",
    slack: "Slack",
    discord: "Discord",
    momo: "Momo",
  };

  const parts = name.split("_");
  const prefix = prefixMap[parts[0]] || parts[0];
  const rest = parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return `${prefix}: ${rest}`;
}

function formatDate(dateStr: string | Date): string {
  if (!dateStr) return "unknown";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default momoPlugin;
