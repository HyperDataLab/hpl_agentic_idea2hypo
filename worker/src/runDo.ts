// One Durable Object per run: its event log (SQLite), the live SSE streams of the people following it,
// and, in memory only, the newest sign-in token of a person following it (used for the lab routes the
// engine calls; never written to storage).
import { DurableObject } from 'cloudflare:workers';
import {
  FINISHED,
  RunLog,
  sseFrame,
  EventGapError,
  type LogStore,
  type RunEnvelope,
  type RunMeta,
} from './runLog';

const HEARTBEAT_MS = 20_000;
/** A token is not handed out in its last minute. */
const TOKEN_MARGIN_S = 60;

class SqlLogStore implements LogStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)`,
    );
  }
  meta(): RunMeta | null {
    const row = this.sql.exec<{ json: string }>(`SELECT json FROM meta WHERE id = 1`).toArray()[0];
    return row ? (JSON.parse(row.json) as RunMeta) : null;
  }
  setMeta(meta: RunMeta): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (id, json) VALUES (1, ?)`, JSON.stringify(meta));
  }
  lastSeq(): number {
    const row = this.sql.exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM events`).toArray()[0];
    return row?.seq ?? 0;
  }
  append(events: RunEnvelope[]): void {
    for (const event of events)
      this.sql.exec(`INSERT INTO events (seq, json) VALUES (?, ?)`, event.seq, JSON.stringify(event));
  }
  read(after: number, limit: number): RunEnvelope[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM events WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit)
      .toArray()
      .map((row) => JSON.parse(row.json) as RunEnvelope);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The run object needs no binding of its own. */
type RunEnv = Record<string, unknown>;

export class RunObject extends DurableObject<RunEnv> {
  private readonly log: RunLog;
  private readonly streams = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private token: { value: string; exp: number } | null = null;
  private readonly encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: RunEnv) {
    super(ctx, env);
    this.log = new RunLog(new SqlLogStore(ctx.storage.sql));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'POST /init': {
        const body = (await request.json()) as { runId: string; projectId: string; createdBy: string };
        return json(200, this.log.init(body.runId, body.projectId, body.createdBy));
      }
      case 'GET /meta': {
        const meta = this.log.meta();
        return meta ? json(200, { ...meta, lastSeq: this.log.lastSeq() }) : json(404, { error: 'not_found' });
      }
      case 'PATCH /meta': {
        const body = (await request.json()) as Partial<Pick<RunMeta, 'engineRunId' | 'status' | 'message'>>;
        return json(200, this.log.update(body));
      }
      case 'POST /token': {
        const body = (await request.json()) as { token: string; exp: number };
        if (!this.token || body.exp >= this.token.exp) this.token = { value: body.token, exp: body.exp };
        return json(200, { ok: true });
      }
      case 'GET /token': {
        const fresh = this.token && this.token.exp - TOKEN_MARGIN_S > Date.now() / 1000;
        return fresh ? json(200, { token: this.token?.value }) : json(404, { error: 'no_token' });
      }
      case 'POST /events':
        return this.ingest(request);
      case 'GET /events': {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        const limit = Number(url.searchParams.get('limit') ?? 500) || 500;
        return json(200, { events: this.log.read(after, limit), last_seq: this.log.lastSeq() });
      }
      case 'GET /stream':
        return this.stream(Number(url.searchParams.get('after') ?? 0) || 0);
      default:
        return json(404, { error: 'not_found' });
    }
  }

  private async ingest(request: Request): Promise<Response> {
    if (!this.log.meta()) return json(404, { error: 'not_found' });
    const body = (await request.json().catch(() => null)) as { events?: unknown[] } | null;
    if (!body || !Array.isArray(body.events)) return json(400, { error: 'bad_request' });
    let fresh: RunEnvelope[];
    try {
      fresh = this.log.ingest(body.events);
    } catch (error) {
      if (error instanceof EventGapError) return json(422, { detail: 'EVENT_GAP', expected: error.expected });
      return json(400, { error: 'malformed_event' });
    }
    await this.broadcast(fresh.map(sseFrame).join(''));
    if (FINISHED.has(this.log.meta()?.status ?? 'running')) await this.endStreams();
    return json(200, { data: { last_source_seq: this.log.lastSeq() } });
  }

  private stream(after: number): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const backlog = this.log.read(after, 1000);
    void writer.write(this.encoder.encode(`retry: 3000\n\n${backlog.map(sseFrame).join('')}`));
    // A backlog of a full page is read again by the app through GET /events; the stream then resumes.
    const ended = FINISHED.has(this.log.meta()?.status ?? 'running') && backlog.length < 1000;
    if (ended) {
      void writer.write(this.encoder.encode('event: run-ended\ndata: {}\n\n')).then(() => writer.close());
    } else {
      this.streams.add(writer);
      this.heartbeat ??= setInterval(() => void this.broadcast(': keep-alive\n\n'), HEARTBEAT_MS);
    }
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
    });
  }

  private async broadcast(text: string): Promise<void> {
    if (!text) return;
    const bytes = this.encoder.encode(text);
    await Promise.all(
      [...this.streams].map((writer) =>
        writer.write(bytes).catch(() => {
          this.streams.delete(writer);
        }),
      ),
    );
    if (!this.streams.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private async endStreams(): Promise<void> {
    await this.broadcast('event: run-ended\ndata: {}\n\n');
    for (const writer of this.streams) await writer.close().catch(() => undefined);
    this.streams.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}
