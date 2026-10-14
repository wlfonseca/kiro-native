import { generate, authMessage } from "./kiro.js"

type Part = { type: string; [k: string]: any }

function partsText(parts: Part[]): string {
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("")
}

function toolResultBlock(output: any): any {
  if (!output) return { text: "" }
  if (output.type === "text" || output.type === "error-text") return { text: String(output.value ?? "") }
  if (output.type === "json" || output.type === "error-json") return { json: output.value }
  if (output.type === "content" && Array.isArray(output.value)) {
    return { text: output.value.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") }
  }
  return { text: typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? "") }
}

function isErrorOutput(output: any): boolean {
  return output?.type === "error-text" || output?.type === "error-json" || output?.type === "execution-denied"
}

function toKiroTools(tools: any[] | undefined): any[] {
  return (tools ?? [])
    .filter((t) => t.type === "function")
    .map((t) => ({
      toolSpecification: {
        name: t.name,
        description: t.description ?? "",
        inputSchema: { json: t.inputSchema ?? { type: "object", properties: {} } },
      },
    }))
}

function buildConversation(prompt: any[], tools: any[] | undefined, modelId: string): { history: any[]; currentMessage: any } {
  const msgs: any[] = []
  const systemText: string[] = []

  for (const m of prompt) {
    const role = m.role
    if (role === "system") {
      systemText.push(typeof m.content === "string" ? m.content : partsText(m.content ?? []))
      continue
    }
    const parts: Part[] = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]
    if (role === "user") {
      msgs.push({ userInputMessage: { content: partsText(parts) || "", origin: "KIRO_CLI", userInputMessageContext: {} } })
    } else if (role === "assistant") {
      const toolUses = parts
        .filter((p) => p.type === "tool-call")
        .map((p) => ({ toolUseId: p.toolCallId, name: p.toolName, input: p.input ?? {} }))
      const arm: any = { content: partsText(parts) || "" }
      if (toolUses.length) arm.toolUses = toolUses
      msgs.push({ assistantResponseMessage: arm })
    } else if (role === "tool") {
      const results = parts
        .filter((p) => p.type === "tool-result")
        .map((p) => ({
          toolUseId: p.toolCallId,
          content: [toolResultBlock(p.output)],
          status: isErrorOutput(p.output) ? "error" : "success",
        }))
      msgs.push({ userInputMessage: { content: "", origin: "KIRO_CLI", userInputMessageContext: { toolResults: results } } })
    }
  }

  if (systemText.length > 0) {
    const firstUser = msgs.find((x) => x.userInputMessage)
    const sys = systemText.join("\n")
    if (firstUser) firstUser.userInputMessage.content = sys + (firstUser.userInputMessage.content ? "\n\n" + firstUser.userInputMessage.content : "")
    else msgs.unshift({ userInputMessage: { content: sys, origin: "KIRO_CLI", userInputMessageContext: {} } })
  }

  let current = msgs.pop()
  if (!current || !current.userInputMessage) {
    if (current) msgs.push(current)
    current = { userInputMessage: { content: "", origin: "KIRO_CLI", userInputMessageContext: {} } }
  }
  const uim = current.userInputMessage
  uim.modelId = modelId
  uim.userInputMessageContext = uim.userInputMessageContext ?? {}
  const kiroTools = toKiroTools(tools)
  if (kiroTools.length > 0) uim.userInputMessageContext.tools = kiroTools

  return { history: msgs, currentMessage: current }
}

export class KiroNativeLanguageModel {
  readonly specificationVersion = "v3" as const
  readonly provider = "kiro-native"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(modelId: string) {
    this.modelId = modelId
  }

  private usage(outChars: number): any {
    const out = outChars > 0 ? Math.round(outChars / 4) : undefined
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: out, text: out, reasoning: undefined },
    }
  }

  private mapStop(stop: string, hadTool: boolean): { unified: string; raw: string } {
    if (hadTool || stop === "TOOL_USE") return { unified: "tool-calls", raw: stop || "TOOL_USE" }
    if (stop === "MAX_TOKENS") return { unified: "length", raw: stop }
    return { unified: "stop", raw: stop || "END_TURN" }
  }

  async doStream(options: any): Promise<any> {
    const { history, currentMessage } = buildConversation(options.prompt, options.tools, this.modelId)
    const mapStop = this.mapStop.bind(this)
    const mkUsage = this.usage.bind(this)
    const stream = new ReadableStream({
      async start(controller) {
        const textId = "txt-0"
        let textStarted = false
        let outChars = 0
        let stop = "stop"
        const toolAcc = new Map<string, { name: string; input: string; started: boolean }>()
        let hadTool = false
        try {
          const loginNeeded = await authMessage()
          if (loginNeeded) { controller.error(new Error(loginNeeded)); return }
          controller.enqueue({ type: "stream-start", warnings: [] })
          for await (const ev of generate({ history, currentMessage })) {
            if (ev.type === "assistantResponseEvent") {
              const delta = ev.payload?.content ?? ""
              if (!delta) continue
              if (!textStarted) { controller.enqueue({ type: "text-start", id: textId }); textStarted = true }
              controller.enqueue({ type: "text-delta", id: textId, delta })
              outChars += delta.length
            } else if (ev.type === "toolUseEvent") {
              const p = ev.payload ?? {}
              const id = p.toolUseId
              if (!id) continue
              let acc = toolAcc.get(id)
              if (!acc) {
                acc = { name: p.name ?? "", input: "", started: false }
                toolAcc.set(id, acc)
              }
              if (!acc.started) {
                controller.enqueue({ type: "tool-input-start", id, toolName: acc.name || p.name || "" })
                acc.started = true
              }
              if (typeof p.input === "string" && p.input.length > 0) {
                acc.input += p.input
                controller.enqueue({ type: "tool-input-delta", id, delta: p.input })
              }
              if (p.stop === true) {
                controller.enqueue({ type: "tool-input-end", id })
                let input: any = {}
                try { input = acc.input ? JSON.parse(acc.input) : {} } catch { input = {} }
                controller.enqueue({ type: "tool-call", toolCallId: id, toolName: acc.name, input: JSON.stringify(input) })
                hadTool = true
              }
            } else if (ev.type === "metadataEvent") {
              stop = ev.payload?.stopReason ?? stop
            }
          }
          if (textStarted) controller.enqueue({ type: "text-end", id: textId })
          controller.enqueue({ type: "finish", finishReason: mapStop(stop, hadTool), usage: mkUsage(outChars) })
          controller.close()
        } catch (err: any) {
          controller.enqueue({ type: "error", error: err?.message ?? String(err) })
          controller.close()
        }
      },
    })
    return { stream }
  }

  async doGenerate(options: any): Promise<any> {
    const loginNeeded = await authMessage()
    if (loginNeeded) throw new Error(loginNeeded)
    const { history, currentMessage } = buildConversation(options.prompt, options.tools, this.modelId)
    const content: any[] = []
    let text = ""
    let stop = "stop"
    const toolAcc = new Map<string, { name: string; input: string }>()
    let hadTool = false
    for await (const ev of generate({ history, currentMessage })) {
      if (ev.type === "assistantResponseEvent") text += ev.payload?.content ?? ""
      else if (ev.type === "toolUseEvent") {
        const p = ev.payload ?? {}
        if (!p.toolUseId) continue
        let acc = toolAcc.get(p.toolUseId)
        if (!acc) { acc = { name: p.name ?? "", input: "" }; toolAcc.set(p.toolUseId, acc) }
        if (typeof p.input === "string") acc.input += p.input
        if (p.stop === true) {
          let input: any = {}
          try { input = acc.input ? JSON.parse(acc.input) : {} } catch { input = {} }
          content.push({ type: "tool-call", toolCallId: p.toolUseId, toolName: acc.name, input: JSON.stringify(input) })
          hadTool = true
        }
      } else if (ev.type === "metadataEvent") stop = ev.payload?.stopReason ?? stop
    }
    if (text) content.unshift({ type: "text", text })
    return { content, finishReason: this.mapStop(stop, hadTool), usage: this.usage(text.length), warnings: [] }
  }
}
