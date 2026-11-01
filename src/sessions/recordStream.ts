import type { RecordStream } from '../harness/recordStream.js'
import type { SessionMetricInput } from '../harness/metrics.js'
import type { SessionRecord } from '../harness/types.js'
import type { SessionStore } from './service.js'

export class JsonlRecordStream implements RecordStream {
  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
  ) {}

  async load(): Promise<SessionRecord[]> {
    return this.store.loadRecords(this.sessionId)
  }

  async loadWithDiagnostics(): Promise<Awaited<ReturnType<SessionStore['loadRecordsWithDiagnostics']>>> {
    return this.store.loadRecordsWithDiagnostics(this.sessionId)
  }

  async append(record: SessionRecord): Promise<void> {
    await this.store.appendRecord(this.sessionId, record)
  }

  async update(recordId: string, update: (record: SessionRecord) => SessionRecord): Promise<void> {
    await this.store.updateRecord(this.sessionId, recordId, update)
  }

  async appendMetric(metric: SessionMetricInput): Promise<void> {
    this.store.appendSessionMetric(this.sessionId, metric)
  }
}
