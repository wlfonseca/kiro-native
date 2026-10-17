// src/kiro.ts
import { homedir } from "os";
import { join } from "path";
var MANAGEMENT = "https://management.us-east-1.kiro.dev";
var RUNTIME = "https://runtime.us-east-1.kiro.dev";
function ua(api) {
  return `aws-sdk-rust/1.3.15 ua/2.1 api/${api} os/linux lang/rust/1.92.0 md/appVersion-2.30.0 app/AmazonQ-For-CLI acp-client/opencode-kiro`;
}
function xua(api) {
  return `aws-sdk-rust/1.3.15 ua/2.1 api/${api} os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI`;
}
async function readSqliteValue(dbPath, key, table = "auth_kv") {
  const errs = [];
  const sql = `select value from ${table} where key = ?`;
  const tryCopy = async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmp = path.join(os.tmpdir(), `kiro-auth-${process.pid}-${Date.now()}.sqlite3`);
    fs.copyFileSync(dbPath, tmp);
    for (const ext of ["-wal", "-shm"]) {
      try {
        if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, tmp + ext);
      } catch {
      }
    }
    return tmp;
  };
  const readWith = async (p) => {
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(p, { readonly: true });
      const row = db.query(sql).get(key);
      db.close();
      return row == null ? void 0 : row.value;
    } catch (e) {
      errs.push("bun:sqlite " + ((e == null ? void 0 : e.message) ?? e));
    }
    try {
      const sqlite = await import("sqlite");
      const db = new sqlite.DatabaseSync(p, { readOnly: true });
      const row = db.prepare(sql).get(key);
      db.close();
      return row == null ? void 0 : row.value;
    } catch (e) {
      errs.push("node:sqlite " + ((e == null ? void 0 : e.message) ?? e));
    }
    return void 0;
  };
  let v = await readWith(dbPath);
  if (v !== void 0) return v;
  try {
    const copy = await tryCopy();
    v = await readWith(copy);
    try {
      (await import("fs")).rmSync(copy, { force: true });
    } catch {
    }
    if (v !== void 0) return v;
  } catch (e) {
    errs.push("copy " + ((e == null ? void 0 : e.message) ?? e));
  }
  if (errs.length) throw new Error("sqlite read failed: " + errs.join(" | "));
  return void 0;
}
var DB_PATH = process.env.KIRO_DB_PATH ?? join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
var TOKEN_KEY = "kirocli:odic:token";
var REG_KEY = "kirocli:odic:device-registration";
var NATIVE_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-native");
var NATIVE_STORE = join(NATIVE_DIR, "auth.json");
var SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"];
var DEFAULT_START_URL = "https://onnuage.awsapps.com/start";
async function writeSqliteValue(key, value) {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(DB_PATH);
    db.query("update auth_kv set value = ? where key = ?").run(value, key);
    db.close();
    return;
  } catch {
  }
  try {
    const sqlite = await import("sqlite");
    const db = new sqlite.DatabaseSync(DB_PATH);
    db.prepare("update auth_kv set value = ? where key = ?").run(value, key);
    db.close();
  } catch {
  }
}
async function readNative() {
  var _a;
  try {
    const fs = await import("fs");
    const d = JSON.parse(fs.readFileSync(NATIVE_STORE, "utf8"));
    if (!((_a = d == null ? void 0 : d.token) == null ? void 0 : _a.access_token)) return void 0;
    return { tok: d.token, reg: d.registration, profileArn: d.profileArn, source: "native" };
  } catch {
    return void 0;
  }
}
async function writeNative(src) {
  const fs = await import("fs");
  fs.mkdirSync(NATIVE_DIR, { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(NATIVE_STORE, "utf8"));
  } catch {
  }
  const out = {
    token: src.tok,
    registration: src.reg ?? existing.registration,
    profileArn: src.profileArn ?? existing.profileArn
  };
  fs.writeFileSync(NATIVE_STORE, JSON.stringify(out, null, 2), { mode: 384 });
}
async function readKiroCli() {
  try {
    const raw = await readSqliteValue(DB_PATH, TOKEN_KEY);
    if (!raw) return void 0;
    const tok = JSON.parse(raw);
    let reg;
    try {
      const regRaw = await readSqliteValue(DB_PATH, REG_KEY);
      if (regRaw) reg = JSON.parse(regRaw);
    } catch {
    }
    return { tok, reg, source: "kirocli" };
  } catch {
    return void 0;
  }
}
async function loadSource() {
  const src = await readNative() ?? await readKiroCli();
  if (!src) throw new Error("sem login Kiro \u2014 rode `npm run login` aqui (ou `kiro-cli login`)");
  return src;
}
async function persist(src) {
  if (src.source === "native") await writeNative({ tok: src.tok, reg: src.reg, profileArn: src.profileArn });
  else await writeSqliteValue(TOKEN_KEY, JSON.stringify(src.tok));
}
async function refreshToken(src) {
  if (!src.reg || !src.tok.refresh_token) throw new Error("cannot refresh: missing registration or refresh_token");
  const region = src.tok.region ?? src.reg.region ?? "us-east-1";
  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: src.reg.client_id,
      clientSecret: src.reg.client_secret,
      grantType: "refresh_token",
      refreshToken: src.tok.refresh_token
    })
  });
  if (!res.ok) throw new Error(`OIDC refresh ${res.status}: ${await res.text()}`);
  const data = await res.json();
  src.tok = {
    ...src.tok,
    access_token: data.accessToken,
    expires_at: new Date(Date.now() + data.expiresIn * 1e3).toISOString(),
    refresh_token: data.refreshToken ?? src.tok.refresh_token
  };
  await persist(src);
  return src;
}
var cached;
async function resolveProfileArn(src) {
  if (process.env.KIRO_PROFILE_ARN) return process.env.KIRO_PROFILE_ARN;
  if (src.profileArn) return src.profileArn;
  const raw = await readSqliteValue(DB_PATH, "api.codewhisperer.profile", "state");
  if (raw) {
    const arn2 = JSON.parse(raw).arn;
    if (arn2) return arn2;
  }
  const arn = await firstProfileArn(src.tok);
  if (arn) {
    if (src.source === "native") {
      src.profileArn = arn;
      await writeNative({ tok: src.tok, reg: src.reg, profileArn: arn });
    }
    return arn;
  }
  throw new Error("perfil Kiro n\xE3o encontrado (defina KIRO_PROFILE_ARN ou rode o login)");
}
async function loadAuth(force = false) {
  if (!force && cached && Date.now() < cached.until) return cached.auth;
  let src = await loadSource();
  const expMs = src.tok.expires_at ? Date.parse(src.tok.expires_at) : 0;
  if (force || !expMs || expMs - Date.now() < 12e4) {
    try {
      src = await refreshToken(src);
    } catch (e) {
      if (!expMs || expMs < Date.now()) throw e;
    }
  }
  const auth = { accessToken: src.tok.access_token, profileArn: await resolveProfileArn(src) };
  const newExp = src.tok.expires_at ? Date.parse(src.tok.expires_at) : Date.now() + 6e4;
  cached = { auth, until: Math.min(newExp - 6e4, Date.now() + 3e5) };
  return auth;
}
async function firstProfileArn(tok) {
  var _a, _b;
  const region = tok.region ?? "us-east-1";
  try {
    const res = await fetch(`https://management.${region}.kiro.dev/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "KiroControlPlaneBearerService.ListAvailableProfiles",
        "User-Agent": ua("kirocontrolplanebearer/0.1.0"),
        "x-amz-user-agent": xua("kirocontrolplanebearer/0.1.0")
      },
      body: JSON.stringify({ origin: "KIRO_CLI" })
    });
    if (!res.ok) return void 0;
    const d = await res.json();
    return (_b = (_a = d.profiles) == null ? void 0 : _a[0]) == null ? void 0 : _b.arn;
  } catch {
    return void 0;
  }
}
function oidcPost(region, path, body) {
  return fetch(`https://oidc.${region}.amazonaws.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(async (r) => {
    const t = await r.text();
    let j = {};
    try {
      j = t ? JSON.parse(t) : {};
    } catch {
    }
    if (!r.ok && !j.error) throw new Error(`${path} ${r.status}: ${t}`);
    return { status: r.status, ...j };
  });
}
async function beginLogin(opts = {}) {
  var _a;
  const region = opts.region ?? process.env.KIRO_REGION ?? "us-east-1";
  let startUrl = opts.startUrl ?? process.env.KIRO_START_URL;
  if (!startUrl) {
    try {
      const s = await readSqliteValue(DB_PATH, "auth.idc.start-url", "state");
      startUrl = s ? JSON.parse(s) : DEFAULT_START_URL;
    } catch {
      startUrl = DEFAULT_START_URL;
    }
  }
  let clientId, clientSecret, secretExpiresAt;
  const prev = (_a = await readNative()) == null ? void 0 : _a.reg;
  const prevValid = (prev == null ? void 0 : prev.client_id) && (prev == null ? void 0 : prev.client_secret) && (!prev.client_secret_expires_at || prev.client_secret_expires_at * 1e3 > Date.now() + 6e4);
  if (prevValid) {
    clientId = prev.client_id;
    clientSecret = prev.client_secret;
    secretExpiresAt = prev.client_secret_expires_at;
  } else {
    const reg = await oidcPost(region, "/client/register", { clientName: "kiro-native", clientType: "public", scopes: SCOPES });
    clientId = reg.clientId;
    clientSecret = reg.clientSecret;
    secretExpiresAt = reg.clientSecretExpiresAt;
  }
  const dev = await oidcPost(region, "/device_authorization", { clientId, clientSecret, startUrl });
  return {
    url: dev.verificationUriComplete,
    userCode: dev.userCode,
    deviceCode: dev.deviceCode,
    clientId,
    clientSecret,
    secretExpiresAt,
    region,
    startUrl,
    intervalMs: (dev.interval ?? 5) * 1e3,
    expiresAt: Date.now() + (dev.expiresIn ?? 600) * 1e3
  };
}
async function completeLogin(b) {
  let interval = b.intervalMs;
  while (Date.now() < b.expiresAt) {
    await new Promise((r) => setTimeout(r, interval));
    const tr = await oidcPost(b.region, "/token", {
      clientId: b.clientId,
      clientSecret: b.clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: b.deviceCode
    });
    if (tr.accessToken) {
      const expiresAt = new Date(Date.now() + tr.expiresIn * 1e3).toISOString();
      const tok = { access_token: tr.accessToken, refresh_token: tr.refreshToken, expires_at: expiresAt, region: b.region, start_url: b.startUrl };
      const registration = { client_id: b.clientId, client_secret: b.clientSecret, region: b.region, client_secret_expires_at: b.secretExpiresAt };
      const profileArn = await firstProfileArn(tok);
      await writeNative({ tok, reg: registration, profileArn });
      cached = void 0;
      return { profileArn, accessToken: tr.accessToken, refreshToken: tr.refreshToken, expiresAt };
    }
    if (tr.error === "slow_down") interval += 5e3;
    else if (tr.error && tr.error !== "authorization_pending") throw new Error(`login falhou: ${tr.error} ${tr.error_description ?? ""}`);
  }
  throw new Error("login expirou sem aprova\xE7\xE3o");
}
async function login(opts = {}) {
  const b = await beginLogin(opts);
  console.log(`
Abra e aprove:
  ${b.url}
  (c\xF3digo: ${b.userCode})
`);
  const r = await completeLogin(b);
  console.log(`login ok${r.profileArn ? "" : " (defina KIRO_PROFILE_ARN \u2014 perfil n\xE3o resolvido)"} \u2192 ${NATIVE_STORE}`);
}
var pendingLogin;
function loginMsg(b) {
  return `\u{1F510} **Login Kiro necess\xE1rio.**

Abra e aprove no navegador:

  ${b.url}

  (c\xF3digo: ${b.userCode})

Depois de aprovar, **envie a mensagem novamente** \u2014 o login \xE9 conclu\xEDdo em segundo plano.
`;
}
async function authMessage() {
  try {
    await loadAuth();
    return void 0;
  } catch {
  }
  if (!pendingLogin) {
    const begin = await beginLogin();
    const done = completeLogin(begin).then(() => {
    }).catch(() => {
    }).finally(() => {
      pendingLogin = void 0;
    });
    pendingLogin = { begin, done };
  }
  return loginMsg(pendingLogin.begin);
}
function amzHeaders(auth, target, api) {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    "X-Amz-Target": target,
    "User-Agent": ua(api),
    "x-amz-user-agent": xua(api),
    "x-amzn-codewhisperer-optout": "false",
    "x-kiro-attempt": "1;max=3",
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    Accept: "*/*"
  };
}
async function listModels() {
  const send = async (auth) => fetch(MANAGEMENT + "/", {
    method: "POST",
    headers: amzHeaders(auth, "KiroControlPlaneBearerService.ListAvailableModels", "kirocontrolplanebearer/0.1.0"),
    body: JSON.stringify({ origin: "KIRO_CLI", profileArn: auth.profileArn })
  });
  let res = await send(await loadAuth());
  if (res.status === 401 || res.status === 403) res = await send(await loadAuth(true));
  if (!res.ok) throw new Error(`ListAvailableModels ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.models ?? [];
}
function parseHeaders(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const nameLen = buf[i];
    i += 1;
    const name = new TextDecoder().decode(buf.subarray(i, i + nameLen));
    i += nameLen;
    const type = buf[i];
    i += 1;
    if (type === 7) {
      const vl = buf[i] << 8 | buf[i + 1];
      i += 2;
      out[name] = new TextDecoder().decode(buf.subarray(i, i + vl));
      i += vl;
    } else break;
  }
  return out;
}
function u32(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}
function* parseEventStream(buf) {
  let i = 0;
  while (i + 12 <= buf.length) {
    const total = u32(buf, i);
    const hlen = u32(buf, i + 4);
    if (total < 16 || i + total > buf.length) break;
    const headers = parseHeaders(buf.subarray(i + 12, i + 12 + hlen));
    const payload = buf.subarray(i + 12 + hlen, i + total - 4);
    let parsed = void 0;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload));
    } catch {
    }
    yield { type: headers[":event-type"] ?? "", payload: parsed };
    i += total;
  }
}
async function* generate(input) {
  const send = async (auth) => {
    const body = {
      profileArn: auth.profileArn,
      conversationState: {
        conversationId: input.conversationId ?? crypto.randomUUID(),
        history: input.history ?? [],
        currentMessage: input.currentMessage,
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe"
      }
    };
    return fetch(RUNTIME + "/", {
      method: "POST",
      headers: amzHeaders(auth, "AmazonCodeWhispererStreamingService.GenerateAssistantResponse", "codewhispererstreaming/0.1.17975"),
      body: JSON.stringify(body)
    });
  };
  let res = await send(await loadAuth());
  if (res.status === 401 || res.status === 403) {
    res = await send(await loadAuth(true));
  }
  if (!res.ok || !res.body) throw new Error(`Generate ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
    let consumed = 0;
    while (consumed + 12 <= buf.length) {
      const total = u32(buf, consumed);
      if (total < 16 || consumed + total > buf.length) break;
      const frame = buf.subarray(consumed, consumed + total);
      for (const ev of parseEventStream(frame)) yield ev;
      consumed += total;
    }
    buf = buf.subarray(consumed);
  }
}

// src/language-model.ts
function partsText(parts) {
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}
var IMAGE_FORMATS = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp"
};
function imageBlocks(parts) {
  const images = [];
  for (const p of parts) {
    if (p.type !== "file") continue;
    const mediaType = String(p.mediaType ?? "").toLowerCase();
    if (!mediaType.startsWith("image/")) continue;
    const format = IMAGE_FORMATS[mediaType];
    if (!format) continue;
    const data = p.data;
    let bytes;
    if (data instanceof Uint8Array) bytes = Buffer.from(data).toString("base64");
    else if (typeof data === "string" && data.startsWith("data:")) bytes = data.slice(data.indexOf(",") + 1);
    else if (typeof data === "string") bytes = data;
    else continue;
    images.push({ format, source: { bytes } });
  }
  return images;
}
function toolResultBlock(output) {
  if (!output) return { text: "" };
  if (output.type === "text" || output.type === "error-text") return { text: String(output.value ?? "") };
  if (output.type === "json" || output.type === "error-json") return { json: output.value };
  if (output.type === "content" && Array.isArray(output.value)) {
    return { text: output.value.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
  }
  return { text: typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? "") };
}
function isErrorOutput(output) {
  return (output == null ? void 0 : output.type) === "error-text" || (output == null ? void 0 : output.type) === "error-json" || (output == null ? void 0 : output.type) === "execution-denied";
}
function toKiroTools(tools) {
  return (tools ?? []).filter((t) => t.type === "function").map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description ?? "",
      inputSchema: { json: t.inputSchema ?? { type: "object", properties: {} } }
    }
  }));
}
function buildConversation(prompt, tools, modelId) {
  const msgs = [];
  const systemText = [];
  for (const m of prompt) {
    const role = m.role;
    if (role === "system") {
      systemText.push(typeof m.content === "string" ? m.content : partsText(m.content ?? []));
      continue;
    }
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    if (role === "user") {
      const images = imageBlocks(parts);
      const userInputMessage = { content: partsText(parts) || "", origin: "KIRO_CLI", userInputMessageContext: {} };
      if (images.length) userInputMessage.images = images;
      msgs.push({ userInputMessage });
    } else if (role === "assistant") {
      const toolUses = parts.filter((p) => p.type === "tool-call").map((p) => ({ toolUseId: p.toolCallId, name: p.toolName, input: p.input ?? {} }));
      const arm = { content: partsText(parts) || "" };
      if (toolUses.length) arm.toolUses = toolUses;
      msgs.push({ assistantResponseMessage: arm });
    } else if (role === "tool") {
      const results = parts.filter((p) => p.type === "tool-result").map((p) => ({
        toolUseId: p.toolCallId,
        content: [toolResultBlock(p.output)],
        status: isErrorOutput(p.output) ? "error" : "success"
      }));
      msgs.push({ userInputMessage: { content: "", origin: "KIRO_CLI", userInputMessageContext: { toolResults: results } } });
    }
  }
  if (systemText.length > 0) {
    const firstUser = msgs.find((x) => x.userInputMessage);
    const sys = systemText.join("\n");
    if (firstUser) firstUser.userInputMessage.content = sys + (firstUser.userInputMessage.content ? "\n\n" + firstUser.userInputMessage.content : "");
    else msgs.unshift({ userInputMessage: { content: sys, origin: "KIRO_CLI", userInputMessageContext: {} } });
  }
  let current = msgs.pop();
  if (!current || !current.userInputMessage) {
    if (current) msgs.push(current);
    current = { userInputMessage: { content: "", origin: "KIRO_CLI", userInputMessageContext: {} } };
  }
  const uim = current.userInputMessage;
  uim.modelId = modelId;
  uim.userInputMessageContext = uim.userInputMessageContext ?? {};
  const kiroTools = toKiroTools(tools);
  if (kiroTools.length > 0) uim.userInputMessageContext.tools = kiroTools;
  return { history: msgs, currentMessage: current };
}
var KiroNativeLanguageModel = class {
  specificationVersion = "v3";
  provider = "kiro-native";
  modelId;
  supportedUrls = {};
  constructor(modelId) {
    this.modelId = modelId;
  }
  usage(outChars) {
    const out = outChars > 0 ? Math.round(outChars / 4) : void 0;
    return {
      inputTokens: { total: void 0, noCache: void 0, cacheRead: void 0, cacheWrite: void 0 },
      outputTokens: { total: out, text: out, reasoning: void 0 }
    };
  }
  mapStop(stop, hadTool) {
    if (hadTool || stop === "TOOL_USE") return { unified: "tool-calls", raw: stop || "TOOL_USE" };
    if (stop === "MAX_TOKENS") return { unified: "length", raw: stop };
    return { unified: "stop", raw: stop || "END_TURN" };
  }
  async doStream(options) {
    const { history, currentMessage } = buildConversation(options.prompt, options.tools, this.modelId);
    const mapStop = this.mapStop.bind(this);
    const mkUsage = this.usage.bind(this);
    const stream = new ReadableStream({
      async start(controller) {
        var _a, _b;
        const textId = "txt-0";
        let textStarted = false;
        let outChars = 0;
        let stop = "stop";
        const toolAcc = /* @__PURE__ */ new Map();
        let hadTool = false;
        try {
          const loginNeeded = await authMessage();
          if (loginNeeded) {
            controller.error(new Error(loginNeeded));
            return;
          }
          controller.enqueue({ type: "stream-start", warnings: [] });
          for await (const ev of generate({ history, currentMessage })) {
            if (ev.type === "assistantResponseEvent") {
              const delta = ((_a = ev.payload) == null ? void 0 : _a.content) ?? "";
              if (!delta) continue;
              if (!textStarted) {
                controller.enqueue({ type: "text-start", id: textId });
                textStarted = true;
              }
              controller.enqueue({ type: "text-delta", id: textId, delta });
              outChars += delta.length;
            } else if (ev.type === "toolUseEvent") {
              const p = ev.payload ?? {};
              const id = p.toolUseId;
              if (!id) continue;
              let acc = toolAcc.get(id);
              if (!acc) {
                acc = { name: p.name ?? "", input: "", started: false };
                toolAcc.set(id, acc);
              }
              if (!acc.started) {
                controller.enqueue({ type: "tool-input-start", id, toolName: acc.name || p.name || "" });
                acc.started = true;
              }
              if (typeof p.input === "string" && p.input.length > 0) {
                acc.input += p.input;
                controller.enqueue({ type: "tool-input-delta", id, delta: p.input });
              }
              if (p.stop === true) {
                controller.enqueue({ type: "tool-input-end", id });
                let input = {};
                try {
                  input = acc.input ? JSON.parse(acc.input) : {};
                } catch {
                  input = {};
                }
                controller.enqueue({ type: "tool-call", toolCallId: id, toolName: acc.name, input: JSON.stringify(input) });
                hadTool = true;
              }
            } else if (ev.type === "metadataEvent") {
              stop = ((_b = ev.payload) == null ? void 0 : _b.stopReason) ?? stop;
            }
          }
          if (textStarted) controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({ type: "finish", finishReason: mapStop(stop, hadTool), usage: mkUsage(outChars) });
          controller.close();
        } catch (err) {
          controller.enqueue({ type: "error", error: (err == null ? void 0 : err.message) ?? String(err) });
          controller.close();
        }
      }
    });
    return { stream };
  }
  async doGenerate(options) {
    var _a, _b;
    const loginNeeded = await authMessage();
    if (loginNeeded) throw new Error(loginNeeded);
    const { history, currentMessage } = buildConversation(options.prompt, options.tools, this.modelId);
    const content = [];
    let text = "";
    let stop = "stop";
    const toolAcc = /* @__PURE__ */ new Map();
    let hadTool = false;
    for await (const ev of generate({ history, currentMessage })) {
      if (ev.type === "assistantResponseEvent") text += ((_a = ev.payload) == null ? void 0 : _a.content) ?? "";
      else if (ev.type === "toolUseEvent") {
        const p = ev.payload ?? {};
        if (!p.toolUseId) continue;
        let acc = toolAcc.get(p.toolUseId);
        if (!acc) {
          acc = { name: p.name ?? "", input: "" };
          toolAcc.set(p.toolUseId, acc);
        }
        if (typeof p.input === "string") acc.input += p.input;
        if (p.stop === true) {
          let input = {};
          try {
            input = acc.input ? JSON.parse(acc.input) : {};
          } catch {
            input = {};
          }
          content.push({ type: "tool-call", toolCallId: p.toolUseId, toolName: acc.name, input: JSON.stringify(input) });
          hadTool = true;
        }
      } else if (ev.type === "metadataEvent") stop = ((_b = ev.payload) == null ? void 0 : _b.stopReason) ?? stop;
    }
    if (text) content.unshift({ type: "text", text });
    return { content, finishReason: this.mapStop(stop, hadTool), usage: this.usage(text.length), warnings: [] };
  }
};

// src/provider.ts
function createKiroNative(_options = {}) {
  const make = (modelId) => new KiroNativeLanguageModel(modelId);
  return { languageModel: make, chat: make };
}

// src/index.ts
var index_default = createKiroNative;
export {
  KiroNativeLanguageModel,
  beginLogin,
  completeLogin,
  createKiroNative,
  index_default as default,
  listModels,
  loadAuth,
  login
};
