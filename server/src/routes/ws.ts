import type { FastifyInstance } from "fastify";
import type { ParticipantRow } from "../lib/db.js";
import { participantFromToken } from "../lib/auth.js";
import { addClient, handleClientMessage, removeClient } from "../lib/rooms.js";

export type WsRouteOptions = {
  /** Whether this participant may connect; anyone else is closed with 4401. */
  accepts?: (participant: ParticipantRow) => boolean;
  /** Message types participants may send; all of them when unset. */
  allowedMessages?: ReadonlySet<string>;
  /** Runs after a participant joins or leaves their session's room. */
  onPresence?: (sessionId: string) => void;
};

export function registerWsRoutes(app: FastifyInstance, options: WsRouteOptions = {}): void {
  app.get("/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const token = url.searchParams.get("token");
    const participant = token ? participantFromToken(token) : null;
    if (!participant || (options.accepts && !options.accepts(participant))) {
      socket.close(4401, "invalid token");
      return;
    }

    const client = addClient(participant, socket, options.allowedMessages ?? null);
    options.onPresence?.(participant.session_id);
    socket.on("message", (data: Buffer | string) => {
      handleClientMessage(client, data.toString());
    });
    const leave = (): void => {
      removeClient(client);
      options.onPresence?.(participant.session_id);
    };
    socket.on("close", leave);
    socket.on("error", leave);
  });
}
