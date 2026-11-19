// The event log of one run, kept by its Durable Object. Pure logic over a small store interface, so
// tests run it in memory and the Durable Object runs it over its SQLite storage.

/** One event as the engine delivers it (`api/platform_events.py`, `POST <callback>/events`). */
export interface EngineEvent {
  source_seq: number;
  type: string;
  stage_key?: string | null;
  actor?: string | null;
  payload: Record<string, unknown>;
}

/** One stored event as the app reads it (`parseRunEvent` in the FE). `seq` is the engine's `source_seq`. */
export interface RunEnvelope {
  seq: number;
  run_id: string;
  ts: string;
  type: string;
  stage_key?: string;
  actor?: string;
  payload: Record<string, unknown>;
}

export type RunStatus = 'starting' | 'running' | 'paused' | 'awaiting_review' | 'completed' | 'failed';
export const FINISHED: ReadonlySet<RunStatus> = new Set(['completed', 'failed']);

export interface RunMeta {
  runId: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  engineRunId: string | null;
  status: RunStatus;
  message: string | null;
}

export interface LogStore {
  meta(): RunMeta | null;
  setMeta(meta: RunMeta): void;
  lastSeq(): number;
  append(events: RunEnvelope[]): void;
  read(after: number, limit: number): RunEnvelope[];
}

export function toEnvelope(runId: string, event: EngineEvent, ts: string): RunEnvelope {
  return {
    seq: event.source_seq,
    run_id: runId,
    ts,
    type: event.type,
    ...(event.stage_key ? { stage_key: event.stage_key } : {}),
    ...(event.actor ? { actor: event.actor } : {}),
    payload: event.payload ?? {},
  };
}

const STATUSES: ReadonlySet<string> = new Set(['running', 'paused', 'awaiting_review', 'completed', 'failed']);

/** The run's status after `events`, from `run.status` and `run.completed` (the engine's own record). */
export function statusAfter(
  current: { status: RunStatus; message: string | null },
  events: RunEnvelope[],
): { status: RunStatus; message: string | null } {
  let { status, message } = current;
  for (const event of events) {
    if (event.type === 'run.completed') {
      status = 'completed';
      message = null;
    } else if (event.type === 'run.status') {
      const next = String(event.payload.status ?? '');
      if (STATUSES.has(next)) {
        status = next as RunStatus;
        const reason = event.payload.reason;
        message = typeof reason === 'string' && reason ? reason : null;
      }
    } else if (event.type === 'run.started' && status === 'starting') {
      status = 'running';
    }
  }
  return { status, message };
}

export class EventGapError extends Error {
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(`expected source_seq ${expected}, got ${got}`);
  }
}

function isEngineEvent(value: unknown): value is EngineEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    Number.isInteger(e.source_seq) &&
    (e.source_seq as number) > 0 &&
    typeof e.type === 'string' &&
    typeof e.payload === 'object' &&
    e.payload !== null
  );
}

export class RunLog {
  constructor(
    private readonly store: LogStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  meta(): RunMeta | null {
    return this.store.meta();
  }

  /** Creates the run's record; a second call with the same project is a no-op. */
  init(runId: string, projectId: string, createdBy: string): RunMeta {
    const existing = this.store.meta();
    if (existing) return existing;
    const meta: RunMeta = {
      runId,
      projectId,
      createdBy,
      createdAt: this.now().toISOString(),
      engineRunId: null,
      status: 'starting',
      message: null,
    };
    this.store.setMeta(meta);
    return meta;
  }

  update(fields: Partial<Pick<RunMeta, 'engineRunId' | 'status' | 'message'>>): RunMeta {
    const meta = this.store.meta();
    if (!meta) throw new Error('run not initialised');
    const next = { ...meta, ...fields };
    this.store.setMeta(next);
    return next;
  }

  lastSeq(): number {
    return this.store.lastSeq();
  }

  read(after: number, limit: number): RunEnvelope[] {
    return this.store.read(Math.max(0, after), Math.min(Math.max(limit, 1), 1000));
  }

  /**
   * Stores a delivered batch. Delivery is at-least-once, so events at or below the last stored seq are
   * dropped; a gap is refused (the engine sends the batch again from its cursor).
   */
  ingest(raw: unknown[]): RunEnvelope[] {
    const meta = this.store.meta();
    if (!meta) throw new Error('run not initialised');
    let last = this.store.lastSeq();
    const fresh: RunEnvelope[] = [];
    const ts = this.now().toISOString();
    for (const value of raw) {
      if (!isEngineEvent(value)) throw new TypeError('malformed event');
      if (value.source_seq <= last) continue;
      if (value.source_seq !== last + 1) throw new EventGapError(last + 1, value.source_seq);
      fresh.push(toEnvelope(meta.runId, value, ts));
      last = value.source_seq;
    }
    if (fresh.length) {
      this.store.append(fresh);
      const next = statusAfter(meta, fresh);
      if (next.status !== meta.status || next.message !== meta.message) this.update(next);
    }
    return fresh;
  }
}

/** In-memory store for tests and local tools. */
export class MemoryLogStore implements LogStore {
  private record: RunMeta | null = null;
  private events: RunEnvelope[] = [];
  meta() {
    return this.record;
  }
  setMeta(meta: RunMeta) {
    this.record = { ...meta };
  }
  lastSeq() {
    return this.events.at(-1)?.seq ?? 0;
  }
  append(events: RunEnvelope[]) {
    this.events.push(...events);
  }
  read(after: number, limit: number) {
    return this.events.filter((e) => e.seq > after).slice(0, limit);
  }
}

export function sseFrame(event: RunEnvelope): string {
  return `id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`;
}
