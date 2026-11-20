// Projects, members and run records in D1 (migrations/). Who may see what is decided here: a person sees a
// project, and its runs, only when their email is among the project's members.

/** The part of D1's API this module uses, so tests can run it on node:sqlite. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

export const PROJECT_STATUSES = ['researching', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  id: string;
  name: string;
  description: string;
  owner_email: string;
  member_emails: string[];
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  run_id: string;
  project_id: string;
  topic: string;
  review_mode: string;
  domains: string[];
  status: string;
  message: string | null;
  last_seq: number;
  cost_usd: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  owner_email: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  members: string | null;
}
interface RunRow {
  id: string;
  project_id: string;
  topic: string;
  review_mode: string;
  domains: string;
  status: string;
  message: string | null;
  last_seq: number;
  cost_usd: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const PROJECT_SELECT = `SELECT p.id, p.name, p.description, p.owner_email, p.status, p.created_at, p.updated_at,
  (SELECT group_concat(m.email, ',') FROM project_members m WHERE m.project_id = p.id) AS members
  FROM projects p`;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner_email: row.owner_email,
    member_emails: row.members ? row.members.split(',').sort() : [],
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRun(row: RunRow): RunRecord {
  let domains: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.domains);
    if (Array.isArray(parsed)) domains = parsed.map(String);
  } catch {
    domains = [];
  }
  return {
    run_id: row.id,
    project_id: row.project_id,
    topic: row.topic,
    review_mode: row.review_mode,
    domains,
    status: row.status,
    message: row.message,
    last_seq: row.last_seq,
    cost_usd: row.cost_usd,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const normalEmail = (email: string) => email.trim().toLowerCase();

export class Store {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async isMember(projectId: string, email: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS ok FROM project_members WHERE project_id = ? AND email = ?`)
      .bind(projectId, normalEmail(email))
      .first<{ ok: number }>();
    return Boolean(row);
  }

  /** The person's projects, newest first. */
  async listProjects(email: string): Promise<Project[]> {
    const { results } = await this.db
      .prepare(
        `${PROJECT_SELECT} WHERE p.id IN (SELECT project_id FROM project_members WHERE email = ?) ORDER BY p.created_at DESC`,
      )
      .bind(normalEmail(email))
      .all<ProjectRow>();
    return results.map(toProject);
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(id).first<ProjectRow>();
    return row ? toProject(row) : null;
  }

  async createProject(input: { id: string; name: string; description: string; owner: string }): Promise<Project> {
    const now = this.now();
    const owner = normalEmail(input.owner);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO projects (id, name, description, owner_email, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'researching', ?, ?)`,
        )
        .bind(input.id, input.name, input.description, owner, now, now),
      this.db
        .prepare(`INSERT INTO project_members (project_id, email, added_at) VALUES (?, ?, ?)`)
        .bind(input.id, owner, now),
    ]);
    return (await this.getProject(input.id)) as Project;
  }

  async updateProject(
    id: string,
    fields: { name?: string; description?: string; status?: ProjectStatus; owner_email?: string },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) (sets.push('name = ?'), values.push(fields.name));
    if (fields.description !== undefined) (sets.push('description = ?'), values.push(fields.description));
    if (fields.status !== undefined) (sets.push('status = ?'), values.push(fields.status));
    if (fields.owner_email !== undefined) (sets.push('owner_email = ?'), values.push(normalEmail(fields.owner_email)));
    const now = this.now();
    const statements = [
      this.db.prepare(`UPDATE projects SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`).bind(...values, now, id),
    ];
    // A new owner is always a member.
    if (fields.owner_email !== undefined)
      statements.push(
        this.db
          .prepare(`INSERT OR IGNORE INTO project_members (project_id, email, added_at) VALUES (?, ?, ?)`)
          .bind(id, normalEmail(fields.owner_email), now),
      );
    await this.db.batch(statements);
  }

  async addMember(projectId: string, email: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO project_members (project_id, email, added_at) VALUES (?, ?, ?)`)
      .bind(projectId, normalEmail(email), this.now())
      .run();
  }

  async removeMember(projectId: string, email: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM project_members WHERE project_id = ? AND email = ?`)
      .bind(projectId, normalEmail(email))
      .run();
  }

  async deleteProject(id: string): Promise<void> {
    // D1 enforces foreign keys, but delete children explicitly so it holds without them too.
    await this.db.batch([
      this.db.prepare(`DELETE FROM runs WHERE project_id = ?`).bind(id),
      this.db.prepare(`DELETE FROM project_members WHERE project_id = ?`).bind(id),
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).bind(id),
    ]);
  }

  async listRuns(projectId: string, limit = 100): Promise<RunRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(projectId, Math.max(1, Math.min(limit, 500)))
      .all<RunRow>();
    return results.map(toRun);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first<RunRow>();
    return row ? toRun(row) : null;
  }

  async insertRun(run: {
    runId: string;
    projectId: string;
    topic: string;
    reviewMode: string;
    domains: string[];
    status: string;
    createdBy: string;
  }): Promise<void> {
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO runs (id, project_id, topic, review_mode, domains, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.runId,
        run.projectId,
        run.topic,
        run.reviewMode,
        JSON.stringify(run.domains),
        run.status,
        normalEmail(run.createdBy),
        now,
        now,
      )
      .run();
  }

  /** Keeps the list in step with the run. Only the fields given change; nothing changes when nothing differs. */
  async updateRun(
    runId: string,
    fields: { status?: string; message?: string | null; lastSeq?: number; costUsd?: number | null },
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.status !== undefined) (sets.push('status = ?'), values.push(fields.status));
    if (fields.message !== undefined) (sets.push('message = ?'), values.push(fields.message));
    if (fields.lastSeq !== undefined) (sets.push('last_seq = MAX(last_seq, ?)'), values.push(fields.lastSeq));
    if (fields.costUsd !== undefined) (sets.push('cost_usd = ?'), values.push(fields.costUsd));
    if (!sets.length) return;
    await this.db
      .prepare(`UPDATE runs SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .bind(...values, this.now(), runId)
      .run();
  }
}
