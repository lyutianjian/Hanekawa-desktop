import { createRequire } from 'node:module'
import type { SessionMetric } from './metrics.js'
import { USER_AGENT } from '../utils/userAgent.js'

export interface OtlpExporterOptions {
  endpoint: string
  serviceName?: string
  timeoutMs?: number
}

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }

interface OtlpAttribute {
  key: string
  value: OtlpAnyValue
}

interface OtlpDataPoint {
  timeUnixNano: string
  attributes: OtlpAttribute[]
  asInt?: string
  asDouble?: number
}

interface OtlpMetric {
  name: string
  unit: string
  gauge: {
    dataPoints: OtlpDataPoint[]
  }
}

const DEFAULT_TIMEOUT_MS = 2_000
const require = createRequire(import.meta.url)

/**
 * Depth-sensitive: `rootDir: "src"` keeps the emitted file two levels below the
 * repo root, so `../../package.json` resolves identically from `src/harness/`
 * and from `dist/harness/`. A layout that breaks that must not take the process
 * with it — this runs at module load, and the version is only a telemetry
 * attribute.
 */
function readPackageVersion(): string | undefined {
  try {
    return (require('../../package.json') as { version?: string }).version
  } catch {
    return undefined
  }
}

const SERVICE_VERSION = readPackageVersion() ?? '0.0.0'
const TELEMETRY_SDK_NAME = 'hanekawa'
const METRIC_NUMERIC_FIELDS: Record<SessionMetric['event'], ReadonlySet<string>> = {
  turn: new Set([
    'input_tokens',
    'cache_creation_tokens',
    'response_tokens',
    'cache_read_tokens',
    'cache_hit_rate',
    'tool_calls',
    'duration_ms',
  ]),
  compact: new Set([
    'pre_tokens',
    'post_tokens',
    'compact_duration_ms',
  ]),
  cache_break: new Set([
    'drop_tokens',
  ]),
  session_cache_summary: new Set([
    'total_cache_hit_rate',
    'total_turns',
    'first_break_turn_count',
    'cache_break_count',
  ]),
  subagent_usage: new Set(),
  mcp_connect_failed: new Set(),
}

export class OtlpMetricExporter {
  private readonly endpoint: string
  private readonly serviceName: string
  private readonly timeoutMs: number

  constructor(options: OtlpExporterOptions) {
    this.endpoint = normalizeMetricsEndpoint(options.endpoint)
    this.serviceName = options.serviceName ?? 'hanekawa'
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async exportMetric(metric: SessionMetric): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(this.toMetricsPayload(metric)),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`OTLP export failed with HTTP ${response.status}`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private toMetricsPayload(metric: SessionMetric): Record<string, unknown> {
    return {
      resourceMetrics: [{
        resource: {
          attributes: [
            attribute('service.name', this.serviceName),
            attribute('service.version', SERVICE_VERSION),
            attribute('telemetry.sdk.name', TELEMETRY_SDK_NAME),
            attribute('telemetry.sdk.version', SERVICE_VERSION),
            attribute('session.id', metric.session_id),
          ],
        },
        scopeMetrics: [{
          scope: { name: 'hanekawa.metrics' },
          metrics: metricToOtlpMetrics(metric),
        }],
      }],
    }
  }
}

function normalizeMetricsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (trimmed.endsWith('/v1/metrics')) return trimmed
  return `${trimmed.replace(/\/+$/, '')}/v1/metrics`
}

function dateToUnixNano(isoDate: string): string {
  const ms = Date.parse(isoDate)
  if (!Number.isFinite(ms)) return '0'
  return `${BigInt(Math.trunc(ms)) * 1_000_000n}`
}

function attribute(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } }
  return { key, value: { doubleValue: value } }
}

function metricToOtlpMetrics(metric: SessionMetric): OtlpMetric[] {
  const timeUnixNano = dateToUnixNano(metric.created_at)
  const baseAttributes = metricAttributes(metric)
  const metrics: OtlpMetric[] = []
  for (const [key, value] of Object.entries(metric)) {
    if (!isMetricField(metric.event, key, value)) continue
    metrics.push(otlpGauge(
      `hanekawa.${metric.event}.${key}`,
      value,
      timeUnixNano,
      baseAttributes,
    ))
  }

  if (metric.event === 'session_cache_summary') {
    for (const [cause, count] of Object.entries(metric.cause_distribution)) {
      metrics.push(otlpGauge(
        'hanekawa.session_cache_summary.cache_break_cause_count',
        count,
        timeUnixNano,
        [...baseAttributes, attribute('cache_break.cause', cause)],
      ))
    }
  }

  if (metric.event === 'cache_break') {
    for (const reason of metric.reasons) {
      metrics.push(otlpGauge(
        'hanekawa.cache_break.reason_count',
        1,
        timeUnixNano,
        [...baseAttributes, attribute('cache_break.reason', reason)],
      ))
    }
  }

  return metrics
}

function metricAttributes(metric: SessionMetric): OtlpAttribute[] {
  const attributes = [
    attribute('event.name', metric.event),
    attribute('session.id', metric.session_id),
  ]
  if ('model' in metric) attributes.push(attribute('model.name', metric.model))
  if ('source' in metric) attributes.push(attribute('cache_break.source', metric.source))
  if ('server' in metric) attributes.push(attribute('mcp.server', metric.server))
  return attributes
}

function isMetricField(event: SessionMetric['event'], key: string, value: unknown): value is number {
  return METRIC_NUMERIC_FIELDS[event].has(key)
    && typeof value === 'number'
    && Number.isFinite(value)
}

function otlpGauge(
  name: string,
  value: number,
  timeUnixNano: string,
  attributes: OtlpAttribute[],
): OtlpMetric {
  return {
    name,
    unit: name.endsWith('_ms') ? 'ms' : '1',
    gauge: {
      dataPoints: [{
        timeUnixNano,
        attributes,
        ...(Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value }),
      }],
    },
  }
}
