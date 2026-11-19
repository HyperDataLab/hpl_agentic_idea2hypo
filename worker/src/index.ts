import { Container, getContainer } from '@cloudflare/containers';
import { createRemoteJWKSet } from 'jose';
import { handle, type Bucket, type Fetch } from './app';
import { SECURETOKEN_JWKS, verifyFirebaseToken } from './auth';

export { RunObject } from './runDo';

interface Env {
  RUN: DurableObjectNamespace;
  ENGINE: DurableObjectNamespace;
  BUCKET: Bucket;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_DOMAIN: string;
  ALLOWED_ORIGINS: string;
  PAPERLAB_WORKER_URL: string;
  INTERNAL_BASE_URL: string;
  /** Secret: Worker <-> engine key (`wrangler secret put ENGINE_KEY`). */
  ENGINE_KEY: string;
  /** Optional secret for the engine's Semantic Scholar searches. */
  S2_API_KEY?: string;
  /** Local development: the engine's address (a venv or Docker on this machine) instead of the container. */
  ENGINE_URL?: string;
}

/** The idea2hypothesis engine (repository root Dockerfile). One instance serves every run. */
export class EngineContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '20m';
  enableInternet = true;
  constructor(...args: ConstructorParameters<typeof Container<Env>>) {
    super(...args);
    const env = args[1];
    this.envVars = {
      I2H_SERVICE_KEY: env.ENGINE_KEY,
      I2H_CALLBACK_KEY: env.ENGINE_KEY,
      I2H_WORKER_KEY: env.ENGINE_KEY,
      ...(env.S2_API_KEY ? { S2_API_KEY: env.S2_API_KEY } : {}),
    };
  }
}

const jwks = createRemoteJWKSet(new URL(SECURETOKEN_JWKS));
const projectReads = new Map<string, { ok: boolean; until: number }>();

async function canReadProject(env: Env, projectId: string, token: string): Promise<boolean> {
  // Firestore rules decide who belongs to a project: reading it with the person's token asks them.
  const cacheKey = `${token.slice(-24)}:${projectId}`;
  const cached = projectReads.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.ok;
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/projects/${encodeURIComponent(projectId)}?mask.fieldPaths=name`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const ok = response.ok;
  projectReads.set(cacheKey, { ok, until: Date.now() + 60_000 });
  if (projectReads.size > 5000) projectReads.clear();
  return ok;
}

function engineFetch(env: Env): Fetch {
  if (env.ENGINE_URL) {
    const base = env.ENGINE_URL.replace(/\/+$/, '');
    return (path, init) => fetch(`${base}${path}`, init);
  }
  return (path, init) => getContainer(env.ENGINE as never).fetch(new Request(`http://engine${path}`, init));
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const engine = engineFetch(env);
    const paperlabBase = env.PAPERLAB_WORKER_URL.replace(/\/+$/, '');
    return handle(
      {
        allowedOrigins: env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
        verifyToken: (token) => verifyFirebaseToken(token, jwks, env.FIREBASE_PROJECT_ID, env.ALLOWED_DOMAIN),
        canReadProject: (projectId, token) => canReadProject(env, projectId, token),
        run: (runId) => {
          const stub = env.RUN.get(env.RUN.idFromName(runId));
          return (path, init) => stub.fetch(new Request(`http://run${path}`, init));
        },
        engine,
        paperlab: (path, init) => fetch(`${paperlabBase}${path}`, init),
        bucket: env.BUCKET,
        engineKey: env.ENGINE_KEY,
        internalBase: env.INTERNAL_BASE_URL.replace(/\/+$/, ''),
        newId: () => `run-${crypto.randomUUID()}`,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        keepEngineAwake: () => ctx.waitUntil(engine('/api/health').catch(() => undefined)),
      },
      request,
    );
  },
};
