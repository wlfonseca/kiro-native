import { KiroNativeLanguageModel } from "./language-model.js"

export interface KiroNativeProvider {
  languageModel(modelId: string): KiroNativeLanguageModel
  chat(modelId: string): KiroNativeLanguageModel
}

export function createKiroNative(_options: Record<string, unknown> = {}): KiroNativeProvider {
  const make = (modelId: string) => new KiroNativeLanguageModel(modelId)
  return { languageModel: make, chat: make }
}

export { KiroNativeLanguageModel }
