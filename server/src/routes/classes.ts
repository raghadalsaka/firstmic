import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, type TopicRow } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { newId, newToken } from "../lib/ids.js";
import { requireClassMember, sessionForMember } from "../lib/access.js";
import { safeName } from "../lib/filenames.js";
import { groupMixPath, groupVoicePath, submissionAudioPath } from "../lib/storage.js";
import { streamFile } from "../lib/http-file.js";
import { deleteEpisodes } from "../jobs/submissions.js";
import { classStudents } from "../lib/roster.js";
import { broadcastGroup } from "../lib/groups.js";
import { FEEDBACK_MAX_CHARS, FEEDBACK_TARGETS, hasAudioSql, saveFeedback, type FeedbackKind } from "../lib/feedback.js";

const classNameSchema = z.object({ name: z.string().trim().min(1).max(120) });
const topicCreateSchema = z.object({ title: z.string().trim().min(1).max(200) });
const topicUpdateSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional(), active: z.boolean().optional() })
  .refine((value) => value.title !== undefined || value.active !== undefined);
const topicOrderSchema = z.object({ topicIds: z.array(z.string().min(1)).min(1).max(500) });
// Empty clears the comment.
const feedbackSchema = z.object({ text: z.string().trim().max(FEEDBACK_MAX_CHARS) });

function topicForMember(topicId: string, userId: string): TopicRow | null {
  const row = db
    .prepare(
      `SELECT t.* FROM topics t
       INNER JOIN studio_members m ON m.studio_id = t.studio_id AND m.user_id = ?
       WHERE t.id = ?`
    )
    .get(userId, topicId) as TopicRow | undefined;
  return row ?? null;
}

type TeacherSubmission = {
  id: string;
  episode_id: string;
  version: number;
  duration_ms: number | null;
  ready_at: number;
  student_name: string;
  topic_title: string | null;
  class_name: string;
};

function submissionForMember(submissionId: string, userId: string): TeacherSubmission | null {
  const row = db
    .prepare(
      `SELECT sub.id, sub.session_id AS episode_id, sub.version, sub.duration_ms, sub.ready_at,
         COALESCE(stu.name, p.name) AS student_name, t.title AS topic_title, st.name AS class_name
       FROM submissions sub
       INNER JOIN sessions s ON s.id = sub.session_id AND ${hasAudioSql("submission", "sub", "s")}
       INNER JOIN studios st ON st.id = s.studio_id
       INNER JOIN studio_members m ON m.studio_id = st.id AND m.user_id = ?
       INNER JOIN participants p ON p.session_id = s.id
       LEFT JOIN students stu ON stu.id = s.student_id
       LEFT JOIN topics t ON t.id = s.topic_id
       WHERE sub.id = ?`
    )
    .get(userId, submissionId) as TeacherSubmission | undefined;
  return row ?? null;
}

/** An earlier sent version of an episode; has_audio is 0 once its files were deleted on replacement. */
type PastVersion = {
  id: string;
  episode_id: string;
  version: number;
  duration_ms: number | null;
  sent_at: number;
  feedback: string | null;
  has_audio: number;
};

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(key(row));
    if (list) {
      list.push(row);
    } else {
      grouped.set(key(row), [row]);
    }
  }
  return grouped;
}

/** Every replaced version of the class's episodes of this kind, by episode, newest first. */
function pastVersions(studioId: string, kind: FeedbackKind): Map<string, PastVersion[]> {
  const { table, sentAt, sessionKind } = FEEDBACK_TARGETS[kind];
  const rows = db
    .prepare(
      `SELECT v.id, s.id AS episode_id, v.version, v.duration_ms, v.${sentAt} AS sent_at, v.feedback,
         ${hasAudioSql(kind, "v", "s")} AS has_audio
       FROM sessions s
       INNER JOIN ${table} v ON v.session_id = s.id AND v.status = 'replaced'
       WHERE s.studio_id = ? AND s.kind = ?
       ORDER BY v.version DESC`
    )
    .all(studioId, sessionKind) as PastVersion[];
  return groupBy(rows, (row) => row.episode_id);
}

type GroupRecordingRow = {
  id: string;
  episode_id: string;
  version: number;
  duration_ms: number | null;
  sent_at: number;
  feedback: string | null;
  topic_id: string | null;
  topic_title: string | null;
};

type GroupVoiceRow = { take_id: string; track_id: string; student_id: string | null; name: string };
type GroupVoice = Omit<GroupVoiceRow, "take_id">;

/**
 * Each group's sent take and its earlier versions, with the voice file of each member in the order they joined
 * (for every version that still has its files).
 */
function groupRecordings(
  studioId: string
): (GroupRecordingRow & { voices: GroupVoice[]; history: (PastVersion & { voices: GroupVoice[] })[] })[] {
  const takes = db
    .prepare(
      `SELECT gt.id, s.id AS episode_id, gt.version, gt.duration_ms, gt.sent_at, gt.feedback,
         t.id AS topic_id, t.title AS topic_title
       FROM sessions s
       INNER JOIN group_takes gt ON gt.id = s.current_take_id
       LEFT JOIN topics t ON t.id = s.topic_id
       WHERE s.studio_id = ? AND s.kind = 'group'
       ORDER BY gt.sent_at DESC`
    )
    .all(studioId) as GroupRecordingRow[];
  const voices = db
    .prepare(
      `SELECT gt.id AS take_id, tr.id AS track_id, p.student_id, COALESCE(stu.name, p.name) AS name
       FROM sessions s
       INNER JOIN group_takes gt ON gt.session_id = s.id AND ${hasAudioSql("groupTake", "gt", "s")}
       INNER JOIN tracks tr ON tr.recording_id = gt.recording_id
       INNER JOIN participants p ON p.id = tr.participant_id
       LEFT JOIN students stu ON stu.id = p.student_id
       WHERE s.studio_id = ? AND s.kind = 'group'
       ORDER BY p.created_at, p.id`
    )
    .all(studioId) as GroupVoiceRow[];
  const voicesByTake = groupBy(voices, (voice) => voice.take_id);
  const voicesOf = (takeId: string): GroupVoice[] =>
    (voicesByTake.get(takeId) ?? []).map(({ take_id: _takeId, ...voice }) => voice);
  const history = pastVersions(studioId, "groupTake");
  return takes.map((take) => ({
    ...take,
    voices: voicesOf(take.id),
    history: (history.get(take.episode_id) ?? []).map((past) => ({ ...past, voices: voicesOf(past.id) })),
  }));
}

type TeacherGroupTake = { id: string; version: number; topic_title: string | null; class_name: string; names: string };

/** A group's sent take that still has its files, if the teacher is a member of its class. */
function groupTakeForMember(takeId: string, userId: string): TeacherGroupTake | null {
  const row = db
    .prepare(
      `SELECT gt.id, gt.version, t.title AS topic_title, st.name AS class_name,
         (SELECT GROUP_CONCAT(name, ' ') FROM (
            SELECT COALESCE(stu.name, p.name) AS name FROM participants p
            LEFT JOIN students stu ON stu.id = p.student_id
            WHERE p.session_id = s.id ORDER BY p.created_at, p.id)) AS names
       FROM group_takes gt
       INNER JOIN sessions s ON s.id = gt.session_id AND ${hasAudioSql("groupTake", "gt", "s")}
       INNER JOIN studios st ON st.id = s.studio_id
       INNER JOIN studio_members m ON m.studio_id = st.id AND m.user_id = ?
       LEFT JOIN topics t ON t.id = s.topic_id
       WHERE gt.id = ?`
    )
    .get(userId, takeId) as TeacherGroupTake | undefined;
  return row ?? null;
}

export function registerClassRoutes(app: FastifyInstance): void {
  app.get("/api/teacher/classes", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const classes = db
      .prepare(
        `SELECT s.id, s.name, s.created_at,
           (SELECT COUNT(*) FROM topics WHERE studio_id = s.id) AS topic_count,
           (SELECT COUNT(*) FROM sessions WHERE studio_id = s.id
              AND (current_submission_id IS NOT NULL OR current_take_id IS NOT NULL)) AS submission_count
         FROM studios s INNER JOIN studio_members m ON m.studio_id = s.id AND m.user_id = ?
         ORDER BY s.created_at DESC`
      )
      .all(user.id);
    return { classes };
  });

  app.post("/api/teacher/classes", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const parsed = classNameSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Class name is required" });
    }
    const id = newId();
    const now = Date.now();
    db.transaction(() => {
      db.prepare("INSERT INTO studios (id, user_id, name, created_at, class_token) VALUES (?, ?, ?, ?, ?)").run(
        id,
        user.id,
        parsed.data.name,
        now,
        newToken()
      );
      db.prepare(
        "INSERT INTO studio_members (studio_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
      ).run(id, user.id, now);
    })();
    req.log.info({ classId: id, userId: user.id }, "class created");
    return { class: { id, name: parsed.data.name } };
  });

  app.get("/api/teacher/classes/:classId", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const { studio } = member;
    const topics = db
      .prepare("SELECT id, title, active, sort FROM topics WHERE studio_id = ? ORDER BY sort, created_at")
      .all(studio.id);
    const submissions = db
      .prepare(
        `SELECT sub.id, s.id AS episode_id, sub.version, sub.duration_ms, sub.ready_at, sub.feedback,
           COALESCE(stu.name, p.name) AS student_name, stu.id AS student_id, t.id AS topic_id, t.title AS topic_title
         FROM sessions s
         INNER JOIN submissions sub ON sub.id = s.current_submission_id
         INNER JOIN participants p ON p.session_id = s.id
         LEFT JOIN students stu ON stu.id = s.student_id
         LEFT JOIN topics t ON t.id = s.topic_id
         WHERE s.studio_id = ? AND s.kind = 'solo'
         ORDER BY sub.ready_at DESC`
      )
      .all(studio.id) as { episode_id: string }[];
    const submissionHistory = pastVersions(studio.id, "submission");
    const students = classStudents(studio.id).map(({ id, name, emoji, photo, pin }) => ({ id, name, emoji, photo, pin }));
    return {
      class: { id: studio.id, name: studio.name, classToken: studio.class_token },
      topics,
      students,
      submissions: submissions.map((submission) => ({
        ...submission,
        history: submissionHistory.get(submission.episode_id) ?? [],
      })),
      groupRecordings: groupRecordings(studio.id),
    };
  });

  app.patch("/api/teacher/classes/:classId", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const parsed = classNameSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Class name is required" });
    }
    db.prepare("UPDATE studios SET name = ? WHERE id = ?").run(parsed.data.name, member.studio.id);
    return { ok: true };
  });

  app.post("/api/teacher/classes/:classId/class-link", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const classToken = newToken();
    db.prepare("UPDATE studios SET class_token = ? WHERE id = ?").run(classToken, member.studio.id);
    req.log.info({ classId: member.studio.id, userId: member.user.id }, "class link rotated");
    return { classToken };
  });

  app.post("/api/teacher/classes/:classId/topics", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const parsed = topicCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Topic title is required" });
    }
    const now = Date.now();
    const id = newId();
    const sort = (
      db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM topics WHERE studio_id = ?").get(member.studio.id) as {
        next: number;
      }
    ).next;
    db.prepare(
      "INSERT INTO topics (id, studio_id, title, active, sort, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)"
    ).run(id, member.studio.id, parsed.data.title, sort, now, now);
    return { topic: { id, title: parsed.data.title, active: 1, sort } };
  });

  app.put("/api/teacher/classes/:classId/topic-order", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const parsed = topicOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid topic order" });
    }
    const studioId = member.studio.id;
    const existing = db.prepare("SELECT id FROM topics WHERE studio_id = ?").all(studioId) as { id: string }[];
    const existingIds = new Set(existing.map((row) => row.id));
    const requested = new Set(parsed.data.topicIds);
    if (requested.size !== existingIds.size || [...requested].some((id) => !existingIds.has(id))) {
      return reply.code(400).send({ error: "Topic order must list every topic of the class once" });
    }
    const now = Date.now();
    const update = db.prepare("UPDATE topics SET sort = ?, updated_at = ? WHERE id = ? AND studio_id = ?");
    db.transaction(() => {
      parsed.data.topicIds.forEach((id, index) => update.run(index, now, id, studioId));
    })();
    return { ok: true };
  });

  app.patch("/api/teacher/topics/:topicId", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const { topicId } = req.params as { topicId: string };
    const topic = topicForMember(topicId, user.id);
    if (!topic) {
      return reply.code(404).send({ error: "Topic not found" });
    }
    const parsed = topicUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid topic update" });
    }
    const title = parsed.data.title ?? topic.title;
    const active = parsed.data.active === undefined ? topic.active : Number(parsed.data.active);
    db.prepare("UPDATE topics SET title = ?, active = ?, updated_at = ? WHERE id = ?").run(
      title,
      active,
      Date.now(),
      topic.id
    );
    return { topic: { id: topic.id, title, active, sort: topic.sort } };
  });

  // Deletes the topic with every episode recorded for it, including their files.
  app.delete("/api/teacher/topics/:topicId", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const { topicId } = req.params as { topicId: string };
    const topic = topicForMember(topicId, user.id);
    if (!topic) {
      return reply.code(404).send({ error: "Topic not found" });
    }
    const { episodes, recordings } = deleteEpisodes("topic_id", topic.id, () => {
      db.prepare("DELETE FROM topics WHERE id = ?").run(topic.id);
    });
    req.log.info({ topicId: topic.id, userId: user.id, episodes, recordings }, "topic deleted");
    return { ok: true };
  });

  app.get("/api/teacher/submissions/:submissionId/audio", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const { submissionId } = req.params as { submissionId: string };
    const submission = submissionForMember(submissionId, user.id);
    if (!submission) {
      return reply.code(404).send({ error: "Submission not found" });
    }
    const download = (req.query as { download?: string }).download === "1";
    const fileName = [submission.class_name, submission.topic_title ?? "topic", submission.student_name]
      .map(safeName)
      .join("-");
    return streamFile(
      req,
      reply,
      submissionAudioPath(submission.id),
      `${fileName}-v${submission.version}.mp3`,
      "audio/mpeg",
      !download
    );
  });

  // The mix of both voices (?voice=<trackId> for one student's voice), to play inline or download.
  app.get("/api/teacher/group-takes/:takeId/audio", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const { takeId } = req.params as { takeId: string };
    const take = groupTakeForMember(takeId, user.id);
    if (!take) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    const { download, voice } = req.query as { download?: string; voice?: string };
    const baseName = [take.class_name, take.topic_title ?? "topic"].map(safeName).join("-");
    if (voice === undefined) {
      const fileName = `${baseName}-${safeName(take.names)}-mix-v${take.version}.mp3`;
      return streamFile(req, reply, groupMixPath(take.id), fileName, "audio/mpeg", download !== "1");
    }
    const track = db
      .prepare(
        `SELECT COALESCE(stu.name, p.name) AS name FROM tracks tr
         INNER JOIN group_takes gt ON gt.recording_id = tr.recording_id AND gt.id = ?
         INNER JOIN participants p ON p.id = tr.participant_id
         LEFT JOIN students stu ON stu.id = p.student_id
         WHERE tr.id = ?`
      )
      .get(take.id, voice) as { name: string } | undefined;
    if (!track) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    const fileName = `${baseName}-${safeName(track.name)}-v${take.version}.mp3`;
    return streamFile(req, reply, groupVoicePath(voice), fileName, "audio/mpeg", download !== "1");
  });

  // The teacher's comment on the current version of a solo recording or a group podcast; an empty text clears it.
  for (const [kind, prefix] of [
    ["submission", "/api/teacher/submissions/:versionId"],
    ["groupTake", "/api/teacher/group-takes/:versionId"],
  ] as const) {
    app.put(`${prefix}/feedback`, async (req, reply) => {
      const user = requireUser(req, reply);
      if (!user) {
        return;
      }
      const { versionId } = req.params as { versionId: string };
      const parsed = feedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: `Feedback can be up to ${FEEDBACK_MAX_CHARS} characters` });
      }
      const text = parsed.data.text === "" ? null : parsed.data.text;
      const result = saveFeedback(kind, versionId, user.id, text);
      if (!result.ok) {
        req.log.warn({ kind, versionId, userId: user.id, status: result.status }, "feedback refused");
        return reply.code(result.status).send({ error: result.error });
      }
      if (kind === "groupTake") {
        broadcastGroup(result.sessionId);
      }
      req.log.info({ kind, versionId, userId: user.id, chars: text?.length ?? 0 }, text === null ? "feedback cleared" : "feedback saved");
      return { feedback: text };
    });
  }

  app.delete("/api/teacher/episodes/:episodeId", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) {
      return;
    }
    const { episodeId } = req.params as { episodeId: string };
    const episode = sessionForMember(episodeId, user.id);
    if (!episode || (episode.kind !== "solo" && episode.kind !== "group")) {
      return reply.code(404).send({ error: "Episode not found" });
    }
    const { recordings } = deleteEpisodes("id", episode.id);
    req.log.info({ episodeId: episode.id, userId: user.id, recordings }, "episode deleted");
    return { ok: true };
  });
}
