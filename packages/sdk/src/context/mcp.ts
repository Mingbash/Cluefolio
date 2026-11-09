import readline from "node:readline";
import { redact } from "../util.ts";
import { ContextRuntime } from "./runtime.ts";

const tools = [
  ["list_contexts", "列出本机可用的 Context", {}],
  ["get_overview", "读取 Context 的 Core Thesis、Public Axioms 和构建状态", { contextId: { type: "string" }, version: { type: "string" } }],
  ["search", "检索 Context 中的原始证据与来源定位", { contextId: { type: "string" }, query: { type: "string" }, version: { type: "string" }, limit: { type: "integer" } }],
  ["build_context_packet", "为一个问题构建受 token 限制的 Evidence Packet", { contextId: { type: "string" }, query: { type: "string" }, version: { type: "string" }, maxChars: { type: "integer" } }],
  ["trace_claim", "追踪 Claim 的证据、上游来源和博主贡献", { contextId: { type: "string" }, claimId: { type: "string" }, version: { type: "string" } }],
  ["read_evidence", "读取单个 EvidenceUnit 及图文页码或视频时间码", { contextId: { type: "string" }, evidenceId: { type: "string" }, version: { type: "string" } }],
] as const;

export function toolDefinitions() {
  return tools.map(([name, description, properties]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required: name === "list_contexts" ? [] : name === "get_overview" ? ["contextId"] : name === "search" || name === "build_context_packet" ? ["contextId", "query"] : name === "trace_claim" ? ["contextId", "claimId"] : ["contextId", "evidenceId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}

export async function callContextTool(runtime: ContextRuntime, name: string, args: any) {
  if (name === "list_contexts") return runtime.listContexts();
  if (name === "get_overview") return runtime.getOverview(args.contextId, args.version);
  if (name === "search") return runtime.search(args.contextId, args.query, { version: args.version, limit: args.limit });
  if (name === "build_context_packet") return runtime.buildContextPacket(args.contextId, args.query, { version: args.version, maxChars: args.maxChars });
  if (name === "trace_claim") return runtime.traceClaim(args.contextId, args.claimId, args.version);
  if (name === "read_evidence") return runtime.readEvidence(args.contextId, args.evidenceId, args.version);
  throw new Error(`未知工具：${name}`);
}

type Extension = {
  name: string;
  instructions: string;
  tools: { name: string }[];
  resources: { uri: string; name: string; mimeType: string; text: string }[];
  call(name: string, args: unknown): Promise<unknown>;
};

export async function serveContextMcp(runtime: ContextRuntime, input = process.stdin, output = process.stdout, extension?: Extension) {
  const lines = readline.createInterface({ input });
  const inFlight = new Set<Promise<void>>();
  const resourceList = extension?.resources ?? [];
  const extraNames = new Set(extension?.tools.map(tool => tool.name));
  const send = (value: unknown) => { output.write(JSON.stringify(value) + "\n"); };
  async function handle(request: any) {
    try {
      const params = request.params ?? {};
      let result: any;
      if (request.method === "initialize") {
        const offered = params.protocolVersion;
        result = {
          protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(offered) ? offered : "2024-11-05",
          capabilities: { tools: {}, ...(extension ? { resources: {} } : {}) },
          serverInfo: { name: extension?.name ?? "shizhi-context", version: "0.1.0" },
          ...(extension ? { instructions: extension.instructions } : {}),
        };
      } else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: [...toolDefinitions(), ...(extension?.tools ?? [])] };
      else if (request.method === "resources/list" && extension)
        result = { resources: resourceList.map(({ text, ...resource }) => resource) };
      else if (request.method === "resources/templates/list" && extension) result = { resourceTemplates: [] };
      else if (request.method === "resources/read" && extension) {
        const resource = resourceList.find(resource => resource.uri === params.uri);
        if (!resource) throw new Error("资源不存在");
        result = { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] };
      } else if (request.method === "tools/call") {
        try {
          const value = extraNames.has(params.name)
            ? await extension!.call(params.name, params.arguments ?? {})
            : await callContextTool(runtime, params.name, params.arguments ?? {});
          const object = value as Record<string, unknown> | null;
          result = object?.type === "image"
            ? { content: [object] }
            : { content: [{ type: "text", text: JSON.stringify(value) }], ...(!Array.isArray(value) && object ? { structuredContent: object } : {}) };
        } catch (error: any) {
          result = { isError: true, content: [{ type: "text", text: redact(error.message) }] };
        }
      } else throw Object.assign(new Error("Method not found"), { code: -32601 });
      send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error: any) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: error.code === -32601 ? -32601 : -32000, message: redact(error.message) } });
    }
  }
  for await (const line of lines) {
    let request: any;
    try { request = JSON.parse(line); } catch { continue; }
    if (request?.id === undefined) continue;
    const task = handle(request).finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
  await Promise.allSettled(inFlight);
}
