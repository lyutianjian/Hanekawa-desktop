import type { ModelProvider, ModelRequest, ModelResponse, TokenUsage } from './types.js'
import { addTokenUsage, EMPTY_TOKEN_USAGE } from './usage.js'

/** Falls back to the returned usage for providers without attempt reporting. */
export async function requestModel(
  provider: ModelProvider,
  request: ModelRequest,
  onUsage?: (usage: TokenUsage, model: string) => void,
): Promise<{ response: ModelResponse; usage: TokenUsage }> {
  let reported = false
  let usage = { ...EMPTY_TOKEN_USAGE }
  const settle = (spend: TokenUsage) => {
    reported = true
    usage = addTokenUsage(usage, spend)
    onUsage?.(spend, request.model)
  }
  const response = await provider.createMessage({ ...request, onUsage: settle })
  if (!reported && response.usage) settle(response.usage)
  return { response, usage }
}
