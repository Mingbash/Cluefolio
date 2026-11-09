import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const file = path.resolve(
  process.env.XHS_DATA_DIR || "data",
  "seed-links.json",
);
export const seeds: string[] = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : [];
