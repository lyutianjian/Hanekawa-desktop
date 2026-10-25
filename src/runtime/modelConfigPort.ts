import type { ConfigService, ModelReferenceField } from '../config/service.js'
import type { ModelConfigPort, ModelReferenceWrite } from '../harness/types.js'

/**
 * The Config tool's view of the account configuration.
 *
 * `defaultModel` / `fallbackModel` / `compactModel` live in `config.json`,
 * which outranks the settings layers. The tool therefore cannot write settings
 * and call it done, and it cannot re-implement precedence either: this port
 * hands both decisions back to the `ConfigService` that already makes them.
 *
 * Writes follow the same order every other configuration change uses —
 * validate, mutate, save — plus a read-back of what is now effective, so a
 * save failure is reported as a failure and the running session keeps matching
 * what is on disk.
 */
export function createModelConfigPort(config: ConfigService): ModelConfigPort {
  return {
    getModelReference: (field) => config.getModelReference(field),
    resolveModelKey: (reference) => config.resolveModelInput(reference),
    listModelKeys: () => config.listModelKeys(),
    setModelReference: async (field, reference) => writeModelReference(config, field, reference),
  }
}

async function writeModelReference(
  config: ConfigService,
  field: ModelReferenceField,
  reference: string,
): Promise<ModelReferenceWrite> {
  const modelKey = config.resolveModelInput(reference)
  if (!modelKey) return { ok: false, message: `model "${reference}" is not configured` }
  const previous = config.getModelReference(field)
  if (!config.setModelReference(field, modelKey)) {
    return { ok: false, message: `model "${reference}" is not configured` }
  }
  try {
    await config.save()
  } catch (error) {
    // Put the in-memory value back, so the session does not run on a reference
    // that never reached the file.
    if (previous === undefined) delete config.get()[field]
    else config.setModelReference(field, previous)
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, effective: config.getModelReference(field) ?? modelKey }
}