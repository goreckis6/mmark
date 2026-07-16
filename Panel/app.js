/**
 * Alternate entry if Hostinger root = Panel
 */
import { createApp } from "./publish-server.mjs";

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, function () {
  console.log("Content System listening on port " + PORT);
});

export default app;
