import type { ModelCatalogEntry } from '../config/modelCatalog.js'

export function formatModelCatalog(models: readonly ModelCatalogEntry[]): string {
  return [
    'Available models (pass the exact key to `model`, not the provider model name):',
    ...models.map(({ key, model, contextWindow, supportedEfforts }) =>
      `- key: ${JSON.stringify(key)}; model: ${JSON.stringify(model)}${contextWindow === undefined ? '' : `; context window: ${contextWindow} tokens`}${supportedEfforts ? `; accepts only these efforts: ${supportedEfforts.join(', ')}` : ''}`),
    ...(models.length ? [] : ['- No configured model is available.']),
    'Omit `model` to use the default below. An explicit key overrides the default for this new task only; it does not change global settings. Unknown keys fail rather than falling back.',
  ].join('\n')
}

export function availableModelKeys(models: readonly ModelCatalogEntry[]): string {
  return `Available model keys: ${models.map(({ key }) => JSON.stringify(key)).join(', ') || '(none)'}.`
}
