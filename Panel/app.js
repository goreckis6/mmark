/**
 * Hostinger alternate entry — startup file: app.js
 */
try {
  await import("./publish-server.mjs");
} catch (err) {
  console.error("STARTUP FAILED:", err);
  throw err;
}
