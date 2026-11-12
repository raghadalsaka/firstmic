import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { livekitConfig, mintLivekitToken } from "../lib/livekit.js";
import { participantFromRequest } from "../lib/auth.js";
import { iceServers } from "../lib/rtc.js";
import { registerStudioRoutes } from "./studios.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerTrackCreateRoute } from "./tracks.js";
import { registerMediaRoutes } from "./media.js";
import { registerWsRoutes } from "./ws.js";

/** Studios, live sessions, invites, signaling and mixing: the group-room surface, not mounted while only solo episodes exist. */
export async function registerLiveRoomRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  registerStudioRoutes(app);
  registerSessionRoutes(app);
  registerTrackCreateRoute(app);
  registerMediaRoutes(app);
  registerWsRoutes(app);

  // SFU access token for the joining participant (participant bearer auth).
  app.post("/api/livekit-token", async (req, reply) => {
    const participant = participantFromRequest(req);
    if (!participant) return reply.code(401).send({ error: "Invalid participant token" });
    if (!livekitConfig()) return reply.code(409).send({ error: "LiveKit is not configured" });
    const token = await mintLivekitToken(participant.session_id, participant.id, participant.name);
    return { token };
  });

  // When LIVEKIT_URL/API_KEY/API_SECRET are set, clients use the SFU instead of mesh.
  app.get("/api/rtc-config", async () => {
    const livekit = livekitConfig();
    return {
      mode: livekit ? "livekit" : "mesh",
      livekitUrl: livekit?.url,
      iceServers: iceServers(app.log),
    };
  });
}
