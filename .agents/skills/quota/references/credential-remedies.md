# Credential remedies

Use `quota-axi auth --json` as the current source of truth. Give only the
applicable remedy, then rerun the command to verify `available`. Never ask for
a credential value.

| Provider | Remedy when its source is blocked |
| --- | --- |
| Claude | Run `quota-axi --allow-keychain-prompt` once and choose **Always Allow** in the Keychain prompt. If that does not apply, sign in through Claude Code. |
| Codex | Sign in through the Codex CLI so its managed OAuth authentication is present. Do not ask for an API key. |
| Cursor | Sign in with Cursor or `cursor-agent`; on macOS, run quota-axi with the Keychain-prompt flag and approve its matching Keychain request. |
| GitHub Copilot | Sign in through the GitHub Copilot CLI or its supported local sign-in flow. |
| Grok | Sign in through the Grok CLI, or use the user's existing Pi `xai` authentication. |
| Kimi | Sign in through the Kimi Code CLI or configure the user's existing Pi `kimi-coding` authentication. |
| Z.AI | Sign in through OpenCode with a supported Z.AI Coding Plan authentication entry. |
| Antigravity | Start Antigravity or `agy`; quota-axi reads its existing local read-only loopback endpoint. |
| Alibaba | Install and sign in to the `bl` CLI, then rerun the auth read. |
| OpenCode Go | Sign in through OpenCode so its managed auth file is available. |
| CommandCode | Sign in through the CommandCode CLI or configure a supported local provider credential where its own documentation requires it. |
| Environment-key providers | Put the key in the provider's documented environment variable in the user's shell or secret manager. State the variable name only when quota-axi's live help names it; never request or echo the value. |

If a source reports `invalid`, `expired`, or `error`, describe that status and
send the user to the owning provider's sign-in or renewal flow. Do not guess a
repair.
