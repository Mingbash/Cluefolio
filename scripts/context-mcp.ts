import { config } from "../packages/sdk/src/index.ts";
import { ContextRuntime, serveContextMcp } from "../packages/sdk/src/context/index.ts";

const runtime = new ContextRuntime(config().dataDir);
await serveContextMcp(runtime);
