/**
 * Hostinger entry point — startup file: app.js (Express)
 */
import { createApp } from "./publish-server.mjs";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";

const app = await createApp();

app.listen(PORT, HOST, function () {
  console.log("Content System server → http://" + HOST + ":" + PORT);
  console.log("Panel + API + auth (JSON store, Express)");
  console.log("Bedrock: lazy-load @ " + (process.env.AWS_REGION || "eu-central-1"));
});

export default app;
