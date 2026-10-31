import type { EffortLevel } from './effort.js'

/** The model information tools may disclose; never includes endpoint credentials. */
export interface ModelCatalogEntry {
  key: string
  model: string
  contextWindow?: number
  /** The effort levels this model accepts; absent means every level. */
  supportedEfforts?: EffortLevel[]
}
