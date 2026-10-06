# Agent Runner adapters

The `agent:` setting selects the Runner adapter that owns the coding-agent CLI invocation. The pipeline owns prompts, deterministic worklists, guardrails, and sandbox gates. An adapter owns only its CLI's argv, environment, capability limits, report normalization, and invocation descriptor.

## Settings

The Pi lane remains the default. A Codex lane is explicit and is not enabled by this repository's shipped settings:

```yaml
agent: codex
command: codex
targets: [gpt-5.6-terra]
reasoning: high
isolate: true
isolate.skills: [.agents/skills/obsidian-markdown, .agents/skills/obsidian-bases]
```

Codex accepts OpenAI model names only. Do not set `provider:` or `isolate.extensions:` for this lane. Switching a live instance to Codex is an operator decision; this documentation does not enable a lane.

## Pi-to-Codex mapping

| Concern | Pi | Codex |
| --- | --- | --- |
| Invocation | `--model`, `--thinking`, `--print` | `exec -C`, `-m`, `-c model_reasoning_effort=`, prompt on stdin |
| Isolation | `--no-context-files --no-extensions --no-skills` | Managed `CODEX_HOME` and redirected `HOME` |
| Skill whitelist | Repeated `--skill` paths | Whitelisted directories symlinked into managed `.agents/skills/` |
| Extensions | Repeated `-e` sources | Unsupported; settings fail with a named error |
| Web | Query-only Pi extension and tool allowlist | Query-only `--web`; managed config defaults to `web_search = "disabled"` |
| Auth | Pi auth store | Seeded `auth.json` under managed `CODEX_HOME`; `OPENAI_API_KEY` may authenticate Codex |
| Report | stdout | `-o` final-message file, then passed to the existing report flow |
| Progress | Invocation descriptor rendered centrally | Invocation descriptor rendered centrally with Codex sandbox, managed-home, web, and auth posture |

## Operator smoke probe

CI never runs a live model. Before enabling a Codex settings file for an instance, run a supervised non-production cycle with that settings file and review the data-repository diff and digest. Confirm that the selected model is `gpt-5.6-terra`, reasoning is `high`, the managed home contains only approved skills, web is disabled for ingest and lint, and the final report is captured. Do not enable an MCP server, a subagent, a custom model provider, or automatic failover as part of this probe.
