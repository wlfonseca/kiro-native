# kiro-native

A native [opencode](https://opencode.ai) provider for **Kiro** models (GLM, Claude, GPT, DeepSeek, Qwen, MiniMax) that talks **directly** to the Kiro API — no `kiro-cli` subprocess, no ACP bridge, no MCP round-trips.

It authenticates with the same Kiro login you already have (the token stored by `kiro-cli`), lists the live model catalog, and streams chat with full tool-use (agentic loop), as an AI SDK `LanguageModelV3` provider that opencode loads directly.

## Why

The existing integration path runs `kiro-cli` as a subprocess and talks the Agent Client Protocol to it, which adds process spin-up, a ~14s model-discovery step, and extra hops on every turn. `kiro-native` removes all of that and calls the Kiro backend over plain HTTPS, so latency drops to the backend round-trip.

## Requirements

- opencode v2 (tested on 2.0.26)
- A Kiro login. Either run this package's own login (`npm run login`, below) — no `kiro-cli` needed — or reuse an existing `kiro-cli login`. Either way the provider never spawns `kiro-cli`.

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
      "models":       {
        "auto": {
          "name": "Auto",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 64000
          }
        },
        "claude-opus-5.5": {
          "name": "Claude Opus 5.5",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        },
        "claude-sonnet-5.5": {
          "name": "Claude Sonnet 5.5",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        },
        "gpt-5.6-sol": {
          "name": "GPT-5.6 Sol",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        },
        "gpt-5.6-terra": {
          "name": "GPT-5.6 Terra",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        },
        "gpt-5.6-luna": {
          "name": "GPT-5.6 Luna",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        },
        "claude-fable-5.1": {
          "name": "Claude Fable 5.1",
          "tool_call": true,
          "limit": {
            "context": 1000000,
            "output": 128000
          }
        },
        "claude-haiku-4.5": {
          "name": "Claude Haiku 4.5",
          "tool_call": true,
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "deepseek-3.2": {
          "name": "DeepSeek 3.2",
          "tool_call": true,
          "limit": {
            "context": 164000,
            "output": 64000
          }
        },
        "minimax-m2.5": {
          "name": "MiniMax M2.5",
          "tool_call": true,
          "limit": {
            "context": 196000,
            "output": 64000
          }
        },
        "glm-5": {
          "name": "GLM-5",
          "tool_call": true,
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "qwen3-coder-next": {
          "name": "Qwen3 Coder Next",
          "tool_call": true,
          "limit": {
            "context": 256000,
            "output": 64000
          }
        }
      }
    }
  }
}
```

The `models` value is a JSON **object** (not a string) — the block above is the full catalog, also in [`models.json`](./models.json). Regenerate it from the live catalog with `listModels()` in `src/kiro.ts`. Then select `kiro-native/glm-5` (or any model) in opencode.

## Login

This package can do the Kiro login itself (AWS SSO OIDC device flow), so `kiro-cli` is optional:

```bash
npm run login
```

It prints a URL + code; open it, approve, done. The token is stored in `~/.local/share/kiro-native/auth.json` and refreshed automatically. Env overrides: `KIRO_START_URL` (default `https://onnuage.awsapps.com/start`), `KIRO_REGION` (default `us-east-1`), `KIRO_PROFILE_ARN` (if the profile can't be resolved automatically).

If you already use `kiro-cli`, you can skip this — the provider falls back to the token `kiro-cli` stores.

**Auto-login:** if there is no valid token when you send a message, the provider shows the approval URL right in the chat and finishes the login in the background; approve in the browser and send your message again. `npm run login` is the explicit, guaranteed path.

## How it works

- **Auth**: uses the token from this package's own login (`~/.local/share/kiro-native/auth.json`) when present, otherwise falls back to the one `kiro-cli` stores (`~/.local/share/kiro-cli/data.sqlite3`). Refreshes automatically via AWS SSO OIDC when near expiry or on `401/403`, writing the rotated token back to whichever store it came from.
- **Models**: `KiroControlPlaneBearerService.ListAvailableModels` on `management.<region>.kiro.dev`.
- **Chat**: `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` on `runtime.<region>.kiro.dev`, parsing the `application/vnd.amazon.eventstream` response into AI SDK stream parts (`text-delta`, `tool-call`, `finish`).
- **Tools**: opencode tools map to Kiro `toolSpecification`; `toolUseEvent`s map back to AI SDK tool calls; results flow back as `toolResults`.

## Caveats

- **Unofficial client.** This calls the Kiro backend directly instead of through the official client. It replicates the official client's headers, so requests look the same on the wire, but using your Kiro subscription outside the official clients may violate the provider's Terms of Service. Use at your own risk.
- Reads your local `kiro-cli` token; never sends it anywhere except the Kiro API.
- Region is `us-east-1` by default; other regions exist (`eu-central-1`, gov/iso) but are not wired into the config yet.

## License

MIT
