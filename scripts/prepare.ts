import path from "node:path";
import { Distiller, config, json } from "../packages/sdk/src/index.ts";
import type { RawNote } from "../packages/sdk/src/types.ts";
const sdk = new Distiller(config()),
  pid = process.argv[2];
for (const n of sdk.store.project(pid).notes) {
  const dir = path.join(sdk.cfg.dataDir, "projects", pid, "notes", n.id);
  const raw = await json<RawNote>(path.join(dir, "raw.json"));
  if (!raw || raw.media.some((m) => !m.path)) continue;
  try {
    const segments = await sdk.cleaner.prepare(raw, dir);
    console.log(
      JSON.stringify({
        id: n.id,
        type: raw.note.type,
        segments: segments.length,
        audio: segments.filter((s) => s.kind === "audio").length,
      }),
    );
  } catch (e: any) {
    console.log(JSON.stringify({ id: n.id, error: e.message }));
  }
}
sdk.store.close();
