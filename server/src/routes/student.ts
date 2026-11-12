import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import {
  db,
  type ParticipantRow,
  type SessionRow,
  type StudentRow,
  type StudioRow,
  type SubmissionRow,
  type TopicRow,
} from "../lib/db.js";
import { bearerToken, requireParticipantSession } from "../lib/auth.js";
import { newId, newToken } from "../lib/ids.js";
import {
  MAX_EPISODE_SECONDS,
  PIN_ATTEMPTS_PER_MINUTE_PER_IP,
  PIN_LOCK_MINUTES,
  PIN_MAX_ATTEMPTS,
} from "../lib/config.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { pinMatches } from "../lib/roster.js";
import { classStudents } from "../lib/roster.js";
import { submissionAudioPath, trackChunksDir } from "../lib/storage.js";
import { streamFile } from "../lib/http-file.js";
import { pastFeedback } from "../lib/feedback.js";
import { removeTrackMedia } from "../jobs/submissions.js";

const DURATION_SLACK_SECONDS = 30;

const signInSchema = z.object({ studentId: z.string().min(1).max(64), pin: z.string().max(20) });
const episodeSchema = z.object({ topicId: z.string().min(1).max(64) });
const signInLimited = createRateLimiter(PIN_ATTEMPTS_PER_MINUTE_PER_IP);

type PublicStudent = Pick<StudentRow, "id" | "name" | "emoji" | "photo">;

function publicStudent(student: StudentRow): PublicStudent {
  return { id: student.id, name: student.name, emoji: student.emoji, photo: student.photo };
}

/** The student signed in on this device with their PIN (Authorization: Bearer <login token>), within this class. */
export function requireSignedInStudent(req: FastifyRequest, reply: FastifyReply, studio: StudioRow): StudentRow | null {
  const student = db
    .prepare(
      `SELECT s.* FROM student_logins l
       INNER JOIN students s ON s.id = l.student_id
       WHERE l.token = ? AND s.studio_id = ?`
    )
    .get(bearerToken(req) ?? "", studio.id) as StudentRow | undefined;
  if (!student) {
    reply.code(401).send({ error: "Pick your name and type your PIN again" });
    return null;
  }
  return student;
}

type PinCheck = { ok: true } | { ok: false; status: number; error: string };

/** Counts wrong PINs per student and locks them out for a while, so a 6-digit PIN can't be guessed by trying them all. */
function checkPin(student: StudentRow, pin: string): PinCheck {
  const now = Date.now();
  if (student.locked_until !== null && student.locked_until > now) {
    const minutes = Math.ceil((student.locked_until - now) / 60_000);
    return { ok: false, status: 429, error: `Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or ask your teacher.` };
  }
  if (pinMatches(pin, student.pin)) {
    db.prepare("UPDATE students SET failed_pin_attempts = 0, locked_until = NULL WHERE id = ?").run(student.id);
    return { ok: true };
  }
  const failures = student.failed_pin_attempts + 1;
  if (failures >= PIN_MAX_ATTEMPTS) {
    db.prepare("UPDATE students SET failed_pin_attempts = 0, locked_until = ? WHERE id = ?").run(
      now + PIN_LOCK_MINUTES * 60_000,
      student.id
    );
    return { ok: false, status: 429, error: `Too many wrong PINs. Try again in ${PIN_LOCK_MINUTES} minutes, or ask your teacher.` };
  }
  db.prepare("UPDATE students SET failed_pin_attempts = ? WHERE id = ?").run(failures, student.id);
  return { ok: false, status: 401, error: "That PIN isn't right. Try again." };
}

const submissionSchema = z.object({
  mimeType: z.string().max(100).regex(/^audio\/(webm|mp4|ogg)(;.*)?$/),
  durationMs: z.number().int().min(0).max((MAX_EPISODE_SECONDS + DURATION_SLACK_SECONDS) * 1000),
});

/** The class named by the :classToken link; replies 404 for an unknown or replaced link. */
export function requireClass(req: FastifyRequest, reply: FastifyReply): StudioRow | null {
  const { classToken } = req.params as { classToken: string };
  const studio = db.prepare("SELECT * FROM studios WHERE class_token = ?").get(classToken) as StudioRow | undefined;
  if (!studio) {
    reply.code(404).send({ error: "Class not found" });
    return null;
  }
  return studio;
}

type EpisodeStudent = { participant: ParticipantRow; session: SessionRow };

function requireEpisodeStudent(req: FastifyRequest, reply: FastifyReply): EpisodeStudent | null {
  return requireParticipantSession(req, reply, "solo");
}

/**
 * Sending a new take abandons any earlier take of the same episode that never finished. Its track is failed too,
 * so the chunk route refuses late uploads from the old device and the pipeline never processes it.
 */
const createSubmission = db.transaction(
  (student: EpisodeStudent, mimeType: string, durationMs: number): { submissionId: string; trackId: string; abandonedTrackIds: string[] } => {
    const now = Date.now();
    const abandoned = db
      .prepare(
        `UPDATE submissions SET status = 'failed', error = 'Superseded by a newer take'
         WHERE session_id = ? AND status = 'sending' RETURNING track_id`
      )
      .all(student.session.id) as { track_id: string }[];
    const failTrack = db.prepare(
      "UPDATE tracks SET status = 'failed', error = 'Superseded by a newer take' WHERE id = ? AND status IN ('recording', 'uploading')"
    );
    for (const row of abandoned) {
      failTrack.run(row.track_id);
    }

    const recordingId = newId();
    db.prepare(
      "INSERT INTO recordings (id, session_id, started_at_ms, stopped_at_ms, status) VALUES (?, ?, ?, ?, 'uploading')"
    ).run(recordingId, student.session.id, now, now);

    const trackId = newId();
    db.prepare(
      `INSERT INTO tracks (id, recording_id, session_id, participant_id, type, mime_type, status,
         start_offset_ms, duration_ms, created_at)
       VALUES (?, ?, ?, ?, 'camera', ?, 'recording', 0, ?, ?)`
    ).run(trackId, recordingId, student.session.id, student.participant.id, mimeType, durationMs, now);

    const submissionId = newId();
    db.prepare(
      "INSERT INTO submissions (id, session_id, recording_id, track_id, status, created_at) VALUES (?, ?, ?, ?, 'sending', ?)"
    ).run(submissionId, student.session.id, recordingId, trackId, now);
    return { submissionId, trackId, abandonedTrackIds: abandoned.map((row) => row.track_id) };
  }
);

const getOrCreateEpisode = db.transaction(
  (studioId: string, student: StudentRow, topic: TopicRow): { episodeId: string; token: string; created: boolean } => {
    const existing = db
      .prepare(
        `SELECT s.id AS episodeId, p.token FROM sessions s
         INNER JOIN participants p ON p.session_id = s.id
         WHERE s.student_id = ? AND s.topic_id = ?`
      )
      .get(student.id, topic.id) as { episodeId: string; token: string } | undefined;
    if (existing) {
      return { ...existing, created: false };
    }
    const now = Date.now();
    const episodeId = newId();
    const token = newToken();
    // Solo episodes never host a live room, so they start ended and their invite link never works.
    db.prepare(
      `INSERT INTO sessions (id, studio_id, title, status, invite_token, created_at, ended_at, kind, topic_id, student_id)
       VALUES (?, ?, ?, 'ended', ?, ?, ?, 'solo', ?, ?)`
    ).run(episodeId, studioId, `${student.name} - ${topic.title}`, newToken(), now, now, topic.id, student.id);
    db.prepare(
      "INSERT INTO participants (id, session_id, student_id, name, role, token, created_at) VALUES (?, ?, ?, ?, 'guest', ?, ?)"
    ).run(newId(), episodeId, student.id, student.name, token, now);
    return { episodeId, token, created: true };
  }
);

export function registerStudentRoutes(app: FastifyInstance): void {
  // Public on purpose: the home page lists every class so students tap theirs instead of needing a shared link.
  app.get("/api/classes", async () => {
    const classes = db
      .prepare("SELECT name, class_token AS classToken FROM studios WHERE class_token IS NOT NULL ORDER BY name COLLATE NOCASE")
      .all() as { name: string; classToken: string }[];
    return { classes };
  });

  app.get("/api/class/:classToken", async (req, reply) => {
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const topics = db
      .prepare("SELECT id, title FROM topics WHERE studio_id = ? AND active = 1 ORDER BY sort, created_at")
      .all(studio.id) as Pick<TopicRow, "id" | "title">[];
    const students = classStudents(studio.id).map(publicStudent);
    return { class: { name: studio.name }, topics, students, maxSeconds: MAX_EPISODE_SECONDS };
  });

  app.post("/api/class/:classToken/sign-in", async (req, reply) => {
    if (signInLimited(req.ip)) {
      return reply.code(429).send({ error: "Too many tries. Wait a minute and try again." });
    }
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const parsed = signInSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Pick your name and type your 6-digit PIN" });
    }
    const student = db
      .prepare("SELECT * FROM students WHERE id = ? AND studio_id = ?")
      .get(parsed.data.studentId, studio.id) as StudentRow | undefined;
    if (!student) {
      return reply.code(404).send({ error: "Pick your name again" });
    }
    const check = checkPin(student, parsed.data.pin.trim());
    if (!check.ok) {
      req.log.warn({ studentId: student.id, ip: req.ip, status: check.status }, "student PIN refused");
      return reply.code(check.status).send({ error: check.error });
    }
    const token = newToken();
    db.prepare("INSERT INTO student_logins (token, student_id, created_at) VALUES (?, ?, ?)").run(token, student.id, Date.now());
    req.log.info({ studentId: student.id }, "student signed in");
    return { studentToken: token, student: publicStudent(student) };
  });

  app.get("/api/class/:classToken/me", async (req, reply) => {
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const student = requireSignedInStudent(req, reply, studio);
    if (!student) {
      return;
    }
    return { student: publicStudent(student) };
  });

  // Returns the student's one episode for the topic, creating it the first time; any of their devices gets the same one.
  app.post("/api/class/:classToken/episodes", async (req, reply) => {
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const student = requireSignedInStudent(req, reply, studio);
    if (!student) {
      return;
    }
    const parsed = episodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Choose a topic" });
    }
    const topic = db
      .prepare("SELECT * FROM topics WHERE id = ? AND studio_id = ? AND active = 1")
      .get(parsed.data.topicId, studio.id) as TopicRow | undefined;
    if (!topic) {
      return reply.code(404).send({ error: "Topic not found" });
    }
    const episode = getOrCreateEpisode(studio.id, student, topic);
    if (episode.created) {
      req.log.info({ studioId: studio.id, episodeId: episode.episodeId, studentId: student.id, topicId: topic.id }, "episode created");
    }
    return { episodeId: episode.episodeId, token: episode.token };
  });

  app.get("/api/student/episode", async (req, reply) => {
    const student = requireEpisodeStudent(req, reply);
    if (!student) {
      return;
    }
    const current = student.session.current_submission_id
      ? (db
          .prepare("SELECT id, version, duration_ms, ready_at, feedback FROM submissions WHERE id = ?")
          .get(student.session.current_submission_id) as Pick<
          SubmissionRow,
          "id" | "version" | "duration_ms" | "ready_at" | "feedback"
        >)
      : null;
    return {
      episode: {
        id: student.session.id,
        studentName: student.participant.name,
        current: current
          ? {
              id: current.id,
              version: current.version,
              durationMs: current.duration_ms,
              sentAt: current.ready_at,
              feedback: current.feedback,
            }
          : null,
        pastFeedback: pastFeedback("submission", student.session.id),
      },
    };
  });

  app.post("/api/student/submissions", async (req, reply) => {
    const student = requireEpisodeStudent(req, reply);
    if (!student) {
      return;
    }
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid recording" });
    }
    const { submissionId, trackId, abandonedTrackIds } = createSubmission(student, parsed.data.mimeType, parsed.data.durationMs);
    fs.mkdirSync(trackChunksDir(trackId), { recursive: true });
    for (const abandonedTrackId of abandonedTrackIds) {
      removeTrackMedia(abandonedTrackId);
    }
    req.log.info({ episodeId: student.session.id, submissionId }, "submission started");
    return { submissionId, trackId };
  });

  app.get("/api/student/submissions/:submissionId", async (req, reply) => {
    const student = requireEpisodeStudent(req, reply);
    if (!student) {
      return;
    }
    const { submissionId } = req.params as { submissionId: string };
    const submission = db
      .prepare("SELECT status, version FROM submissions WHERE id = ? AND session_id = ?")
      .get(submissionId, student.session.id) as Pick<SubmissionRow, "status" | "version"> | undefined;
    if (!submission) {
      return reply.code(404).send({ error: "Submission not found" });
    }
    return { status: submission.status, version: submission.version };
  });

  // An earlier version the teacher commented on, so the student can hear what the feedback is about.
  app.get("/api/student/submissions/:submissionId/audio", async (req, reply) => {
    const student = requireEpisodeStudent(req, reply);
    if (!student) {
      return;
    }
    const { submissionId } = req.params as { submissionId: string };
    const submission = db
      .prepare(
        "SELECT id, version FROM submissions WHERE id = ? AND session_id = ? AND status = 'replaced' AND feedback IS NOT NULL"
      )
      .get(submissionId, student.session.id) as Pick<SubmissionRow, "id" | "version"> | undefined;
    if (!submission) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    return streamFile(req, reply, submissionAudioPath(submission.id), `v${submission.version}.mp3`, "audio/mpeg", true);
  });
}
