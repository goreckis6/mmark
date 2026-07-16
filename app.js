/**
 * Hostinger entry file — always listen on process.env.PORT
 */
import { createApp } from "./Panel/publish-server.mjs";

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, function () {
  console.log("Content System listening on port " + PORT);
});

export default app;
