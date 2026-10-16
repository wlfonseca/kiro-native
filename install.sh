#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PROVIDER_NAME="kiro-native"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mx\033[0m %s\n' "$*" >&2; }

command -v node >/dev/null 2>&1 || { err "node não encontrado no PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm não encontrado no PATH"; exit 1; }

log "Instalando dependências em $REPO_DIR"
( cd "$REPO_DIR" && npm install --silent )

log "Build"
( cd "$REPO_DIR" && npm run build --silent )

[ -f "$REPO_DIR/dist/index.js" ] || { err "build não gerou dist/index.js"; exit 1; }
[ -f "$REPO_DIR/models.json" ] || { err "models.json ausente no repositório"; exit 1; }

mkdir -p "$CONFIG_DIR"

TARGET=""
if [ -f "$CONFIG_DIR/opencode.jsonc" ]; then
  TARGET="$CONFIG_DIR/opencode.jsonc"
elif [ -f "$CONFIG_DIR/opencode.json" ]; then
  TARGET="$CONFIG_DIR/opencode.json"
else
  TARGET="$CONFIG_DIR/opencode.json"
  printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$TARGET"
  log "Nenhum config existente, criado $TARGET"
fi

log "Config que o opencode lê: $TARGET"

if [ -s "$TARGET" ]; then
  BACKUP="$TARGET.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$TARGET" "$BACKUP"
  log "Backup: $BACKUP"
fi

REPO_DIR="$REPO_DIR" PROVIDER_NAME="$PROVIDER_NAME" TARGET="$TARGET" node <<'NODE'
const fs = require("fs");
const path = require("path");

const repo = process.env.REPO_DIR;
const name = process.env.PROVIDER_NAME;
const target = process.env.TARGET;

function stripJsonc(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const models = JSON.parse(fs.readFileSync(path.join(repo, "models.json"), "utf8"));

let cfg = {};
const raw = fs.readFileSync(target, "utf8").trim();
if (raw.length) {
  try {
    cfg = JSON.parse(stripJsonc(raw));
  } catch (e) {
    console.error("x config existente não é JSON/JSONC válido: " + e.message);
    process.exit(1);
  }
}

if (!cfg["$schema"]) cfg["$schema"] = "https://opencode.ai/config.json";
if (cfg.autoupdate === undefined) cfg.autoupdate = false;
cfg.provider = cfg.provider || {};
cfg.provider[name] = {
  npm: repo,
  name: "Kiro Native",
  models,
};

fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
console.log("==> provider." + name + " gravado com " + Object.keys(models).length + " modelos");
NODE

log "Validando com opencode models"
if command -v opencode >/dev/null 2>&1; then
  COUNT=0
  for attempt in 1 2 3 4 5; do
    COUNT="$(opencode models 2>/dev/null | grep -c "^$PROVIDER_NAME/" || true)"
    [ "$COUNT" -gt 0 ] && break
    sleep 2
  done
  if [ "$COUNT" -gt 0 ]; then
    log "OK: $COUNT modelos $PROVIDER_NAME listando"
  else
    err "opencode não listou modelos $PROVIDER_NAME — confira $TARGET"
    exit 1
  fi
else
  err "opencode não está no PATH; pulei a validação. Rode: opencode models | grep $PROVIDER_NAME"
fi

log "Pronto. Login: (cd \"$REPO_DIR\" && npm run login) — ou reaproveita o login do kiro-cli."
