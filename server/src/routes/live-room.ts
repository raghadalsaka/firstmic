import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { livekitConfig, mintLivekitToken } from "../lib/livekit.js";
import { participantFromRequest } from "../lib/auth.js";
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

  // WebRTC ICE configuration. Defaults to public STUN; set ICE_SERVERS to add TURN
  // for production (guests behind symmetric NATs can't connect with STUN alone), e.g.
  // ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
  // When LIVEKIT_URL/API_KEY/API_SECRET are set, clients use the SFU instead of mesh.
  app.get("/api/rtc-config", async () => {
    let iceServers: unknown = [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    ];
    if (process.env.ICE_SERVERS) {
      try {
        iceServers = JSON.parse(process.env.ICE_SERVERS);
      } catch {
        app.log.error("ICE_SERVERS is not valid JSON; using STUN defaults");
      }
    }
    const livekit = livekitConfig();
    return {
      mode: livekit ? "livekit" : "mesh",
      livekitUrl: livekit?.url,
      iceServers,
    };
  });
}
