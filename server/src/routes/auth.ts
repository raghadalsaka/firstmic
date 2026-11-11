import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, type UserRow } from "../lib/db.js";
import { verifyGoogleAccessToken, type GoogleProfile } from "../lib/google.js";
import { newId } from "../lib/ids.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  createAuthToken,
  clearSessionCookie,
  deleteAuthToken,
  setSessionCookie,
  userFromRequest,
} from "../lib/auth.js";

const googleSignInSchema = z.object({ accessToken: z.string().min(10).max(4096) });

const GOOGLE_REFUSALS: Record<string, { status: number; error: string }> = {
  "not-configured": { status: 503, error: "Google sign-in isn't set up on this server yet" },
  "invalid-token": { status: 401, error: "Google sign-in didn't finish. Try again." },
  "wrong-client": { status: 401, error: "That Google sign-in was for a different app. Try again." },
  "unverified-email": { status: 403, error: "Verify your Google account's email address first" },
  unreachable: { status: 502, error: "Couldn't reach Google. Try again in a moment." },
};

function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, name: user.name };
}

const rateLimited = createRateLimiter(10);

/** Finds the teacher by Google account, links an existing account with the same email, or creates one. */
const upsertGoogleUser = db.transaction((profile: GoogleProfile): UserRow => {
  const bySub = db.prepare("SELECT * FROM users WHERE google_sub = ?").get(profile.sub) as UserRow | undefined;
  if (bySub) {
    db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(profile.name, profile.email, bySub.id);
    return { ...bySub, name: profile.name, email: profile.email };
  }
  const byEmail = db.prepare("SELECT * FROM users WHERE email = ?").get(profile.email) as UserRow | undefined;
  if (byEmail) {
    db.prepare("UPDATE users SET google_sub = ?, name = ? WHERE id = ?").run(profile.sub, profile.name, byEmail.id);
    return { ...byEmail, name: profile.name };
  }
  // password_hash is a NOT NULL column left from password sign-in, which no longer exists.
  const user: UserRow = { id: newId(), email: profile.email, name: profile.name, password_hash: "", created_at: Date.now() };
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at, google_sub) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(user.id, user.email, user.name, user.password_hash, user.created_at, profile.sub);
  return user;
});

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post("/api/auth/google", async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const parsed = googleSignInSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Google sign-in didn't finish. Try again." });
    }
    const check = await verifyGoogleAccessToken(parsed.data.accessToken);
    if (!check.ok) {
      req.log.warn({ ip: req.ip, reason: check.reason }, "google sign-in refused");
      const refusal = GOOGLE_REFUSALS[check.reason];
      return reply.code(refusal.status).send({ error: refusal.error });
    }
    const user = upsertGoogleUser(check.profile);
    setSessionCookie(reply, createAuthToken(user.id));
    req.log.info({ userId: user.id }, "teacher signed in with google");
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    deleteAuthToken(req);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const user = userFromRequest(req);
    return { user: user ? publicUser(user) : null };
  });
}
