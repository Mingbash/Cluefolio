import { run } from "../packages/sdk/src/util.ts";
import { createSourceArchive } from "./release-archive.ts";
await run("npm", ["run", "build"], { timeout: 120000 });
console.log(await createSourceArchive("dist/xhs-skill-distiller.zip"));
const packed = JSON.parse(
  await run(
    "npm",
    [
      "pack",
      "--workspace",
      "packages/sdk",
      "--pack-destination",
      "dist",
      "--cache",
      "data/npm-cache",
      "--json",
    ],
    { timeout: 120000 },
  ),
);
console.log(
  packed.map(({ filename, size, integrity }: any) => ({
    filename,
    size,
    integrity,
  })),
);
