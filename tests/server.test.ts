import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../apps/server/app.ts";
import { Distiller, config } from "../packages/sdk/src/index.ts";
test("HTTP limits, origin checks, project persistence and selection validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-api-"));
  const sdk = new Distiller(config(root));
  const { app } = await createApp(sdk, root);
  const headers = {
    host: "127.0.0.1:4317",
    "content-type": "application/json",
  };
  let r = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers,
    payload: { name: "测试" },
  });
  assert.equal(r.statusCode, 200);
  const p = r.json();
  assert.equal(p.limit, 10);
  r = await app.inject({
    method: "PATCH",
    url: "/api/projects/" + p.id,
    headers,
    payload: { limit: 0 },
  });
  assert.equal(r.statusCode, 400);
  r = await app.inject({
    method: "POST",
    url: "/api/projects/" + p.id + "/jobs",
    headers,
    payload: {},
  });
  assert.equal(r.statusCode, 400);
  r = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { host: "evil.test" },
  });
  assert.equal(r.statusCode, 403);
  r = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { ...headers, origin: "https://evil.test" },
    payload: { name: "x" },
  });
  assert.equal(r.statusCode, 403);
  await app.close();
  sdk.store.close();
});
