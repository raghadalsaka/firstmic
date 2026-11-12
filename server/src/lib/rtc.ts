import type { FastifyBaseLogger } from "fastify";

const DEFAULT_ICE_SERVERS: unknown = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

/**
 * ICE servers for live calls: public STUN by default. Set ICE_SERVERS to add TURN for networks STUN can't cross, e.g.
 * ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
 */
export function iceServers(log: FastifyBaseLogger): unknown {
  if (!process.env.ICE_SERVERS) {
    return DEFAULT_ICE_SERVERS;
  }
  try {
    return JSON.parse(process.env.ICE_SERVERS);
  } catch {
    log.error("ICE_SERVERS is not valid JSON; using STUN defaults");
    return DEFAULT_ICE_SERVERS;
  }
}
