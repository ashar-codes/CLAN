# AI providers

`AIProvider` (protocol `ai.ts`): `generate({ messages, json?, maxTokens?, signal?, onDelta? }) → { text, usage, model }`,
optional `embed(texts)`, and `caps { streaming, structured, embeddings, local }`. Errors are `AIError` with a code:
`unavailable | offline | timeout | rate_limit (retryAfterMs) | auth | provider | invalid_output | cancelled`.

## Adapters
| Kind | Status | Notes |
|---|---|---|
| `openai-compatible` | real | `POST {baseUrl}/chat/completions` (SSE streaming with `stream_options.include_usage`, `response_format: json_object` for structured output), `POST {baseUrl}/embeddings` when an embedding model is set. Works with any compatible cloud endpoint or local gateway (`http://localhost…` is flagged `local`). Runtimes without readable bodies (React Native) fall back to one non-streamed response |
| `local` | capability only | no on-device model ships; selecting it shows “not installed yet”. Tests/E2E use the deterministic provider here |
| deterministic | tests only | rule-based, extractive, reproducible; enabled only by `CLAN_AI_PROVIDER=deterministic` |

A vendor-specific adapter (e.g. one using a vendor's official SDK) can be added behind the same interface without touching
the domain model.

## Settings (Me › AI)
Provider, address, model, optional embedding model, display name; “Use only my CLAN sources” (default on — general
knowledge, when allowed, is shown in a separate section); semantic search (opt-in, sends passages to the embedding
model); Diary permission; Rebuild index; Delete AI history. Non-secret settings live in `ai_settings`.

## Credentials
Desktop: Electron `safeStorage` (Keychain / DPAPI / libsecret), one file per provider address
(`keys/ai-<sha256(address)>.enc`, mode 0600), read only when a request goes to that address. Phone: `expo-secure-store`
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), keyed by address. Keys are write-only from the UI (“saved” / replace / delete), never in
SQLite, preferences, logs, diagnostics, prompts or the renderer, and never sent to another address. Provider error text is
redacted of key-like strings. No secure storage → CLAN refuses to store a key.

## Usage
`ai_usage` keeps only provider, model, action, token counts if reported, number of sources, duration, outcome — for the
diagnostics line and Me › AI. No content, no analytics.

## Live evaluation
Not run in this phase: no development credential is configured on this machine. Normal tests never call an external API.
