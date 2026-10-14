import { homedir } from "node:os"
import { join } from "node:path"

const MANAGEMENT = "https://management.us-east-1.kiro.dev"
const RUNTIME = "https://runtime.us-east-1.kiro.dev"

function ua(api: string): string {
  return `aws-sdk-rust/1.3.15 ua/2.1 api/${api} os/linux lang/rust/1.92.0 md/appVersion-2.30.0 app/AmazonQ-For-CLI acp-client/opencode-kiro`
}
function xua(api: string): string {
  return `aws-sdk-rust/1.3.15 ua/2.1 api/${api} os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI`
}

export interface KiroAuth {
  accessToken: string
  profileArn: string
}

async function readSqliteValue(dbPath: string, key: string): Promise<string | undefined> {
  const errs: string[] = []
  const tryCopy = async (): Promise<string> => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = path.join(os.tmpdir(), `kiro-auth-${process.pid}-${Date.now()}.sqlite3`)
    fs.copyFileSync(dbPath, tmp)
    for (const ext of ["-wal", "-shm"]) {
      try { if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, tmp + ext) } catch {}
    }
    return tmp
  }
  const readWith = async (p: string): Promise<string | undefined> => {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new (Database as any)(p, { readonly: true })
      const row = db.query("select value from auth_kv where key = ?").get(key) as { value?: string } | null
      db.close()
      return row?.value
    } catch (e: any) { errs.push("bun:sqlite " + (e?.message ?? e)) }
    try {
      const sqlite = await import("node:sqlite")
      const db = new (sqlite as any).DatabaseSync(p, { readOnly: true })
      const row = db.prepare("select value from auth_kv where key = ?").get(key) as { value?: string } | undefined
      db.close()
      return row?.value
    } catch (e: any) { errs.push("node:sqlite " + (e?.message ?? e)) }
    return undefined
  }
  let v = await readWith(dbPath)
  if (v !== undefined) return v
  try {
    const copy = await tryCopy()
    v = await readWith(copy)
    try { (await import("node:fs")).rmSync(copy, { force: true }) } catch {}
    if (v !== undefined) return v
  } catch (e: any) { errs.push("copy " + (e?.message ?? e)) }
  if (errs.length) throw new Error("sqlite read failed: " + errs.join(" | "))
  return undefined
}

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:633817512232:profile/3WUKKGNRPYVP"
const DB_PATH = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3")
const TOKEN_KEY = "kirocli:odic:token"
const REG_KEY = "kirocli:odic:device-registration"

interface StoredToken {
  access_token: string
  expires_at?: string
  refresh_token?: string
  region?: string
  [k: string]: any
}

async function writeSqliteValue(key: string, value: string): Promise<void> {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new (Database as any)(DB_PATH)
    db.query("update auth_kv set value = ? where key = ?").run(value, key)
    db.close()
    return
  } catch {}
  try {
    const sqlite = await import("node:sqlite")
    const db = new (sqlite as any).DatabaseSync(DB_PATH)
    db.prepare("update auth_kv set value = ? where key = ?").run(value, key)
    db.close()
  } catch {}
}

async function refreshToken(tok: StoredToken): Promise<StoredToken> {
  const regRaw = await readSqliteValue(DB_PATH, REG_KEY)
  if (!regRaw || !tok.refresh_token) throw new Error("cannot refresh: missing device-registration or refresh_token")
  const reg = JSON.parse(regRaw) as { client_id: string; client_secret: string; region?: string }
  const region = tok.region ?? reg.region ?? "us-east-1"
  const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: reg.client_id,
      clientSecret: reg.client_secret,
      grantType: "refresh_token",
      refreshToken: tok.refresh_token,
    }),
  })
  if (!res.ok) throw new Error(`OIDC refresh ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { accessToken: string; expiresIn: number; refreshToken?: string }
  const updated: StoredToken = {
    ...tok,
    access_token: data.accessToken,
    expires_at: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
    refresh_token: data.refreshToken ?? tok.refresh_token,
  }
  await writeSqliteValue(TOKEN_KEY, JSON.stringify(updated))
  return updated
}

let cached: { auth: KiroAuth; until: number } | undefined

export async function loadAuth(force = false): Promise<KiroAuth> {
  if (!force && cached && Date.now() < cached.until) return cached.auth
  const raw = await readSqliteValue(DB_PATH, TOKEN_KEY)
  if (!raw) throw new Error("kiro token not found in auth_kv")
  let tok = JSON.parse(raw) as StoredToken
  const expMs = tok.expires_at ? Date.parse(tok.expires_at) : 0
  if (force || !expMs || expMs - Date.now() < 120_000) {
    try { tok = await refreshToken(tok) } catch (e) { if (!expMs || expMs < Date.now()) throw e }
  }
  const auth: KiroAuth = { accessToken: tok.access_token, profileArn: PROFILE_ARN }
  const newExp = tok.expires_at ? Date.parse(tok.expires_at) : Date.now() + 60_000
  cached = { auth, until: Math.min(newExp - 60_000, Date.now() + 300_000) }
  return auth
}

function amzHeaders(auth: KiroAuth, target: string, api: string): Record<string, string> {
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
    Accept: "*/*",
  }
}

export interface KiroModel {
  modelId: string
  modelName?: string
  tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number }
  rateMultiplier?: number
  supportedInputTypes?: string[]
}

export async function listModels(): Promise<KiroModel[]> {
  const send = async (auth: KiroAuth): Promise<Response> =>
    fetch(MANAGEMENT + "/", {
      method: "POST",
      headers: amzHeaders(auth, "KiroControlPlaneBearerService.ListAvailableModels", "kirocontrolplanebearer/0.1.0"),
      body: JSON.stringify({ origin: "KIRO_CLI", profileArn: auth.profileArn }),
    })
  let res = await send(await loadAuth())
  if (res.status === 401 || res.status === 403) res = await send(await loadAuth(true))
  if (!res.ok) throw new Error(`ListAvailableModels ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { models?: KiroModel[] }
  return data.models ?? []
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < buf.length) {
    const nameLen = buf[i]; i += 1
    const name = new TextDecoder().decode(buf.subarray(i, i + nameLen)); i += nameLen
    const type = buf[i]; i += 1
    if (type === 7) {
      const vl = (buf[i] << 8) | buf[i + 1]; i += 2
      out[name] = new TextDecoder().decode(buf.subarray(i, i + vl)); i += vl
    } else break
  }
  return out
}

export interface KiroEvent {
  type: string
  payload: any
}

function u32(b: Uint8Array, o: number) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

function* parseEventStream(buf: Uint8Array): Generator<KiroEvent> {
  let i = 0
  while (i + 12 <= buf.length) {
    const total = u32(buf, i)
    const hlen = u32(buf, i + 4)
    if (total < 16 || i + total > buf.length) break
    const headers = parseHeaders(buf.subarray(i + 12, i + 12 + hlen))
    const payload = buf.subarray(i + 12 + hlen, i + total - 4)
    let parsed: any = undefined
    try { parsed = JSON.parse(new TextDecoder().decode(payload)) } catch {}
    yield { type: headers[":event-type"] ?? "", payload: parsed }
    i += total
  }
}

export interface GenerateInput {
  history?: any[]
  currentMessage: any
  conversationId?: string
}

export async function* generate(input: GenerateInput): AsyncGenerator<KiroEvent> {
  const send = async (auth: KiroAuth): Promise<Response> => {
    const body = {
      profileArn: auth.profileArn,
      conversationState: {
        conversationId: input.conversationId ?? crypto.randomUUID(),
        history: input.history ?? [],
        currentMessage: input.currentMessage,
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe",
      },
    }
    return fetch(RUNTIME + "/", {
      method: "POST",
      headers: amzHeaders(auth, "AmazonCodeWhispererStreamingService.GenerateAssistantResponse", "codewhispererstreaming/0.1.17975"),
      body: JSON.stringify(body),
    })
  }
  let res = await send(await loadAuth())
  if (res.status === 401 || res.status === 403) {
    res = await send(await loadAuth(true))
  }
  if (!res.ok || !res.body) throw new Error(`Generate ${res.status}: ${await res.text()}`)
  const reader = res.body.getReader()
  let buf = new Uint8Array(0)
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const next = new Uint8Array(buf.length + value.length)
    next.set(buf); next.set(value, buf.length)
    buf = next
    let consumed = 0
    while (consumed + 12 <= buf.length) {
      const total = u32(buf, consumed)
      if (total < 16 || consumed + total > buf.length) break
      const frame = buf.subarray(consumed, consumed + total)
      for (const ev of parseEventStream(frame)) yield ev
      consumed += total
    }
    buf = buf.subarray(consumed)
  }
}
