import path from "node:path";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";

const files = [
  ".gitignore",
  "LICENSE",
  "README.md",
  "PRODUCT.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "启动Cluefolio.command",
  ".github/workflows/ci.yml",
  "docs/validation.md",
  "docs/release-notes-v0.1.0.md",
  "docs/release-readiness.md",
];
const directories = [
  "apps",
  "packages/sdk",
  "packages/opencli-plugin",
  "scripts",
  "tests",
];
const sourceTypes = /\.(?:ts|tsx|js|mjs|json|html|css|swift|md|ya?ml)$/i;
const forbidden = [
  /(?:\/Users\/|\/home\/)[^\s"'<>\/]+\//,
  /\bxsec_token\s*=\s*[A-Za-z0-9_-]{16,}/,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
async function collect(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "dist", "data"].includes(entry.name)
    )
      continue;
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(name);
    else if (entry.isFile() && sourceTypes.test(entry.name)) files.push(name);
  }
}
for (const directory of directories) await collect(directory);
const manifest = await Promise.all(
  files.sort().map(async (file) => {
    const contents = await readFile(file);
    const text = contents.toString("utf8");
    if (forbidden.some((rule) => rule.test(text)))
      throw new Error(`发布文件含疑似私有路径或凭据：${file}`);
    return { file, contents, mode: (await stat(file)).mode & 0o777 };
  }),
);
const destination = path.resolve(process.argv[2] ?? "dist/shizhi-source");
await mkdir(path.dirname(destination), { recursive: true });
await mkdir(destination);
for (const { file, contents, mode } of manifest) {
  const output = path.join(destination, file);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, contents, { flag: "wx" });
  await chmod(output, mode);
}
console.log(`已准备 ${manifest.length} 个源码文件：${destination}`);
