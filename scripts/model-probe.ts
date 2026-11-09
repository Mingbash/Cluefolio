import { config } from "../packages/sdk/src/index.ts";
import { CodexModel, obj } from "../packages/sdk/src/model.ts";
import path from "node:path";
console.log(
  await new CodexModel(config()).call(
    path.resolve("data/model-probe"),
    "probe",
    "验证结构化返回，不调用工具。返回 ready=true, message=结构化调用正常。",
    obj({ ready: { type: "boolean" }, message: { type: "string" } }),
  ),
);
