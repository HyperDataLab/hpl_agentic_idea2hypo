# idea2hypothesis on Firebase and Cloudflare

The deployment the lab uses, in the style of PaperLab and Paper Fetch Hub: no server of our own,
no .NET backend. The engine (this package) runs unchanged inside a Cloudflare Container; a Worker
is the only public API; Firebase serves the app and holds the project list.

```text
Browser (Next.js static export of hpl_agentic_platform_fe, Firebase Hosting hyperdatalab-idea2hypo)
  │  Google sign-in, verified @hyperdatalab.org only (Firebase Auth) → ID token
  ▼
i2h-worker (worker/)                         Authorization: Bearer <ID token>; the caller must be a
  ├─ D1 `i2h` (worker/migrations)            member of the project (project_members)
  │    projects, project_members, runs: the project list, its members and its run list
  ├─ RunObject (Durable Object per run)
  │    event log (SQLite), live SSE, newest token of a follower (memory only)
  ├─ EngineContainer (Dockerfile, configs/cloudflare.yaml)
  │    FastAPI engine; one instance for every run
  └─ R2 bucket paper-fetch (shared with Paper Fetch Hub and PaperLab)
       i2h/runs/<engine run id>/…   run folders (mirror of the container's disk)
       papers/<doiKey>.pdf          PDFs fetched by Paper Fetch Hub (read only)
PaperLab worker (paperlab-pdf-worker): Lab KG, SciAtlas, corpora, paper models, GROBID
```

## Who holds which secret

| Secret | Where | Never |
| --- | --- | --- |
| The person's 9router key | the app's Settings (`localStorage`), sent with start / resume / gate; the engine keeps it in memory for the run | stored by the Worker, written to `run.json`, `config.snapshot.json`, events, R2 or logs (tests: `tests/contracts/test_api_run_llm.py`) |
| Firebase ID token | the browser; the run's Durable Object keeps the newest one in memory to call lab services for the engine | written to storage, sent to the engine |
| `ENGINE_KEY` | Worker secret; given to the container as `I2H_SERVICE_KEY`, `I2H_CALLBACK_KEY`, `I2H_WORKER_KEY` | the browser |
| R2 access | the Worker's R2 binding | the container (it writes run files through the Worker) |

After an engine restart a run that used a person's key answers `503 LLM_KEY_REQUIRED` until the app
sends the key again (resume or gate answer with `llm`).

## Public API (the app)

Every route needs `Authorization: Bearer <Firebase ID token>`; `401 unauthenticated`, `403 forbidden`
(another domain, or no access to the project), `404 not_found` (unknown run, or a run of another
project). Errors are `{ "error": code, "message": text }`.

| Method | Route | Body / answer |
| --- | --- | --- |
| GET | `/v1/projects` | `{projects: Project[]}`, the caller's projects, newest first. `Project` is `{id, name, description, owner_email, member_emails, status: researching\|completed\|archived, created_at, updated_at}` |
| POST | `/v1/projects` | `{name (3–200), description?}` → `201 Project`; the caller owns it and is its first member |
| GET / PATCH / DELETE | `/v1/projects/:p` | members read and edit `{name?, description?, status?}`; only the owner sends `owner_email` (a member) or deletes (`204`, runs go with it) |
| POST | `/v1/projects/:p/members` | owner only: `{email}` of a verified-domain account → `Project` |
| DELETE | `/v1/projects/:p/members/:email` | owner only; the owner can't be removed (`409`) → `Project` |
| GET | `/v1/projects/:p/runs?limit=` | `{runs: [{run_id, project_id, topic, review_mode, domains, status, message, last_seq, cost_usd, created_by, created_at, updated_at}]}`, newest first; written by the Worker at start and kept in step by `GET …/runs/:r` and the run's Durable Object |
| POST | `/v1/projects/:p/runs` | `{topic, domains?, review_mode?, budget_usd?, llm: {base_url, api_key, model, role_models?: {theorist?, methodologist?, skeptic?, judge?}}, sources?: {corpus_id?, lab_kg?, sciatlas?, fulltext?}, case?: {intent: {kind: test\|compare\|explain\|explore_dataset, text (12-500)}, context? (≤4000), constraints? (≤20 × ≤500), references? (≤30 × {citation (3-500)})}}` → `201 {run_id, status}`; a malformed `case` is `400 bad_request`. `case` is optional; the Worker checks and trims it, drops empty parts and forwards it to the engine, but does not store it in D1 (the engine keeps it with the run) |
| GET | `/v1/projects/:p/runs/:r` | `{run_id, status, message, cost_usd, last_seq}` plus the run list record (`topic, review_mode, domains, created_by, created_at, …`); `status` is `starting`, `running`, `paused`, `awaiting_review`, `completed` or `failed` |
| GET | `/v1/projects/:p/runs/:r/events` | `Accept: text/event-stream`: SSE from `after` / `Last-Event-ID` (`event: run-event`, `id` = `seq`; `event: run-ended` when the run is over; `: keep-alive` every 20 s). Otherwise `?after=&limit=` → `{events, last_seq}` |
| POST | `/v1/projects/:p/runs/:r/pause`, `/cancel` | — |
| POST | `/v1/projects/:p/runs/:r/resume` | `{llm?}` |
| POST | `/v1/projects/:p/runs/:r/gates/:gateId` | `{option_id: approve\|drop\|reject, dropped?, note?, llm?}` |
| GET | `/v1/projects/:p/runs/:r/artifacts/stage-NN/<file>` | a stage artifact from the mirror (JSON / Markdown) |

An event is `{seq, run_id, ts, type, stage_key?, actor?, payload}`: the engine's Platform event
(`docs/platform-integration.md`) with `source_seq` as `seq`, the shape the run studio's
`parseRunEvent` reads. `seq` is contiguous from 1.

Multi-agent: `role_models` gives the Theorist, Methodologist and Skeptic (stage 8 perspectives and
their rebuttals) and the judge their own model; an unset role uses `model`. A judge model different
from `model` makes the debate judge independent (`debate_record.json` `independent_judge`).

## Internal API (engine container → Worker)

`X-Service-Key: ENGINE_KEY` on every call.

| Route | Used by |
| --- | --- |
| `POST /internal/runs/:r/events` | `api/webhooks.py` event delivery (`callback_url` = `/internal/runs/:r`); 422 on a gap, repeats dropped |
| `GET /internal/runs/:engineRunId/files`, `GET\|PUT …/files/<path>` | `storage/mirror.py`; `PUT` carries `X-Content-SHA256`, checked |
| `POST /internal/runs/:r/lab/v1/kg/search`, `…/v1/sciatlas/search`, `GET …/corpora/:id`, `GET …/v1/papers/:id/model` | `literature/providers/lab_sources.py`, forwarded to PaperLab with the run's newest token; `409 no_token` when nobody signed in follows the run |
| `POST /internal/runs/:r/lab/fulltext` `{doi}` | `literature/fulltext.py`: `papers/<doiKey>.pdf` → PaperLab GROBID → TEI; 404 when the lab has no PDF |

## Paper sources

| Source | Records | Notes |
| --- | --- | --- |
| OpenAlex, Semantic Scholar, arXiv | as before | configured in `literature.sources` |
| `lab_kg` | the lab KG's own OpenAlex copy | `sources.lab_kg` |
| `sciatlas` | **ids only**, records from OpenAlex | SciAtlas's licence is not stated; as in PaperLab, nothing else of its answer is kept |
| `paperlab_corpus` | the corpus members' published paper models → DOIs → OpenAlex | `sources.corpus_id`; returned once, for the first query |
| full text (stage 6) | GROBID TEI of PDFs Paper Fetch Hub stored | `sources.fulltext`; cards say `evidence_scope: "full_text"`; `knowledge_meta.json` lists `fulltext_missing_dois` to queue in Paper Fetch Hub, then redo stage 6 |

A lab source that fails (no token, quota, KG not configured) is recorded per source in
`search_meta.json` and never fails the run; full text that fails falls back to the abstract.

## Run storage

The container's disk is temporary. After every event the changed files of the run folder are sent
to the Worker (`storage/mirror.py`), which keeps them in R2 under `i2h/runs/<engine run id>/`. A
route that names a run missing from disk fetches it back first (`RunService.locate`); a run that was
`running` when the old container stopped is then `paused` (`interrupted`) and continues on resume.

## Deploy (owner)

1. Firebase: create project `hyperdatalab-idea2hypo` (Spark) and enable Google sign-in. Firebase only signs
   people in and hosts the app; Hosting is deployed from `hpl_agentic_platform_fe` (`firebase.json` there).
2. PaperLab: add `hyperdatalab-idea2hypo` to `ACCEPTED_PROJECT_IDS` in `paper-lab/worker/wrangler.toml`
   (its routes accept this app's tokens) and deploy that worker.
3. Worker (Workers Paid plan, Docker for the image build), from `worker/`:
   `npm ci`; once, `npx wrangler d1 create i2h` and put its `database_id` in `wrangler.toml`;
   `npx wrangler d1 migrations apply i2h --remote` (again after a new migration);
   `npx wrangler secret put ENGINE_KEY` (and `S2_API_KEY` if any), `npx wrangler deploy`.
4. App: build the static export of `hpl_agentic_platform_fe` with `NEXT_PUBLIC_I2H_WORKER_URL` and
   deploy Hosting from that repo.

## Local development

* Engine: `I2H_CONFIG=configs/cloudflare-local.yaml` and `I2H_SERVICE_KEY`, `I2H_CALLBACK_KEY`,
  `I2H_WORKER_KEY` = the same dev key; `python tools/serve_api.py` (port 8080).
* Worker: `worker/.dev.vars` with `ENGINE_KEY=<dev key>` and `ENGINE_URL=http://localhost:8080`
  (the Worker then calls that engine instead of the container), `INTERNAL_BASE_URL=http://localhost:8787/internal`;
  `npm run dev`.
* Tests: `python -m pytest -q` (engine), `cd worker && npm test && npm run typecheck`.
