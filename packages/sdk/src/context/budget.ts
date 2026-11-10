import { TaskError } from "../util.ts";
import type { StageName } from "./schema.ts";

export const DEFAULT_TOKEN_BUDGET = {
  hardLimit: 1_000_000,
  degradedAt: 800_000,
  allocations: {
    unitize: 280_000,
    discover: 180_000,
    verify: 80_000,
    attribute: 100_000,
    synthesize: 180_000,
    index: 20_000,
    evaluate: 100_000,
    package: 20_000,
    register: 0,
    acquire: 0,
    clean: 0,
  } satisfies Record<StageName, number>,
};

export class TokenBudget {
  private usage = new Map<StageName, number>();
  constructor(
    readonly hardLimit = DEFAULT_TOKEN_BUDGET.hardLimit,
    readonly degradedAt = DEFAULT_TOKEN_BUDGET.degradedAt,
  ) {}
  used() { return [...this.usage.values()].reduce((a, b) => a + b, 0); }
  remaining() { return Math.max(0, this.hardLimit - this.used()); }
  degraded() { return this.used() >= this.degradedAt; }
  stageUsed(stage: StageName) { return this.usage.get(stage) ?? 0; }
  consume(stage: StageName, tokens: number) {
    if (!Number.isInteger(tokens) || tokens < 0) throw new TaskError("TOKEN_BUDGET", "Token 使用量必须是非负整数");
    if (this.used() + tokens > this.hardLimit) throw new TaskError("TOKEN_BUDGET", `任务模型输入将超过 ${this.hardLimit.toLocaleString()} tokens 硬上限`);
    this.usage.set(stage, this.stageUsed(stage) + tokens);
    return { used: this.used(), remaining: this.remaining(), degraded: this.degraded() };
  }
  snapshot() { return { hardLimit: this.hardLimit, degradedAt: this.degradedAt, used: this.used(), byStage: Object.fromEntries(this.usage) }; }
}

type UsageRecord = { id: string; used: number; hardLimit?: number };

export const inputBudgetError = (limit = DEFAULT_TOKEN_BUDGET.hardLimit) =>
  new TaskError("TOKEN_BUDGET", `同一任务累计模型输入将超过 ${limit.toLocaleString()} token，已停止投递新材料`);

/** Durable, atomic accounting shared by the CLI, workbench, and Desktop MCP. */
export class JobInputBudget {
  constructor(private store: import("../store.ts").Store, private jobId: string) {}

  used() {
    return this.store.get<UsageRecord>("input-budget", this.jobId)?.used ?? 0;
  }

  limit() {
    return this.store.get<UsageRecord>("input-budget", this.jobId)?.hardLimit ?? DEFAULT_TOKEN_BUDGET.hardLimit;
  }

  snapshot() { return { used: this.used(), hardLimit: this.limit(), remaining: Math.max(0, this.limit() - this.used()) }; }

  setInitialLimit(limit: number) {
    if (this.used() !== 0 || !Number.isSafeInteger(limit) || limit < 10_000 || limit > 20_000_000)
      throw new TaskError("TOKEN_BUDGET", "无法设置初始预算");
    this.store.transaction(() => this.write(0, limit));
  }

  raiseLimit(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < this.limit() || limit > 20_000_000)
      throw new TaskError("TOKEN_BUDGET", "新预算必须高于当前预算，且不超过 20,000,000 token");
    this.store.transaction(() => this.write(this.used(), limit));
    return this.snapshot();
  }

  seedLegacy(used: number) {
    if (!Number.isSafeInteger(used) || used < 0) throw inputBudgetError();
    this.store.transaction(() => this.write(Math.max(used, this.used())));
  }

  charge(amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw inputBudgetError();
    this.store.transaction(() => {
      const used = this.used();
      if (used + amount > this.limit()) throw inputBudgetError(this.limit());
      this.write(used + amount);
    });
  }

  settle(reserved: number, reported: number) {
    if (!Number.isSafeInteger(reported) || reported <= 0) return;
    const used = this.store.transaction(() => {
      const next = this.used() - reserved + reported;
      this.write(next);
      return next;
    });
    if (used > this.limit()) throw inputBudgetError(this.limit());
  }

  private write(used: number, hardLimit = this.limit()) {
    const record = { id: this.jobId, used, hardLimit };
    this.store.put("input-budget", record);
  }
}
