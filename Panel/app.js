/**
 * Panel-local entry (if Hostinger root = Panel)
 */
import { createApp } from "./publish-server.mjs";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const app = createApp();

if (typeof globalThis.PhusionPassenger !== "undefined") {
  globalThis.PhusionPassenger.configure({ autoInstall: false });
  app.listen("passenger", function () {
    console.log("Content System via Passenger");
  });
} else {
  app.listen(PORT, HOST, function () {
    console.log("Content System → http://" + HOST + ":" + PORT);
  });
}

export default app;
