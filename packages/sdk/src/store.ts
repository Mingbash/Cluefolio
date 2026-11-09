import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Project, Job } from "./types.ts";
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "state.sqlite"));
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind,id))",
    );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  mutateProject(id: string, fn: (project: Project) => void): Project {
    return this.transaction(() => {
      const project = this.project(id);
      fn(project);
      this.put("project", project);
      return project;
    });
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return r ? { version: 1, ...JSON.parse(r.data) } : undefined;
  }
  put(kind: string, x: { id: string }) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, x.id, JSON.stringify(x));
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((x: any) => ({ version: 1, ...JSON.parse(x.data) }));
  }
  project(id: string) {
    const p = this.get<Project>("project", id);
    if (!p) throw new Error("项目不存在");
    return p;
  }
  recover() {
    this.transaction(() => this.recoverInterrupted());
  }
  private recoverInterrupted() {
    for (const j of this.list<Job>("job"))
      if (j.status === "running" && j.ownerPid && !alive(j.ownerPid)) {
        j.status = "paused";
        j.error = "上次运行中断，可恢复";
        this.put("job", j);
      }
    for (const p of this.list<Project>("project"))
      if (
        p.scan.status === "running" &&
        (p.scan as any).ownerPid &&
        !alive((p.scan as any).ownerPid)
      ) {
        p.scan.status = "paused";
        p.scan.error = "加载中断，可继续";
        this.put("project", p);
      }
  }
  close() {
    this.db.close();
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}
