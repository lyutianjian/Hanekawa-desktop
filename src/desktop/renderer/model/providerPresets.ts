/**
 * The services the new-endpoint wizard offers by name. Each is one of the two
 * wire protocols plus the address it is reached at; the last two are the
 * protocols on their own, for anything not listed.
 */
export interface ProviderPreset {
  readonly id: string
  readonly label: string
  /** The connect page's title noun, where the card's label reads badly after 连接. */
  readonly service?: string
  readonly note: string
  readonly provider: 'anthropic' | 'openai'
  /** Absent: the SDK's own default, which `defaultUrl` names for the placeholder. */
  readonly baseUrl?: string
  readonly defaultUrl?: string
  /** A local server that ignores the key; the OpenAI SDK still refuses to send without one. */
  readonly keyOptional?: boolean
  /** Its model list is public, so a listing proves the address and not the key. */
  readonly publicModels?: boolean
  readonly exampleModel?: string
}

/** What a key-optional endpoint stores when the field is left empty. */
export const PLACEHOLDER_KEY = 'ollama'

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic', note: 'Claude 官方 API', provider: 'anthropic', defaultUrl: 'https://api.anthropic.com', exampleModel: 'claude-opus-5' },
  { id: 'openai', label: 'OpenAI', note: 'GPT 官方 API', provider: 'openai', defaultUrl: 'https://api.openai.com/v1', exampleModel: 'gpt-5' },
  { id: 'deepseek', label: 'DeepSeek', note: '深度求索开放平台', provider: 'openai', baseUrl: 'https://api.deepseek.com', exampleModel: 'deepseek-chat' },
  { id: 'moonshot', label: 'Kimi', note: '月之暗面开放平台', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', exampleModel: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', note: '智谱开放平台', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', exampleModel: 'glm-4-plus' },
  { id: 'qwen', label: '通义千问', note: '阿里云百炼', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', exampleModel: 'qwen-plus' },
  { id: 'openrouter', label: 'OpenRouter', note: '多家模型聚合', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', publicModels: true, exampleModel: 'openai/gpt-4o' },
  { id: 'ollama', label: 'Ollama', note: '本机运行的模型', provider: 'openai', baseUrl: 'http://localhost:11434/v1', keyOptional: true, exampleModel: 'llama3.1' },
  { id: 'openai-compatible', label: '其他 OpenAI 兼容服务', service: 'OpenAI 兼容服务', note: '填写服务的地址', provider: 'openai' },
  { id: 'anthropic-compatible', label: '其他 Anthropic 兼容服务', service: 'Anthropic 兼容服务', note: '填写服务的地址', provider: 'anthropic' },
]

export function presetById(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/** The protocol's display name, for the places that show `anthropic`/`openai` to a person. */
export function providerLabel(provider: string): string {
  return provider === 'anthropic' ? 'Anthropic 接口' : provider === 'openai' ? 'OpenAI 兼容接口' : provider
}
