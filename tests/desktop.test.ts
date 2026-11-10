import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  atomic,
  config,
  ContextRuntime,
  Distiller,
  JobInputBudget,
  verifyContextDirectory,
} from "../packages/sdk/src/index.ts";
import { createApp } from "../apps/server/app.ts";
import { Store } from "../packages/sdk/src/store.ts";
import { normalizeDetail } from "../packages/sdk/src/providers.ts";

function connect(dataDir: string) {
  const child = spawn(process.execPath, ["scripts/desktop-mcp.mjs"], {
    env: {
      ...process.env,
      XHS_DATA_DIR: dataDir,
      CODEX_HOME: path.join(path.dirname(dataDir), "codex-home"),
      CODEX_BIN: "/nonexistent/codex",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let id = 0;
  return {
    async rpc(method: string, params = {}) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n",
      );
      const message = await lines.next();
      assert.equal(message.done, false, "desktop MCP exited before replying");
      const response = JSON.parse(message.value);
      assert.equal(response.id, id);
      assert.ok(!response.error, JSON.stringify(response.error));
      return response.result;
    },
    async call(name: string, args: Record<string, unknown>) {
      const response = await this.rpc("tools/call", { name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      return response.structuredContent;
    },
    async stop() {
      child.kill("SIGKILL");
      await exit;
    },
  };
}

test(
  "Desktop MCP resumes the same multi-batch Context after its worker is killed",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cluefolio-desktop-test-"));
    const dataDir = path.join(root, "data");
    const cfg = config(root, { dataDir });
    const sdk = new Distiller(cfg);
    const project = sdk.createProject("访谈研究", "desktop-test");
    const noteIds = Array.from({ length: 4 }, (_, i) =>
      String(i + 1).padStart(24, "0"),
    );
    const body = "先访谈客户，再验证付费意愿。";
    for (const noteId of noteIds) {
      const url = `https://www.xiaohongshu.com/explore/${noteId}`;
      await sdk.importNoteLinks(project.id, [url]);
      const raw = normalizeDetail(
        {
          detail: {
            noteId,
            title: "需求验证",
            desc: body,
            type: "normal",
            imageList: [],
            user: { nickname: "示例作者" },
          },
        },
        url,
      );
      await atomic(
        path.join(dataDir, "projects", project.id, "notes", noteId, "raw.json"),
        raw,
      );
    }
    sdk.updateProject(project.id, { selected: [noteIds[0]] });
    const { app } = await createApp(sdk, root);
    try {
      const queued = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/desktop-jobs`,
        headers: { host: "localhost", "content-type": "application/json" },
        payload: {},
      });
      assert.equal(queued.statusCode, 200);
      const fallbackJob = queued.json();
      assert.equal(fallbackJob.executor, "desktop");
      assert.equal(fallbackJob.status, "pending");
      assert.deepEqual(fallbackJob.selected, [noteIds[0]]);
      const wrongExecutor = await app.inject({
        method: "POST",
        url: `/api/jobs/${fallbackJob.id}/resume`,
        headers: { host: "localhost", "content-type": "application/json" },
        payload: {},
      });
      assert.equal(wrongExecutor.json().code, "EXECUTOR");
    } finally {
      await app.close();
      await sdk.close();
    }
    let client = connect(dataDir);
    try {
      const init = await client.rpc("initialize", {
        protocolVersion: "2025-11-25",
      });
      assert.deepEqual(init.capabilities.resources, {});
      const descriptor = (await client.rpc("tools/list")).tools.find(
        (tool: any) => tool.name === "open_note_picker",
      );
      const resource = await client.rpc("resources/read", {
        uri: descriptor._meta.ui.resourceUri,
      });
      assert.match(resource.contents[0].text, /开始构建/);
      const { pickerId } = await client.call("open_note_picker", {
        projectId: project.id,
      });
      const prepare = { pickerId, projectId: project.id, noteIds };
      const { jobId } = await client.call("picker_prepare", prepare);
      assert.equal((await client.call("picker_prepare", prepare)).jobId, jobId);
      const args = { jobId };
      assert.equal(
        (await client.call("distillation_status", args)).status,
        "pending",
      );
      await client.call("begin_distillation", args);

      async function next() {
        const job = await client.call("next_distillation_step", args);
        assert.equal(job.status, "running", JSON.stringify(job));
        return job.steps[0];
      }
      async function answer(step: { id: string }, invalid = false) {
        const payload = { ...args, stepId: step.id };
        const request = await client.call("read_distillation_step", payload);
        const input = request.untrustedMaterial as string;
        let value;
        if (request.kind === "research") {
          const claims = JSON.parse(input.split("输入：").at(-1)!);
          value = {
            sources: [],
            assessments: claims.map((claim: any) => ({
              claimId: claim.id,
              matches: [],
              boundedSearchComplete: true,
              crediblePriorMatch: false,
              explicitSourceInaccessible: false,
              unresolvedHighSimilarity: false,
              creatorContributionType: "application",
              creatorContributionDescription: "把访谈用于需求验证。",
              creatorContributionScore: 0.8,
            })),
          };
        } else if (input.includes("生成 Core Thesis")) {
          const claims = JSON.parse(input.split("输入：").at(-1)!);
          const statement = {
            title: "验证需求",
            statement: body,
            scope: ["早期"],
            conditions: [],
            exceptions: [],
            claimIds: [claims[0].id],
            conflicts: [],
          };
          value = {
            description: "访谈 Context",
            theses: [{ ...statement, id: "thesis-1" }],
            axioms: [{ ...statement, id: "axiom-1" }],
            boundaries: [],
          };
        } else {
          const noteId = noteIds.find((id) => input.includes(id))!;
          value = {
            cleanText: "",
            corrections: [],
            issues: [],
            style: [],
            methods: Array.from({ length: 6 }, (_, i) => ({
              id: noteId + "-m" + i,
              title: "验证需求 " + i,
              problem: "需求不明",
              conditions: [],
              questions: [],
              steps: ["访谈"],
              actions: [],
              exceptions: [],
              level: "explicit",
              evidence: [{ noteId, segmentId: "body", quote: "先访谈客户" }],
            })),
          };
        }
        if (invalid) {
          const rejected = await client.rpc("tools/call", {
            name: "submit_distillation_step",
            arguments: { ...payload, value: {} },
          });
          assert.equal(rejected.isError, true);
        }
        return client.call("submit_distillation_step", { ...payload, value });
      }

      const first = await next();
      await answer(first, true);
      const interrupted = await next();
      assert.notEqual(first.id, interrupted.id);
      await client.call("read_distillation_step", { ...args, stepId: interrupted.id });
      const budgetStore = new Store(dataDir);
      const durableBudget = new JobInputBudget(budgetStore, jobId);
      const beforeRestart = durableBudget.used();
      assert.ok(beforeRestart > 0);
      budgetStore.close();
      await client.stop();
      client = connect(dataDir);

      const paused = await client.call("distillation_status", args);
      assert.equal(paused.status, "paused");
      assert.equal(paused.checkpoints, 1);
      await client.call("begin_distillation", args);
      assert.equal((await next()).id, interrupted.id);
      await answer(interrupted);
      for (let i = 0; i < 3; i++) await answer(await next());
      const nextResearch = await next();
      assert.equal(nextResearch.kind, "research");
      const pausedDuringResearch = await client.call(
        "pause_distillation",
        args,
      );
      assert.equal(pausedDuringResearch.status, "paused");
      assert.equal(pausedDuringResearch.checkpoints, 5);
      await client.stop();
      client = connect(dataDir);
      await client.call("begin_distillation", args);
      assert.equal((await next()).id, nextResearch.id);
      for (let i = 0; i < 3; i++) await answer(await next());
      const complete = await client.call("next_distillation_step", args);
      assert.equal(complete.status, "complete", JSON.stringify(complete));
      assert.equal(complete.processed, 4);
      assert.equal(complete.checkpoints, 8);
      assert.equal(complete.context.processedClaims, 24);
      assert.ok(complete.context.tokenUsed > beforeRestart);
      assert.equal(complete.context.skillName, complete.context.contextId);
      assert.match(await readFile(path.join(root, "codex-home", "skills", complete.context.skillName, "SKILL.md"), "utf8"), /cluefolio-desktop\.build_context_packet/);
      const context = complete.context;
      assert.equal(
        (
          await verifyContextDirectory(
            path.join(dataDir, "contexts", context.contextId, context.version),
          )
        ).valid,
        true,
      );
      const packet = await new ContextRuntime(dataDir).buildContextPacket(
        context.contextId,
        "如何验证需求",
      );
      assert.ok(packet.evidence.length > 0);
      assert.ok(packet.answerProtocol.some((rule: string) => rule.includes("当前一手来源")));
      const previousHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = path.join(root, "codex-home");
      const partialSdk = new Distiller(cfg);
      try {
        const partial = partialSdk.prepareDesktopJob(project.id, [noteIds[0], noteIds[1]]);
        partial.noteStates[noteIds[0]].extract = "complete";
        partialSdk.store.put("job", partial);
        const draft = await partialSdk.finishPartialJob(partial.id);
        assert.equal(draft.context?.status, "draft");
        assert.equal(draft.status, "paused");
        assert.equal(draft.context?.skillName, draft.context?.contextId);
        assert.match(await readFile(path.join(root, "codex-home", "skills", draft.context!.contextId, "SKILL.md"), "utf8"), /草稿/);
      } finally { await partialSdk.close(); if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; }
      await rm(path.join(dataDir, "projects", project.id, "notes", noteIds[0], "analysis.json"), { force: true });
      const laterPicker = await client.call("open_note_picker", { projectId: project.id });
      const limited = await client.call("picker_prepare", { pickerId: laterPicker.pickerId, projectId: project.id, noteIds: [noteIds[0]] });
      const limitStore = new Store(dataDir);
      new JobInputBudget(limitStore, limited.jobId).charge(999_999);
      limitStore.close();
      await client.stop();
      client = connect(dataDir);
      await client.call("begin_distillation", { jobId: limited.jobId });
      const nextLimited = await client.call("next_distillation_step", { jobId: limited.jobId });
      const blocked = await client.rpc("tools/call", {
        name: "read_distillation_step",
        arguments: { jobId: limited.jobId, stepId: nextLimited.steps[0].id },
      });
      assert.equal(blocked.isError, true);
      assert.match(JSON.stringify(blocked), /累计模型输入/);
      const stopped = await client.call("next_distillation_step", { jobId: limited.jobId });
      assert.equal(stopped.status, "paused");
    } finally {
      await client.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
