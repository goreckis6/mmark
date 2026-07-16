/**
 * Hostinger entry — startup file: app.js
 * Express app: panel + API + auth
 */
import { createApp } from "./Panel/publish-server.mjs";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";

const app = await createApp();

app.listen(PORT, HOST, function () {
  console.log("Content System → http://" + HOST + ":" + PORT);
  console.log("Express + JSON store + auth");
});

export default app;
