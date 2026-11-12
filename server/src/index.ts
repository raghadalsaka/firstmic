import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./lib/db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTrackRoutes } from "./routes/tracks.js";
import { registerStudentRoutes } from "./routes/student.js";
import { registerClassRoutes } from "./routes/classes.js";
import { registerRosterRoutes } from "./routes/roster.js";
import { resumeInterruptedTracks } from "./jobs/pipeline.js";
import { startSubmissionJobs } from "./jobs/submissions.js";
import { registerGroupRoutes } from "./routes/group.js";
import { startGroupJobs } from "./jobs/group-takes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4100);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    serializers: {
      // The live-call socket carries the group token in its URL; keep it out of the logs.
      req: (req: { method: string; url: string; ip: string }) => ({
        method: req.method,
        url: req.url.replace(/([?&]token=)[^&]+/, "$1[redacted]"),
        remoteAddress: req.ip,
      }),
    },
  },
  bodyLimit: 64 * 1024 * 1024, // MediaRecorder chunks can be several MB
});

// Raw media chunk bodies
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

await app.register(fastifyCookie);
await app.register(fastifyCors, {
  origin: true,
  credentials: true,
});

registerAuthRoutes(app);
registerTrackRoutes(app);
registerStudentRoutes(app);
registerClassRoutes(app);
registerRosterRoutes(app);
await registerGroupRoutes(app);
startSubmissionJobs();
startGroupJobs();
resumeInterruptedTracks();

app.get("/api/health", async () => ({ ok: true, name: "firstmic", now: Date.now() }));

// Serve the built web app in production
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  // wildcard:true serves files from disk per-request, so a web rebuild
  // (new hashed bundle names) doesn't require a server restart.
  await app.register(fastifyStatic, { root: webDist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`First Mic server listening on http://localhost:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// `docker compose` stops the container with SIGTERM, which Node ignores as PID 1 until Docker kills it 10 s later.
// Close the server (and the live-call sockets) and the database cleanly instead; interrupted jobs resume on startup.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`First Mic server stopping (${signal})`);
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
