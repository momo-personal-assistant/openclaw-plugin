# Changelog

## 0.1.5

- Add dynamic integration tool registration (Gmail, Slack, Notion, etc.)
- Add `openclaw momo tools` CLI command
- Add scheduled tasks: `momo_schedule`, `momo_list_schedules`, `momo_cancel_schedule`
- Auto-capture debounced buffering with 5-minute silence window
- Buffer overlap (last 4 messages) for continuity across extraction batches
- Graceful buffer flush on plugin shutdown

## 0.1.0

- Initial release
- Tools: `momo_search`, `momo_store`, `momo_context`, `momo_summary`
- Hooks: auto-recall (before_agent_start), auto-capture (agent_end)
- CLI: `openclaw momo search|summary|status`
