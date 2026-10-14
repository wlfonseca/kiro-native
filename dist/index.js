// src/kiro.ts
import { homedir } from "os";
import { join } from "path";
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
var DB_PATH = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
var TOKEN_KEY = "kirocli:odic:token";
var REG_KEY = "kirocli:odic:device-registration";
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
async function refreshToken(tok) {
  const regRaw = await readSqliteValue(DB_PATH, REG_KEY);
  if (!regRaw || !tok.refresh_token) throw new Error("cannot refresh: missing device-registration or refresh_token");
  const reg = JSON.parse(regRaw);
  const region = tok.region ?? reg.region ?? "us-east-1";
  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: reg.client_id,
      clientSecret: reg.client_secret,
      grantType: "refresh_token",
      refreshToken: tok.refresh_token
    })
  });
  if (!res.ok) throw new Error(`OIDC refresh ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const updated = {
    ...tok,
    access_token: data.accessToken,
    expires_at: new Date(Date.now() + data.expiresIn * 1e3).toISOString(),
    refresh_token: data.refreshToken ?? tok.refresh_token
  };
  await writeSqliteValue(TOKEN_KEY, JSON.stringify(updated));
  return updated;
}
var cached;
var profileArnCache;
async function resolveProfileArn() {
  if (process.env.KIRO_PROFILE_ARN) return process.env.KIRO_PROFILE_ARN;
  if (profileArnCache) return profileArnCache;
  const raw = await readSqliteValue(DB_PATH, "api.codewhisperer.profile", "state");
  if (!raw) throw new Error("kiro profile not found (run `kiro-cli login`, or set KIRO_PROFILE_ARN)");
  const arn = JSON.parse(raw).arn;
  if (!arn) throw new Error("kiro profile arn missing in state");
  profileArnCache = arn;
  return arn;
}
async function loadAuth(force = false) {
  if (!force && cached && Date.now() < cached.until) return cached.auth;
  const raw = await readSqliteValue(DB_PATH, TOKEN_KEY);
  if (!raw) throw new Error("kiro token not found in auth_kv");
  let tok = JSON.parse(raw);
  const expMs = tok.expires_at ? Date.parse(tok.expires_at) : 0;
  if (force || !expMs || expMs - Date.now() < 12e4) {
    try {
      tok = await refreshToken(tok);
    } catch (e) {
      if (!expMs || expMs < Date.now()) throw e;
    }
  }
  const auth = { accessToken: tok.access_token, profileArn: await resolveProfileArn() };
  const newExp = tok.expires_at ? Date.parse(tok.expires_at) : Date.now() + 6e4;
  cached = { auth, until: Math.min(newExp - 6e4, Date.now() + 3e5) };
  return auth;
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
      msgs.push({ userInputMessage: { content: partsText(parts) || "", origin: "KIRO_CLI", userInputMessageContext: {} } });
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

// src/index.ts
function createKiroNative(_options = {}) {
  const make = (modelId) => new KiroNativeLanguageModel(modelId);
  return {
    languageModel: make,
    chat: make
  };
}
var index_default = createKiroNative;
export {
  KiroNativeLanguageModel,
  createKiroNative,
  index_default as default
};
