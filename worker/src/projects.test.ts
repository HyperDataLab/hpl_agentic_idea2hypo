import { beforeEach, describe, expect, it } from 'vitest';
import { handle, type Deps } from './app';
import { NotAllowedError } from './auth';
import { MemoryLogStore, RunLog } from './runLog';
import { Store } from './store';
import { sqliteDatabase } from './testDb';

// Projects, members and the run list in D1 (store.ts), through the public routes.
const ORIGIN = 'https://hyperdatalab-idea2hypo.web.app';
const TOKENS: Record<string, string> = { alice: 'alice@hyperdatalab.org', bob: 'Bob@HyperDataLab.org' };

let db: ReturnType<typeof sqliteDatabase>;
let deps: Deps;
let clock: number;

beforeEach(() => {
  db = sqliteDatabase();
  clock = 0;
  let p = 0;
  let r = 0;
  const logs = new Map<string, RunLog>();
  deps = {
    allowedOrigins: [ORIGIN],
    verifyToken: async (token) => {
      if (token === 'outsider') throw new NotAllowedError('domain');
      const email = TOKENS[token];
      if (!email) throw new Error('bad');
      return { uid: token, email, exp: Date.now() / 1000 + 3600 };
    },
    // Times move on with every write, so "newest first" is well defined.
    store: new Store(db, () => new Date(Date.UTC(2026, 10, 20, 0, 0, (clock += 1))).toISOString()),
    allowedDomain: 'hyperdatalab.org',
    run: (runId) => async (path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === '/init') {
        const log = new RunLog(new MemoryLogStore());
        logs.set(runId, log);
        return Response.json(log.init(body.runId, body.projectId, body.createdBy));
      }
      const log = logs.get(runId);
      if (!log) return Response.json({ error: 'not_found' }, { status: 404 });
      if (path === '/meta' && (init?.method ?? 'GET') === 'GET') return Response.json({ ...log.meta(), lastSeq: 7 });
      if (path === '/meta') return Response.json(log.update(body));
      return Response.json({ ok: true });
    },
    engine: async (path) => {
      if (path === '/runs') return Response.json({ popper_run_id: 'engine-1', status: 'starting' }, { status: 201 });
      return Response.json({ status: 'awaiting_review', message: 'pick the papers', cost_usd: '0.31' });
    },
    paperlab: async () => Response.json({}),
    bucket: {
      get: async () => null,
      put: async () => undefined,
      list: async () => ({ objects: [], truncated: false }),
    },
    engineKey: 'k',
    internalBase: 'https://i2h.test/internal',
    newId: () => `run-${(r += 1)}xx`,
    newProjectId: () => `prj-${(p += 1)}xx`,
  };
});

const call = (path: string, token?: string, method = 'GET', body?: unknown) => {
  const headers = new Headers({ Origin: ORIGIN });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return handle(
    deps,
    new Request(`https://i2h.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
};

async function create(token: string, name = 'BM25 fusion') {
  const response = await call('/v1/projects', token, 'POST', { name, description: '  about recall  ' });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; owner_email: string; member_emails: string[] };
}

describe('projects in D1', () => {
  it('creates a project owned by the caller, and lists only the caller\'s projects', async () => {
    const created = await create('alice');
    expect(created).toMatchObject({
      id: 'prj-1xx',
      name: 'BM25 fusion',
      description: 'about recall',
      owner_email: 'alice@hyperdatalab.org',
      member_emails: ['alice@hyperdatalab.org'],
      status: 'researching',
    });
    await create('bob', 'Another one');
    const listed = (await (await call('/v1/projects', 'alice')).json()) as { projects: { id: string }[] };
    expect(listed.projects.map((project) => project.id)).toEqual(['prj-1xx']);
  });

  it('needs a lab sign-in and a valid name', async () => {
    expect((await call('/v1/projects')).status).toBe(401);
    expect((await call('/v1/projects', 'outsider')).status).toBe(403);
    expect((await call('/v1/projects', 'alice', 'POST', { name: 'ab' })).status).toBe(400);
    expect((await call('/v1/projects', 'alice', 'POST', { name: 42 })).status).toBe(400);
    expect((await call('/v1/projects', 'alice', 'PUT', {})).status).toBe(405);
  });

  it('lets members in and keeps others out, with CORS for PATCH and DELETE', async () => {
    const { id } = await create('alice');
    expect((await call(`/v1/projects/${id}`, 'bob')).status).toBe(403);
    expect((await call(`/v1/projects/prj-nonexistent`, 'bob')).status).toBe(404);
    expect((await call(`/v1/projects/${id}/runs`, 'bob')).status).toBe(403);
    const preflight = await handle(
      deps,
      new Request(`https://i2h.test/v1/projects/${id}`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    );
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });

  it('adds lab members (case-insensitive), refuses other domains, and keeps the owner', async () => {
    const { id } = await create('alice');
    expect((await call(`/v1/projects/${id}/members`, 'alice', 'POST', { email: 'x@gmail.com' })).status).toBe(400);
    const added = await call(`/v1/projects/${id}/members`, 'alice', 'POST', { email: 'BOB@hyperdatalab.org' });
    expect(((await added.json()) as { member_emails: string[] }).member_emails).toEqual([
      'alice@hyperdatalab.org',
      'bob@hyperdatalab.org',
    ]);
    // Bob is in now, but only the owner manages members.
    expect((await call(`/v1/projects/${id}`, 'bob')).status).toBe(200);
    expect((await call(`/v1/projects/${id}/members`, 'bob', 'POST', { email: 'c@hyperdatalab.org' })).status).toBe(403);
    expect((await call(`/v1/projects/${id}/members/alice%40hyperdatalab.org`, 'alice', 'DELETE')).status).toBe(409);
    expect((await call(`/v1/projects/${id}/members/bob%40hyperdatalab.org`, 'alice', 'DELETE')).status).toBe(200);
    expect((await call(`/v1/projects/${id}`, 'bob')).status).toBe(403);
  });

  it('edits, hands over and deletes a project, each by the right person', async () => {
    const { id } = await create('alice');
    await call(`/v1/projects/${id}/members`, 'alice', 'POST', { email: 'bob@hyperdatalab.org' });
    const edited = await call(`/v1/projects/${id}`, 'bob', 'PATCH', { name: 'Renamed', status: 'completed' });
    expect(await edited.json()).toMatchObject({ name: 'Renamed', status: 'completed' });
    expect((await call(`/v1/projects/${id}`, 'bob', 'PATCH', { status: 'gone' })).status).toBe(400);
    expect((await call(`/v1/projects/${id}`, 'bob', 'PATCH', { owner_email: 'bob@hyperdatalab.org' })).status).toBe(403);
    expect((await call(`/v1/projects/${id}`, 'alice', 'PATCH', { owner_email: 'c@hyperdatalab.org' })).status).toBe(400);
    const handed = await call(`/v1/projects/${id}`, 'alice', 'PATCH', { owner_email: 'bob@hyperdatalab.org' });
    expect(await handed.json()).toMatchObject({ owner_email: 'bob@hyperdatalab.org' });
    expect((await call(`/v1/projects/${id}`, 'alice', 'DELETE')).status).toBe(403);
    expect((await call(`/v1/projects/${id}`, 'bob', 'DELETE')).status).toBe(204);
    expect((await call(`/v1/projects/${id}`, 'bob')).status).toBe(404);
  });
});

describe('the run list in D1', () => {
  it('records a started run and keeps its status in step with the engine', async () => {
    const { id } = await create('alice');
    const started = await call(`/v1/projects/${id}/runs`, 'alice', 'POST', {
      topic: 'Does fusion help?',
      review_mode: 'copilot',
      domains: ['IR'],
      llm: { base_url: 'https://r.example/v1', api_key: 'sk-secret', model: 'm' },
    });
    expect(started.status).toBe(201);
    const listed = (await (await call(`/v1/projects/${id}/runs`, 'alice')).json()) as { runs: unknown[] };
    expect(listed.runs).toEqual([
      expect.objectContaining({
        run_id: 'run-1xx',
        project_id: id,
        topic: 'Does fusion help?',
        review_mode: 'copilot',
        domains: ['IR'],
        status: 'starting',
        created_by: 'alice@hyperdatalab.org',
      }),
    ]);
    // The key is never stored with the run.
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM runs').all())).not.toContain('sk-secret');

    const state = await call(`/v1/projects/${id}/runs/run-1xx`, 'alice');
    expect(await state.json()).toMatchObject({
      run_id: 'run-1xx',
      topic: 'Does fusion help?',
      review_mode: 'copilot',
      status: 'awaiting_review',
      cost_usd: '0.31',
      last_seq: 7,
    });
    const after = (await (await call(`/v1/projects/${id}/runs`, 'alice')).json()) as { runs: unknown[] };
    expect(after.runs[0]).toMatchObject({ status: 'awaiting_review', message: 'pick the papers', last_seq: 7, cost_usd: 0.31 });
  });

  it('lists newest first and removes runs with their project', async () => {
    const { id } = await create('alice');
    for (const topic of ['first', 'second'])
      await call(`/v1/projects/${id}/runs`, 'alice', 'POST', { topic, llm: {} });
    const listed = (await (await call(`/v1/projects/${id}/runs?limit=1`, 'alice')).json()) as {
      runs: { topic: string }[];
    };
    expect(listed.runs.map((run) => run.topic)).toEqual(['second']);
    await call(`/v1/projects/${id}`, 'alice', 'DELETE');
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });
});
