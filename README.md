# kiro-native

A native [opencode](https://opencode.ai) provider for **Kiro** models (GLM, Claude, GPT, DeepSeek, Qwen, MiniMax) that talks **directly** to the Kiro API — no `kiro-cli` subprocess, no ACP bridge, no MCP round-trips.

It authenticates with the same Kiro login you already have (the token stored by `kiro-cli`), lists the live model catalog, and streams chat with full tool-use (agentic loop), as an AI SDK `LanguageModelV3` provider that opencode loads directly.

## Why

The existing integration path runs `kiro-cli` as a subprocess and talks the Agent Client Protocol to it, which adds process spin-up, a ~14s model-discovery step, and extra hops on every turn. `kiro-native` removes all of that and calls the Kiro backend over plain HTTPS, so latency drops to the backend round-trip.

## Requirements

- opencode v2 (tested on 2.0.26)
- A working `kiro-cli` **login** (run `kiro-cli login` once). This package only reads the token `kiro-cli` stores; it never spawns `kiro-cli`.

## Install

```bash
git clone https://github.com/wlfonseca/kiro-native && cd kiro-native
npm install && npm run build
```

Add the provider to your opencode config (`~/.config/opencode/opencode.json`), pointing `npm` at the absolute path of the checkout:

```json
{
  "provider": {
    "kiro-native": {
      "npm": "/absolute/path/to/kiro-native",
      "name": "Kiro Native",
      "models": "see models.json"
    }
  }
}
```

Copy the ready-made 12-model block from [`models.json`](./models.json) into the `models` field above (or regenerate it from the live catalog — see `listModels()` in `src/kiro.ts`). Then select `kiro-native/glm-5` (or any model) in opencode.

## How it works

- **Auth**: reads the bearer token from `~/.local/share/kiro-cli/data.sqlite3` (`auth_kv` table). Refreshes it automatically via AWS SSO OIDC when it is about to expire or on a `401/403`, and writes the rotated token back so `kiro-cli` stays in sync.
- **Models**: `KiroControlPlaneBearerService.ListAvailableModels` on `management.<region>.kiro.dev`.
- **Chat**: `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` on `runtime.<region>.kiro.dev`, parsing the `application/vnd.amazon.eventstream` response into AI SDK stream parts (`text-delta`, `tool-call`, `finish`).
- **Tools**: opencode tools map to Kiro `toolSpecification`; `toolUseEvent`s map back to AI SDK tool calls; results flow back as `toolResults`.

## Caveats

- **Unofficial client.** This calls the Kiro backend directly instead of through the official client. It replicates the official client's headers, so requests look the same on the wire, but using your Kiro subscription outside the official clients may violate the provider's Terms of Service. Use at your own risk.
- Reads your local `kiro-cli` token; never sends it anywhere except the Kiro API.
- Region is `us-east-1` by default; other regions exist (`eu-central-1`, gov/iso) but are not wired into the config yet.

## License

MIT
