/**
 * Hostinger entry — startup file: app.js
 * Compatible with Passenger (listen on "passenger") and local npm start (PORT).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createApp } from "./Panel/publish-server.mjs";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const app = createApp();

function startServer() {
  if (typeof globalThis.PhusionPassenger !== "undefined") {
    globalThis.PhusionPassenger.configure({ autoInstall: false });
    app.listen("passenger", function () {
      console.log("Content System via Passenger");
    });
    return;
  }
  app.listen(PORT, HOST, function () {
    console.log("Content System → http://" + HOST + ":" + PORT);
  });
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isEntryFile = entry === path.resolve(fileURLToPath(import.meta.url));

if (isEntryFile || process.env.PASSENGER_APP_ENV) {
  startServer();
}

export default app;
