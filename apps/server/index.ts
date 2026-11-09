import { createApp } from "./app.ts";
const { app } = await createApp();
const port = Number(process.env.PORT || 4317);
await app.listen({ host: "127.0.0.1", port });
console.log(`Cluefolio 已启动：http://127.0.0.1:${port}`);
