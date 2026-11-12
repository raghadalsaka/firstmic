import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import { db, type GroupTakeRow, type ParticipantRow, type SessionRow, type TopicRow } from "../lib/db.js";
import { requireParticipantSession } from "../lib/auth.js";
import { MAX_EPISODE_SECONDS, PIN_ATTEMPTS_PER_MINUTE_PER_IP } from "../lib/config.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { broadcastGroup, getOrCreateGroup, getTake, groupSnapshot, joinGroup } from "../lib/groups.js";
import { iceServers } from "../lib/rtc.js";
import { groupMixPath } from "../lib/storage.js";
import { streamFile } from "../lib/http-file.js";
import { canControl, discardTake, sendTake, startTake, stopTake, voiceTrack } from "../jobs/group-takes.js";
import { requireClass, requireSignedInStudent } from "./student.js";
import { registerWsRoutes } from "./ws.js";

const DURATION_SLACK_SECONDS = 30;
// Students get the live call and nothing else from Tributary's room: no chat, and no host controls.
const ALLOWED_ROOM_MESSAGES: ReadonlySet<string> = new Set(["signal", "state", "ping"]);

const createGroupSchema = z.object({ topicId: z.string().min(1).max(64) });
const joinGroupSchema = z.object({ pin: z.string().max(20) });
const voiceSchema = z.object({
  mimeType: z.string().max(100).regex(/^audio\/(webm|mp4|ogg)(;.*)?$/),
  startOffsetMs: z.number().int().min(-60_000).max(MAX_EPISODE_SECONDS * 1000),
  durationMs: z.number().int().min(0).max((MAX_EPISODE_SECONDS + DURATION_SLACK_SECONDS) * 1000),
});
const joinLimited = createRateLimiter(PIN_ATTEMPTS_PER_MINUTE_PER_IP);

type GroupMemberAccess = { participant: ParticipantRow; session: SessionRow };

/**
 * The member (by group token) and the :takeId take of their group. With `control`, only the student who may
 * Stop, Send or Try Again gets through.
 */
function requireMemberTake(
  req: FastifyRequest,
  reply: FastifyReply,
  control: boolean
): { member: GroupMemberAccess; take: GroupTakeRow } | null {
  const member = requireParticipantSession(req, reply, "group");
  if (!member) {
    return null;
  }
  const { takeId } = req.params as { takeId: string };
  const take = getTake(takeId);
  if (!take || take.session_id !== member.session.id) {
    reply.code(404).send({ error: "Take not found" });
    return null;
  }
  if (control && !canControl(take, member.participant.id)) {
    reply.code(403).send({ error: "Your partner started this take, so they choose what happens next." });
    return null;
  }
  return { member, take };
}

export async function registerGroupRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  // Returns the student's group for the topic, creating it the first time.
  app.post("/api/class/:classToken/groups", async (req, reply) => {
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const student = requireSignedInStudent(req, reply, studio);
    if (!student) {
      return;
    }
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Choose a topic" });
    }
    const topic = db
      .prepare("SELECT * FROM topics WHERE id = ? AND studio_id = ? AND active = 1")
      .get(parsed.data.topicId, studio.id) as TopicRow | undefined;
    if (!topic) {
      return reply.code(404).send({ error: "Topic not found" });
    }
    const group = getOrCreateGroup(studio.id, student, topic);
    if (group.created) {
      req.log.info({ studioId: studio.id, groupId: group.groupId, studentId: student.id, topicId: topic.id }, "group created");
    }
    return { groupId: group.groupId, token: group.token };
  });

  app.post("/api/class/:classToken/groups/join", async (req, reply) => {
    if (joinLimited(req.ip)) {
      return reply.code(429).send({ error: "Too many tries. Wait a minute and try again." });
    }
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const student = requireSignedInStudent(req, reply, studio);
    if (!student) {
      return;
    }
    const parsed = joinGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Type your partner's group PIN" });
    }
    const result = joinGroup(studio.id, student, parsed.data.pin.trim());
    if (!result.ok) {
      req.log.warn({ studioId: studio.id, studentId: student.id, ip: req.ip, status: result.status }, "group join refused");
      return reply.code(result.status).send({ error: result.error });
    }
    req.log.info({ groupId: result.access.groupId, studentId: student.id, replacedGroupId: result.replacedGroupId }, "group joined");
    return result.access;
  });

  app.get("/api/group", async (req, reply) => {
    const member = requireParticipantSession(req, reply, "group");
    if (!member) {
      return;
    }
    return { selfId: member.participant.id, maxSeconds: MAX_EPISODE_SECONDS, group: groupSnapshot(member.session.id) };
  });

  app.post("/api/group/takes", async (req, reply) => {
    const member = requireParticipantSession(req, reply, "group");
    if (!member) {
      return;
    }
    const result = startTake(member.session.id, member.participant);
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    return { takeId: result.takeId };
  });

  app.post("/api/group/takes/:takeId/stop", async (req, reply) => {
    const found = requireMemberTake(req, reply, true);
    if (!found) {
      return;
    }
    if (!stopTake(found.take.id)) {
      return reply.code(409).send({ error: "This take isn't recording." });
    }
    return { ok: true };
  });

  app.post("/api/group/takes/:takeId/voice", async (req, reply) => {
    const found = requireMemberTake(req, reply, false);
    if (!found) {
      return;
    }
    const parsed = voiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid recording" });
    }
    const result = voiceTrack(found.take, found.member.participant, parsed.data);
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    return { trackId: result.trackId };
  });

  // Students only ever hear the mix, never their partner's separate voice: the take they're deciding on, the sent one,
  // or an earlier one the teacher commented on.
  app.get("/api/group/takes/:takeId/mix", async (req, reply) => {
    const found = requireMemberTake(req, reply, false);
    if (!found) {
      return;
    }
    const { member, take } = found;
    const isCurrent = take.status === "sent" && member.session.current_take_id === take.id;
    const hasFeedback = take.status === "replaced" && take.feedback !== null;
    if (take.status !== "listening" && !isCurrent && !hasFeedback) {
      return reply.code(404).send({ error: "This mix isn't available" });
    }
    return streamFile(req, reply, groupMixPath(take.id), "mix.mp3", "audio/mpeg", true);
  });

  app.post("/api/group/takes/:takeId/send", async (req, reply) => {
    const found = requireMemberTake(req, reply, true);
    if (!found) {
      return;
    }
    const sent = sendTake(found.take);
    if (!sent) {
      return reply.code(409).send({ error: "This take isn't ready to send." });
    }
    req.log.info(
      { groupId: found.member.session.id, takeId: found.take.id, version: sent.version, by: found.member.participant.id },
      "group take sent"
    );
    return sent;
  });

  app.post("/api/group/takes/:takeId/discard", async (req, reply) => {
    const found = requireMemberTake(req, reply, true);
    if (!found) {
      return;
    }
    if (!discardTake(found.take)) {
      return reply.code(409).send({ error: "This take can't be thrown away now." });
    }
    return { ok: true };
  });

  app.get("/api/rtc-config", async () => ({ iceServers: iceServers(app.log) }));

  // Live call signaling for a group's two members.
  registerWsRoutes(app, {
    accepts: (participant) =>
      db.prepare("SELECT 1 FROM sessions WHERE id = ? AND kind = 'group'").get(participant.session_id) !== undefined,
    allowedMessages: ALLOWED_ROOM_MESSAGES,
    onPresence: broadcastGroup,
  });
}
