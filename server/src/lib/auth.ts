import type { FastifyReply, FastifyRequest } from "fastify";
import { db, type ParticipantRow, type SessionRow, type UserRow } from "./db.js";
import { newToken } from "./ids.js";

const SESSION_COOKIE = "firstmic_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function createAuthToken(userId: string): string {
  const token = newToken();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Browser sessions use the cookie; CLI/agents send the same token as a bearer. */
function sessionToken(req: FastifyRequest): string | null {
  return req.cookies?.[SESSION_COOKIE] ?? bearerToken(req);
}

export function userFromRequest(req: FastifyRequest): UserRow | null {
  const token = sessionToken(req);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token = ? AND t.expires_at > ?`
    )
    .get(token, Date.now()) as UserRow | undefined;
  return row ?? null;
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): UserRow | null {
  const user = userFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: "Not authenticated" });
    return null;
  }
  return user;
}

export function deleteAuthToken(req: FastifyRequest): void {
  const token = sessionToken(req);
  if (token) db.prepare("DELETE FROM auth_tokens WHERE token = ?").run(token);
}

/** Resolve a participant from a bearer token (guests + hosts inside a room). */
export function participantFromRequest(req: FastifyRequest): ParticipantRow | null {
  const token = bearerToken(req);
  if (!token) return null;
  return participantFromToken(token);
}

export function participantFromToken(token: string): ParticipantRow | null {
  const row = db
    .prepare("SELECT * FROM participants WHERE token = ?")
    .get(token) as ParticipantRow | undefined;
  return row ?? null;
}

export function requireParticipant(
  req: FastifyRequest,
  reply: FastifyReply
): ParticipantRow | null {
  const participant = participantFromRequest(req);
  if (!participant) {
    reply.code(401).send({ error: "Invalid participant token" });
    return null;
  }
  return participant;
}


/** A participant whose session is a solo episode or a group, by their bearer token; replies 401 otherwise. */
export function requireParticipantSession(
  req: FastifyRequest,
  reply: FastifyReply,
  kind: "solo" | "group"
): { participant: ParticipantRow; session: SessionRow } | null {
  const participant = requireParticipant(req, reply);
  if (!participant) {
    return null;
  }
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND kind = ?")
    .get(participant.session_id, kind) as SessionRow | undefined;
  if (!session) {
    reply.code(401).send({ error: "Invalid participant token" });
    return null;
  }
  return { participant, session };
}
