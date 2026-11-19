import { beforeEach, describe, expect, it } from 'vitest';
import { handle, type Bucket, type Deps, type Fetch } from './app';
import { NotAllowedError } from './auth';
import { doiKey } from './doiKey';
import { MemoryLogStore, RunLog } from './runLog';
import vectors from './doi-vectors.json';

const ORIGIN = 'https://hyperdatalab-idea2hypo.web.app';
const KEY = 'engine-key';
const GOOD = 'good-token';
const OTHER_DOMAIN = 'other-domain-token';

/** Stand-in for the run's Durable Object: the same routes over the same RunLog. */
function fakeRuns() {
  const logs = new Map<string, RunLog>();
  const tokens = new Map<string, { token: string; exp: number }>();
  const run = (runId: string): Fetch => async (path, init) => {
    const url = new URL(`http://run${path}`);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const log = logs.get(runId);
    const json = (status: number, value: unknown) => Response.json(value, { status });
    if (method === 'POST' && url.pathname === '/init') {
      const created = new RunLog(new MemoryLogStore());
      logs.set(runId, created);
      return json(200, created.init(body.runId, body.projectId, body.createdBy));
    }
    if (!log) return json(404, { error: 'not_found' });
    if (url.pathname === '/meta' && method === 'GET') return json(200, { ...log.meta(), lastSeq: log.lastSeq() });
    if (url.pathname === '/meta') return json(200, log.update(body));
    if (url.pathname === '/token' && method === 'POST') {
      tokens.set(runId, body);
      return json(200, { ok: true });
    }
    if (url.pathname === '/token') {
      const t = tokens.get(runId);
      return t ? json(200, { token: t.token }) : json(404, {});
    }
    if (url.pathname === '/events' && method === 'POST') {
      log.ingest(body.events);
      return json(200, { data: { last_source_seq: log.lastSeq() } });
    }
    if (url.pathname === '/events')
      return json(200, { events: log.read(Number(url.searchParams.get('after')), 500), last_seq: log.lastSeq() });
    if (url.pathname === '/stream') return new Response('retry: 3000\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return json(404, {});
  };
  return { run, logs, tokens };
}

function fakeBucket(): Bucket & { objects: Map<string, { data: ArrayBuffer; meta?: Record<string, string> }> } {
  const objects = new Map<string, { data: ArrayBuffer; meta?: Record<string, string> }>();
  return {
    objects,
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        arrayBuffer: async () => o.data,
        text: async () => new TextDecoder().decode(o.data),
        customMetadata: o.meta,
      };
    },
    async put(key, value, options) {
      const data = typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
      objects.set(key, { data: data as ArrayBuffer, meta: options?.customMetadata });
    },
    async list({ prefix }) {
      return {
        objects: [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, customMetadata: o.meta })),
        truncated: false,
      };
    },
  };
}

let runs: ReturnType<typeof fakeRuns>;
let bucket: ReturnType<typeof fakeBucket>;
let engineCalls: { path: string; init?: RequestInit }[];
let paperlabCalls: { path: string; init?: RequestInit }[];
let deps: Deps;

beforeEach(() => {
  runs = fakeRuns();
  bucket = fakeBucket();
  engineCalls = [];
  paperlabCalls = [];
  let n = 0;
  deps = {
    allowedOrigins: [ORIGIN],
    verifyToken: async (token) => {
      if (token === GOOD) return { uid: 'u1', email: 'a@hyperdatalab.org', exp: Date.now() / 1000 + 3600 };
      if (token === OTHER_DOMAIN) throw new NotAllowedError('domain');
      throw new Error('bad');
    },
    canReadProject: async (projectId) => projectId === 'proj-1',
    run: runs.run,
    engine: async (path, init) => {
      engineCalls.push({ path, init });
      if (path === '/runs') return Response.json({ popper_run_id: 'i2h-engine-1', status: 'running' }, { status: 201 });
      if (path.endsWith('/gates/gate-s05-a1'))
        return Response.json({ detail: { code: 'LLM_KEY_REQUIRED', message: 'send it again' } }, { status: 503 });
      return Response.json({ status: 'running', message: null, cost_usd: null, last_source_seq: 0 });
    },
    paperlab: async (path, init) => {
      paperlabCalls.push({ path, init });
      if (path === '/grobid/fulltext') return new Response('<TEI/>', { headers: { 'Content-Type': 'application/xml' } });
      return Response.json({ papers: [] });
    },
    bucket,
    engineKey: KEY,
    internalBase: 'https://i2h.test/internal',
    newId: () => `run-${(n += 1)}`,
  };
});

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  headers.set('Origin', ORIGIN);
  return handle(deps, new Request(`https://i2h.test${path}`, { ...init, headers }));
};
const internal = (path: string, init: RequestInit = {}) =>
  handle(deps, new Request(`https://i2h.test${path}`, { ...init, headers: { 'X-Service-Key': KEY, ...init.headers } }));

const LLM = { base_url: 'https://router.example/v1', api_key: 'sk-user', model: 'm' };

async function start() {
  const response = await call('/v1/projects/proj-1/runs', {
    method: 'POST',
    token: GOOD,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'A topic long enough', review_mode: 'copilot', llm: LLM, sources: { lab_kg: true }, extra: 1 }),
  });
  return response;
}

describe('public routes', () => {
  it('needs a lab sign-in and project access', async () => {
    expect((await call('/v1/projects/proj-1/runs', { method: 'POST' })).status).toBe(401);
    expect((await call('/v1/projects/proj-1/runs', { method: 'POST', token: 'nope' })).status).toBe(401);
    expect((await call('/v1/projects/proj-1/runs', { method: 'POST', token: OTHER_DOMAIN })).status).toBe(403);
    expect((await call('/v1/projects/proj-2/runs', { method: 'POST', token: GOOD })).status).toBe(403);
  });

  it('starts a run on the engine with its callback and only the known fields', async () => {
    const response = await start();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ run_id: 'run-1', status: 'running' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const sent = JSON.parse(String(engineCalls[0]?.init?.body));
    expect(sent).toEqual({
      platform_run_id: 'run-1',
      callback_url: 'https://i2h.test/internal/runs/run-1',
      topic: 'A topic long enough',
      review_mode: 'copilot',
      llm: LLM,
      sources: { lab_kg: true },
    });
    expect(new Headers(engineCalls[0]?.init?.headers).get('X-Service-Key')).toBe(KEY);
    expect(runs.logs.get('run-1')?.meta()).toMatchObject({ engineRunId: 'i2h-engine-1', projectId: 'proj-1' });
  });

  it('serves state, events and controls through the engine id', async () => {
    await start();
    await internal('/internal/runs/run-1/events', {
      method: 'POST',
      body: JSON.stringify({ events: [{ source_seq: 1, type: 'run.started', payload: {} }] }),
    });
    const state = await (await call('/v1/projects/proj-1/runs/run-1', { token: GOOD })).json();
    expect(state).toEqual({ run_id: 'run-1', status: 'running', message: null, cost_usd: null, last_seq: 1 });
    const page = (await (
      await call('/v1/projects/proj-1/runs/run-1/events?after=0&format=json', { token: GOOD })
    ).json()) as { events: { seq: number }[] };
    expect(page.events.map((e: { seq: number }) => e.seq)).toEqual([1]);
    const stream = await call('/v1/projects/proj-1/runs/run-1/events', {
      token: GOOD,
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': '1' },
    });
    expect(stream.headers.get('Content-Type')).toBe('text/event-stream');

    await call('/v1/projects/proj-1/runs/run-1/resume', {
      method: 'POST', token: GOOD, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: LLM, junk: true }),
    });
    const resume = engineCalls.at(-1);
    expect(resume?.path).toBe('/runs/i2h-engine-1/resume');
    expect(JSON.parse(String(resume?.init?.body))).toEqual({ llm: LLM });
    expect(runs.tokens.get('run-1')?.token).toBe(GOOD);
  });

  it('passes engine errors on in the app shape', async () => {
    await start();
    const response = await call('/v1/projects/proj-1/runs/run-1/gates/gate-s05-a1', {
      method: 'POST', token: GOOD, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_id: 'approve' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'LLM_KEY_REQUIRED', message: 'send it again' });
  });

  it('hides a run from another project', async () => {
    await start();
    deps.canReadProject = async () => true;
    expect((await call('/v1/projects/proj-9/runs/run-1', { token: GOOD })).status).toBe(404);
  });

  it('serves stage artifacts from the mirror only', async () => {
    await start();
    await bucket.put('i2h/runs/i2h-engine-1/stage-08/hypotheses.md', '# H');
    const ok = await call('/v1/projects/proj-1/runs/run-1/artifacts/stage-08/hypotheses.md', { token: GOOD });
    expect(await ok.text()).toBe('# H');
    expect((await call('/v1/projects/proj-1/runs/run-1/artifacts/run.json', { token: GOOD })).status).toBe(404);
    expect((await call('/v1/projects/proj-1/runs/run-1/artifacts/stage-08/../run.json', { token: GOOD })).status).toBe(404);
  });
});

describe('internal routes', () => {
  it('need the engine key', async () => {
    const response = await handle(deps, new Request('https://i2h.test/internal/runs/run-1/events', { method: 'POST' }));
    expect(response.status).toBe(401);
  });

  it('mirror run files with their digest', async () => {
    const data = new TextEncoder().encode('{"a":1}');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) => b.toString(16).padStart(2, '0')).join('');
    const put = await internal('/internal/runs/i2h-engine-1/files/stage-06/cards/c%201.json', {
      method: 'PUT', body: data, headers: { 'X-Content-SHA256': digest },
    });
    expect(put.status).toBe(201);
    const bad = await internal('/internal/runs/i2h-engine-1/files/run.json', {
      method: 'PUT', body: data, headers: { 'X-Content-SHA256': '0'.repeat(64) },
    });
    expect(bad.status).toBe(422);
    const listing = await (await internal('/internal/runs/i2h-engine-1/files')).json();
    expect(listing).toEqual({ files: { 'stage-06/cards/c 1.json': digest } });
    const read = await internal('/internal/runs/i2h-engine-1/files/stage-06/cards/c%201.json');
    expect(await read.text()).toBe('{"a":1}');
    expect((await internal('/internal/runs/unknown-run/files')).status).toBe(404);
  });

  it('forward allow-listed lab routes with the run token', async () => {
    await start();
    expect((await internal('/internal/runs/run-1/lab/v1/kg/search', { method: 'POST', body: '{}' })).status).toBe(409);
    await call('/v1/projects/proj-1/runs/run-1', { token: GOOD });
    const kg = await internal('/internal/runs/run-1/lab/v1/kg/search', { method: 'POST', body: '{"query":"q"}' });
    expect(kg.status).toBe(200);
    expect(paperlabCalls[0]?.path).toBe('/v1/kg/search');
    expect(new Headers(paperlabCalls[0]?.init?.headers).get('Authorization')).toBe(`Bearer ${GOOD}`);
    expect((await internal('/internal/runs/run-1/lab/v1/kg/ingest', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('reads full text of a PDF Paper Fetch Hub stored', async () => {
    await start();
    await call('/v1/projects/proj-1/runs/run-1', { token: GOOD });
    const key = await doiKey('https://doi.org/10.1000/ABC');
    await bucket.put(`papers/${key}.pdf`, '%PDF-1.7');
    const found = await internal('/internal/runs/run-1/lab/fulltext', { method: 'POST', body: '{"doi":"10.1000/abc"}' });
    expect(found.status).toBe(200);
    expect(await found.text()).toBe('<TEI/>');
    const missing = await internal('/internal/runs/run-1/lab/fulltext', { method: 'POST', body: '{"doi":"10.1000/none"}' });
    expect(missing.status).toBe(404);
  });
});

describe('doiKey', () => {
  it('matches Paper Fetch Hub vectors', async () => {
    for (const vector of vectors.valid) expect(await doiKey(vector.input)).toBe(vector.doiKey);
    for (const input of vectors.invalid) expect(await doiKey(input)).toBeNull();
  });
});
