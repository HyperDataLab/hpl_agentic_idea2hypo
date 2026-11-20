// Request handling with injected dependencies, so tests need no Cloudflare runtime.
//
// Public routes (the app; Firebase ID token of a verified @hyperdatalab.org Google account; a project and its
// runs are reached only by its members, kept in D1 — see store.ts):
//   GET  /v1/projects                              the caller's projects
//   POST /v1/projects                              create one (the caller owns it)
//   GET|PATCH|DELETE /v1/projects/:p               read, edit (owner: owner_email, delete)
//   POST /v1/projects/:p/members, DELETE /v1/projects/:p/members/:email   (owner only)
//   GET  /v1/projects/:p/runs                      the project's runs, newest first
//   POST /v1/projects/:p/runs                      start a run
//   GET  /v1/projects/:p/runs/:r                   state
//   GET  /v1/projects/:p/runs/:r/events            SSE (Accept: text/event-stream) or a JSON page
//   POST /v1/projects/:p/runs/:r/{pause|resume|cancel}
//   POST /v1/projects/:p/runs/:r/gates/:gateId
//   GET  /v1/projects/:p/runs/:r/artifacts/<stage-NN/...>
// Internal routes (the engine container; X-Service-Key = ENGINE_KEY):
//   POST /internal/runs/:r/events                  event delivery (DeliveryManager)
//   GET|PUT /internal/runs/:engineRunId/files[/<path>]   run-file mirror in R2
//   *    /internal/runs/:r/lab/<route>             lab services with the newest token of the run
import { emailAllowed, sameSecret, NotAllowedError, type Identity } from './auth';
import { doiKey } from './doiKey';
import { FINISHED, type RunMeta } from './runLog';
import { PROJECT_STATUSES, normalEmail, type ProjectStatus, type Store } from './store';

export interface StoredObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  customMetadata?: Record<string, string>;
}
export interface Bucket {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  list(options: {
    prefix: string;
    cursor?: string;
    include?: ('customMetadata' | 'httpMetadata')[];
  }): Promise<{ objects: { key: string; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string }>;
}

/** Fetch into a binding (a Durable Object stub or the engine container) by path. */
export type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface Deps {
  allowedOrigins: string[];
  verifyToken(token: string): Promise<Identity>;
  /** Projects, members and run records (D1). */
  store: Store;
  /** The lab's email domain: only its accounts can be added to a project. */
  allowedDomain: string;
  run(runId: string): Fetch;
  engine: Fetch;
  /** PaperLab's worker, called with a person's token. */
  paperlab: Fetch;
  bucket: Bucket;
  engineKey: string;
  /** This Worker's internal base URL as the engine reaches it, e.g. https://i2h-worker…/internal. */
  internalBase: string;
  newId(): string;
  newProjectId(): string;
  wait?(ms: number): Promise<void>;
  keepEngineAwake?(): void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIRROR_PATH = /^(?!.*\.\.)[A-Za-z0-9._\-/ ]{1,300}$/;
const ARTIFACT_PATH = /^stage-0[1-9]\/(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type, last-event-id',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  return body as Record<string, unknown>;
}

/** An engine answer passed on: its status and JSON body, errors in the app's `{error, message}` shape. */
async function relay(response: Response): Promise<Response> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return json(response.status, body);
  const detail = body.detail;
  const code =
    typeof detail === 'object' && detail && 'code' in detail ? String((detail as { code: unknown }).code) : 'engine_error';
  const message =
    typeof detail === 'object' && detail && 'message' in detail
      ? String((detail as { message: unknown }).message)
      : typeof detail === 'string'
        ? detail
        : `engine answered ${response.status}`;
  return json(response.status >= 500 ? 503 : response.status, { error: code, message });
}

// ---------------------------------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------------------------------

async function caller(deps: Deps, request: Request): Promise<Identity & { token: string }> {
  const match = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) throw new HttpError(401, 'unauthenticated', 'sign in required');
  try {
    return { ...(await deps.verifyToken(match[1])), token: match[1] };
  } catch (error) {
    if (error instanceof NotAllowedError) throw new HttpError(403, 'forbidden', 'lab accounts only');
    throw new HttpError(401, 'unauthenticated', 'invalid or expired sign-in');
  }
}

async function runMeta(deps: Deps, runId: string): Promise<RunMeta & { lastSeq: number }> {
  const response = await deps.run(runId)('/meta');
  if (response.status === 404) throw new HttpError(404, 'not_found', 'run not found');
  return (await response.json()) as RunMeta & { lastSeq: number };
}

const RUN_FIELDS = ['topic', 'domains', 'review_mode', 'budget_usd', 'llm', 'sources'] as const;

async function startRun(deps: Deps, projectId: string, who: Identity, request: Request) {
  const body = await readJson(request);
  const runId = deps.newId();
  const stub = deps.run(runId);
  await stub('/init', {
    method: 'POST',
    body: JSON.stringify({ runId, projectId, createdBy: who.email }),
  });
  const engineBody: Record<string, unknown> = {
    platform_run_id: runId,
    callback_url: `${deps.internalBase}/runs/${runId}`,
  };
  for (const key of RUN_FIELDS) if (key in body) engineBody[key] = body[key];
  const response = await deps.engine('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': deps.engineKey },
    body: JSON.stringify(engineBody),
  });
  if (!response.ok) {
    await stub('/meta', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', message: `start refused (${response.status})` }),
    });
    return relay(response);
  }
  const started = (await response.json()) as { popper_run_id: string; status: string };
  await stub('/meta', { method: 'PATCH', body: JSON.stringify({ engineRunId: started.popper_run_id }) });
  await deps.store.insertRun({
    runId,
    projectId,
    topic: typeof body.topic === 'string' ? body.topic : '',
    reviewMode: typeof body.review_mode === 'string' ? body.review_mode : 'light',
    domains: Array.isArray(body.domains) ? body.domains.map(String) : [],
    status: started.status,
    createdBy: who.email,
  });
  return json(201, { run_id: runId, status: started.status });
}

async function runState(deps: Deps, meta: RunMeta & { lastSeq: number }) {
  let status: string = meta.status;
  let message = meta.message;
  let cost: string | null = null;
  if (meta.engineRunId && !FINISHED.has(meta.status)) {
    const response = await deps
      .engine(`/runs/${meta.engineRunId}`, { headers: { 'X-Service-Key': deps.engineKey } })
      .catch(() => null);
    if (response?.ok) {
      const state = (await response.json()) as { status: string; message: string | null; cost_usd: string | null };
      ({ status, message } = state);
      cost = state.cost_usd;
    }
  }
  // The run list reads D1: keep it in step with what the run says now.
  await deps.store
    .updateRun(meta.runId, {
      status,
      message,
      lastSeq: meta.lastSeq,
      ...(cost !== null && Number.isFinite(Number(cost)) ? { costUsd: Number(cost) } : {}),
    })
    .catch(() => undefined);
  // With the record from the run list, so the app needs one call to show a run.
  const record = await deps.store.getRun(meta.runId).catch(() => null);
  return json(200, {
    ...(record ?? {}),
    run_id: meta.runId,
    status,
    message,
    cost_usd: cost,
    last_seq: meta.lastSeq,
  });
}

async function control(deps: Deps, meta: RunMeta, action: string, request: Request, gateId?: string) {
  if (!meta.engineRunId) throw new HttpError(409, 'run_starting', 'the run has not started yet');
  const body = request.headers.get('content-type')?.includes('json') ? await readJson(request) : {};
  const path = gateId
    ? `/runs/${meta.engineRunId}/gates/${encodeURIComponent(gateId)}`
    : `/runs/${meta.engineRunId}/${action}`;
  const allowed = gateId ? ['option_id', 'dropped', 'note', 'llm'] : action === 'resume' ? ['llm'] : [];
  const forward = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
  return relay(
    await deps.engine(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': deps.engineKey },
      body: JSON.stringify(forward),
    }),
  );
}

async function artifact(deps: Deps, meta: RunMeta, path: string) {
  if (!meta.engineRunId || !ARTIFACT_PATH.test(path)) throw new HttpError(404, 'not_found');
  const object = await deps.bucket.get(`i2h/runs/${meta.engineRunId}/${path}`);
  if (!object) throw new HttpError(404, 'not_found');
  const type = path.endsWith('.json') ? 'application/json' : path.endsWith('.md') ? 'text/markdown' : 'text/plain';
  return new Response(await object.arrayBuffer(), {
    headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' },
  });
}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, 'bad_request', `${field} is required`);
  if (trimmed.length > max) throw new HttpError(400, 'bad_request', `${field} is longer than ${max} characters`);
  return trimmed;
}

function projectName(value: unknown, required: boolean): string | undefined {
  const name = text(value, 'name', 200, required);
  if (name !== undefined && name.length < 3)
    throw new HttpError(400, 'bad_request', 'name must have at least 3 characters');
  return name;
}

async function projects(deps: Deps, request: Request, who: Identity): Promise<Response> {
  if (request.method === 'GET') return json(200, { projects: await deps.store.listProjects(who.email) });
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson(request);
  const created = await deps.store.createProject({
    id: deps.newProjectId(),
    name: projectName(body.name, true) as string,
    description: text(body.description, 'description', 2000) ?? '',
    owner: who.email,
  });
  return json(201, created);
}

async function members(deps: Deps, request: Request, projectId: string, owner: string, member?: string) {
  if (request.method === 'POST' && !member) {
    const email = text((await readJson(request)).email, 'email', 320, true) as string;
    if (!emailAllowed(email, deps.allowedDomain))
      throw new HttpError(400, 'bad_request', `only @${deps.allowedDomain} accounts can be members`);
    await deps.store.addMember(projectId, email);
  } else if (request.method === 'DELETE' && member) {
    const email = normalEmail(decodeURIComponent(member));
    if (email === owner) throw new HttpError(409, 'owner', 'the owner stays a member');
    await deps.store.removeMember(projectId, email);
  } else throw new HttpError(405, 'method_not_allowed');
  return json(200, await deps.store.getProject(projectId));
}

async function project(deps: Deps, request: Request, who: Identity, projectId: string, rest: string[]) {
  const found = await deps.store.getProject(projectId);
  if (!found) throw new HttpError(404, 'not_found', 'project not found');
  const me = normalEmail(who.email);
  if (!found.member_emails.includes(me)) throw new HttpError(403, 'forbidden', 'no access to this project');
  const owner = found.owner_email === me;
  const [kind, member, ...extra] = rest;
  if (kind === 'members' && !extra.length) {
    if (!owner) throw new HttpError(403, 'forbidden', 'only the owner manages members');
    return members(deps, request, projectId, found.owner_email, member);
  }
  if (kind) throw new HttpError(404, 'not_found');
  if (request.method === 'GET') return json(200, found);
  if (request.method === 'DELETE') {
    if (!owner) throw new HttpError(403, 'forbidden', 'only the owner deletes a project');
    await deps.store.deleteProject(projectId);
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'PATCH') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson(request);
  const fields: { name?: string; description?: string; status?: ProjectStatus; owner_email?: string } = {};
  const name = projectName(body.name, false);
  if (name !== undefined) fields.name = name;
  const description = text(body.description, 'description', 2000);
  if (description !== undefined) fields.description = description;
  if (body.status !== undefined) {
    if (!PROJECT_STATUSES.includes(body.status as ProjectStatus))
      throw new HttpError(400, 'bad_request', `status is one of ${PROJECT_STATUSES.join(', ')}`);
    fields.status = body.status as ProjectStatus;
  }
  if (body.owner_email !== undefined) {
    if (!owner) throw new HttpError(403, 'forbidden', 'only the owner hands the project over');
    const next = text(body.owner_email, 'owner_email', 320, true) as string;
    if (!found.member_emails.includes(normalEmail(next)))
      throw new HttpError(400, 'bad_request', 'the new owner must be a member');
    fields.owner_email = next;
  }
  await deps.store.updateProject(projectId, fields);
  return json(200, await deps.store.getProject(projectId));
}

async function publicRoute(deps: Deps, request: Request, parts: string[]): Promise<Response> {
  // parts: ['v1', 'projects', p?, 'runs' | 'members'?, r?, action?, gateId?]
  const [, , projectId, runs, runId, action, ...rest] = parts;
  if (projectId !== undefined && !ID.test(projectId)) throw new HttpError(404, 'not_found');
  const who = await caller(deps, request);
  if (!projectId) return projects(deps, request, who);
  if (runs !== 'runs') return project(deps, request, who, projectId, parts.slice(3));
  if (!(await deps.store.isMember(projectId, who.email)))
    throw new HttpError(403, 'forbidden', 'no access to this project');
  if (!runId) {
    if (request.method === 'GET') {
      const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100) || 100;
      return json(200, { runs: await deps.store.listRuns(projectId, limit) });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    return startRun(deps, projectId, who, request);
  }
  if (!ID.test(runId)) throw new HttpError(404, 'not_found');
  const meta = await runMeta(deps, runId);
  if (meta.projectId !== projectId) throw new HttpError(404, 'not_found', 'run not found');
  // The newest token of someone following the run, for the lab routes the engine calls.
  await deps.run(runId)('/token', { method: 'POST', body: JSON.stringify({ token: who.token, exp: who.exp }) });

  if (!action && request.method === 'GET') return runState(deps, meta);
  if (action === 'events' && request.method === 'GET') {
    const url = new URL(request.url);
    const after = Number(request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0) || 0;
    const wantsJson =
      url.searchParams.get('format') === 'json' || !request.headers.get('accept')?.includes('text/event-stream');
    if (wantsJson) {
      const limit = url.searchParams.get('limit') ?? '500';
      return deps.run(runId)(`/events?after=${after}&limit=${encodeURIComponent(limit)}`);
    }
    return deps.run(runId)(`/stream?after=${after}`);
  }
  if (action === 'artifacts' && request.method === 'GET') return artifact(deps, meta, rest.join('/'));
  if (request.method === 'POST' && (action === 'pause' || action === 'resume' || action === 'cancel'))
    return control(deps, meta, action, request);
  if (request.method === 'POST' && action === 'gates' && rest.length === 1 && rest[0])
    return control(deps, meta, 'gates', request, rest[0]);
  throw new HttpError(404, 'not_found');
}

// ---------------------------------------------------------------------------------------------------
// Internal routes
// ---------------------------------------------------------------------------------------------------

async function mirror(deps: Deps, request: Request, engineRunId: string, path: string): Promise<Response> {
  const prefix = `i2h/runs/${engineRunId}/`;
  if (!path) {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const files: Record<string, string> = {};
    let cursor: string | undefined;
    do {
      const page = await deps.bucket.list({ prefix, cursor, include: ['customMetadata'] });
      for (const object of page.objects) files[object.key.slice(prefix.length)] = object.customMetadata?.sha256 ?? '';
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (!Object.keys(files).length) throw new HttpError(404, 'not_found');
    return json(200, { files });
  }
  if (!MIRROR_PATH.test(path)) throw new HttpError(400, 'bad_path');
  if (request.method === 'GET') {
    const object = await deps.bucket.get(prefix + path);
    if (!object) throw new HttpError(404, 'not_found');
    return new Response(await object.arrayBuffer());
  }
  if (request.method === 'PUT') {
    const sha256 = request.headers.get('x-content-sha256') ?? '';
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, 'bad_digest');
    const data = await request.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== sha256) throw new HttpError(422, 'digest_mismatch');
    await deps.bucket.put(prefix + path, data, { customMetadata: { sha256 } });
    return json(201, { ok: true });
  }
  throw new HttpError(405, 'method_not_allowed');
}

/** Lab routes the engine may call, with the run's newest token: method and path pattern. */
const LAB_ROUTES: [string, RegExp][] = [
  ['POST', /^\/v1\/kg\/search$/],
  ['POST', /^\/v1\/sciatlas\/search$/],
  ['GET', /^\/corpora\/[0-9a-f-]{36}$/i],
  ['GET', /^\/v1\/papers\/[A-Za-z0-9-]{1,80}\/model$/],
];

async function fulltext(deps: Deps, request: Request, token: string): Promise<Response> {
  const body = await readJson(request);
  const key = await doiKey(String(body.doi ?? ''));
  if (!key) throw new HttpError(400, 'bad_doi');
  const object = await deps.bucket.get(`papers/${key}.pdf`);
  if (!object) throw new HttpError(404, 'no_pdf', 'the lab has no PDF for this DOI');
  const pdf = await object.arrayBuffer();
  // GROBID's container may be starting (503 with Retry-After); wait for it up to about two minutes.
  for (let attempt = 0; ; attempt += 1) {
    const response = await deps.paperlab('/grobid/fulltext', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
      body: pdf,
    });
    if (response.status === 503 && attempt < 4 && deps.wait) {
      await deps.wait(Math.min(Number(response.headers.get('retry-after')) || 30, 30) * 1000);
      continue;
    }
    if (!response.ok) throw new HttpError(502, 'grobid_error', `GROBID answered ${response.status}`);
    return new Response(await response.text(), { headers: { 'Content-Type': 'application/xml' } });
  }
}

async function lab(deps: Deps, request: Request, runId: string, route: string): Promise<Response> {
  const tokenResponse = await deps.run(runId)('/token');
  if (!tokenResponse.ok)
    throw new HttpError(409, 'no_token', 'nobody is signed in on this run; lab sources wait for the app');
  const { token } = (await tokenResponse.json()) as { token: string };
  if (route === '/fulltext' && request.method === 'POST') return fulltext(deps, request, token);
  if (!LAB_ROUTES.some(([method, pattern]) => method === request.method && pattern.test(route)))
    throw new HttpError(404, 'not_found');
  const response = await deps.paperlab(route, {
    method: request.method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(request.method === 'POST' ? { body: await request.text() } : {}),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  });
}

async function internalRoute(deps: Deps, request: Request, parts: string[]): Promise<Response> {
  if (!sameSecret(request.headers.get('x-service-key') ?? '', deps.engineKey))
    throw new HttpError(401, 'unauthenticated');
  // parts: ['internal', 'runs', id, kind, ...rest]
  const [, runs, id, kind, ...rest] = parts;
  if (runs !== 'runs' || !id || !ID.test(id)) throw new HttpError(404, 'not_found');
  if (kind === 'events' && request.method === 'POST' && !rest.length) {
    // A request into the container keeps it awake: a run that is delivering events is working, even
    // when nobody is watching it.
    deps.keepEngineAwake?.();
    return deps.run(id)('/events', { method: 'POST', body: await request.text() });
  }
  if (kind === 'files') return mirror(deps, request, id, rest.map(decodeURIComponent).join('/'));
  if (kind === 'lab') return lab(deps, request, id, `/${rest.join('/')}`);
  throw new HttpError(404, 'not_found');
}

export async function handle(deps: Deps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const corsHeaders = parts[0] === 'internal' ? {} : cors(request.headers.get('origin'), deps.allowedOrigins);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  let response: Response;
  try {
    if (parts[0] === 'internal') response = await internalRoute(deps, request, parts);
    else if (parts[0] === 'v1' && parts[1] === 'projects') response = await publicRoute(deps, request, parts);
    else if (url.pathname === '/health') response = json(200, { status: 'ok' });
    else throw new HttpError(404, 'not_found');
  } catch (error) {
    if (error instanceof HttpError)
      response = json(error.status, { error: error.code, message: error.message }, error.headers);
    else {
      console.error('unhandled', error instanceof Error ? error.message : String(error));
      response = json(500, { error: 'internal', message: 'internal error' });
    }
  }
  if (!Object.keys(corsHeaders).length) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
