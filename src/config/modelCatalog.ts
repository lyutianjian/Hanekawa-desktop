/** The model information tools may disclose; never includes endpoint credentials. */
export interface ModelCatalogEntry {
  key: string
  model: string
  contextWindow?: number
}
