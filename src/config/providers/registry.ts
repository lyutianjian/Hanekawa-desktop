import type { ModelProvider } from '../../harness/types.js'
import type { ModelConfig } from '../service.js'
import type { Endpoint } from '../routing.js'
import { AnthropicProvider } from './anthropicProvider.js'
import { OpenAIProvider } from './openaiProvider.js'
import { ResponsesProvider } from './responsesProvider.js'

export const SUPPORTED_PROVIDER_NAMES = ['anthropic', 'openai', 'openai-responses'] as const

export type SupportedProviderName = typeof SUPPORTED_PROVIDER_NAMES[number]

export function isSupportedProviderName(value: string): value is SupportedProviderName {
  return SUPPORTED_PROVIDER_NAMES.some((provider) => provider === value)
}

const PROVIDER_FACTORIES: Record<SupportedProviderName, (config: ModelConfig) => ModelProvider> = {
  anthropic: (config) => new AnthropicProvider(config),
  openai: (config) => new OpenAIProvider(config),
  'openai-responses': (config) => new ResponsesProvider(config),
}

/**
 * The adapter-side half of image-input capability, read off each provider
 * class. An adapter opts in by flipping its static; a provider name outside
 * `SUPPORTED_PROVIDER_NAMES` reports false without throwing, so an unknown or
 * future name is merely incapable, never fatal.
 */
const PROVIDER_IMAGE_INPUT: Readonly<Record<SupportedProviderName, boolean>> = {
  anthropic: AnthropicProvider.supportsImageInput,
  openai: OpenAIProvider.supportsImageInput,
  'openai-responses': ResponsesProvider.supportsImageInput,
}

/** Whether the adapter a provider name resolves to implements image input. */
export function providerSupportsImageInput(providerName: string | undefined): boolean {
  return providerName !== undefined
    && isSupportedProviderName(providerName)
    && PROVIDER_IMAGE_INPUT[providerName] === true
}

/**
 * The single effective image-input capability check, shared by the runtime and
 * both UIs so neither keeps a model whitelist of its own: the model's switch
 * AND the provider adapter's implementation. Reads nothing, probes nothing —
 * no files, no network — so it is safe wherever a model name is merely
 * displayed, and cheap enough to call per request.
 *
 * `model` is usually a resolved `ModelConfig` (endpoint already folded in).
 * `endpoint` covers the caller that holds a raw model beside the endpoint it
 * references; the model's own `provider` wins over the endpoint's, exactly as
 * `ConfigService.resolveModel`'s spread order does.
 */
export function resolveImageCapability(
  model: Pick<ModelConfig, 'provider' | 'supportsImageInput'> | undefined,
  endpoint?: Pick<Endpoint, 'provider'>,
): boolean {
  if (!model) return false
  // Strict `=== true`: absent, false, "true", 1 — everything but true is off.
  if (model.supportsImageInput !== true) return false
  return providerSupportsImageInput(model.provider ?? endpoint?.provider)
}

export class ProviderRegistry {
  private providers: Map<string, ModelProvider> = new Map()

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider)
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name)
  }

  has(name: string): boolean {
    return this.providers.has(name)
  }

  list(): string[] {
    return Array.from(this.providers.keys())
  }
}

export function createProvider(config: ModelConfig): ModelProvider | undefined {
  if (!config.provider || !isSupportedProviderName(config.provider)) return undefined
  return PROVIDER_FACTORIES[config.provider](config)
}
