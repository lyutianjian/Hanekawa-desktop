const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
}

/** The protocol's display name, for the places that show a provider name to a person. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}
