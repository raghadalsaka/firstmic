import type { FastifyReply, FastifyRequest } from "fastify";
import { db, type SessionRow, type StudioRow, type UserRow } from "./db.js";
import { requireUser } from "./auth.js";

export type StudioRole = "owner" | "editor";

/** The caller's role in a studio, or null if they're not a member. */
export function studioRole(studioId: string, userId: string): StudioRole | null {
  const row = db
    .prepare("SELECT role FROM studio_members WHERE studio_id = ? AND user_id = ?")
    .get(studioId, userId) as { role: StudioRole } | undefined;
  return row?.role ?? null;
}

export function studioForMember(studioId: string, userId: string): (StudioRow & { role: StudioRole }) | null {
  const row = db
    .prepare(
      `SELECT s.*, m.role FROM studios s
       JOIN studio_members m ON m.studio_id = s.id AND m.user_id = ?
       WHERE s.id = ?`
    )
    .get(userId, studioId) as (StudioRow & { role: StudioRole }) | undefined;
  return row ?? null;
}

export function sessionForMember(sessionId: string, userId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT s.* FROM sessions s
       JOIN studio_members m ON m.studio_id = s.studio_id AND m.user_id = ?
       WHERE s.id = ?`
    )
    .get(userId, sessionId) as SessionRow | undefined;
  return row ?? null;
}

type ClassMember = { user: UserRow; studio: StudioRow & { role: StudioRole } };

/** Signed-in teacher who is a member of the class named by :classId; replies 401/404 otherwise. */
export function requireClassMember(req: FastifyRequest, reply: FastifyReply): ClassMember | null {
  const user = requireUser(req, reply);
  if (!user) {
    return null;
  }
  const { classId } = req.params as { classId: string };
  const studio = studioForMember(classId, user.id);
  if (!studio) {
    reply.code(404).send({ error: "Class not found" });
    return null;
  }
  return { user, studio };
}
