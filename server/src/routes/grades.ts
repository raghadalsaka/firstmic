import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../lib/db.js";
import { requireClassMember } from "../lib/access.js";
import { streamFile } from "../lib/http-file.js";
import { submissionAudioPath } from "../lib/storage.js";
import {
  classRecordings,
  gradeProblems,
  gradesUploadSchema,
  recordingsBySubmission,
  saveGrades,
  topRecordings,
  type RankedRecording,
} from "../lib/grades.js";
import { requireClass } from "./student.js";

const publishSchema = z.object({ published: z.boolean() });

/** What the public Top 3 page shows: no scores or teacher comment, and one submission id to play the recording by. */
function publicRecording(recording: RankedRecording) {
  return {
    rank: recording.rank,
    submissionId: recording.submissionIds[0],
    names: recording.names,
    topicTitle: recording.topicTitle,
    durationMs: recording.durationMs,
    highlights: recording.grade.highlights,
  };
}

export function registerGradeRoutes(app: FastifyInstance): void {
  app.get("/api/teacher/classes/:classId/grades", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const { studio } = member;
    return {
      class: {
        id: studio.id,
        name: studio.name,
        classToken: studio.class_token,
        top3PublishedAt: studio.top3_published_at ?? null,
      },
      recordings: classRecordings(studio.id),
    };
  });

  // Saves a whole upload, or one recording from the edit page; nothing is saved if any grade is wrong.
  app.put("/api/teacher/classes/:classId/grades", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const parsed = gradesUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: `Check the grades: ${issue?.path.join(".")} ${issue?.message}` });
    }
    const { user, studio } = member;
    const bySubmission = recordingsBySubmission(classRecordings(studio.id));
    const problems = gradeProblems(bySubmission, parsed.data.grades);
    if (problems.length > 0) {
      req.log.warn({ classId: studio.id, userId: user.id, problems }, "grades refused");
      return reply.code(400).send({ error: problems.join("\n") });
    }
    saveGrades(studio.id, user.id, bySubmission, parsed.data.grades);
    req.log.info({ classId: studio.id, userId: user.id, count: parsed.data.grades.length }, "grades saved");
    return { saved: parsed.data.grades.length };
  });

  app.delete("/api/teacher/classes/:classId/grades/:submissionId", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const { user, studio } = member;
    const { submissionId } = req.params as { submissionId: string };
    const recording = classRecordings(studio.id).find((item) => item.submissionIds.includes(submissionId));
    if (!recording?.grade) {
      return reply.code(404).send({ error: "This recording has no grade" });
    }
    db.prepare("DELETE FROM grades WHERE studio_id = ? AND recording_key = ?").run(studio.id, recording.recordingKey);
    req.log.info({ classId: studio.id, userId: user.id, submissionId }, "grade removed");
    return { ok: true };
  });

  app.put("/api/teacher/classes/:classId/top3", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Say whether to publish the Top 3" });
    }
    const { user, studio } = member;
    const publishedAt = parsed.data.published ? Date.now() : null;
    db.prepare("UPDATE studios SET top3_published_at = ? WHERE id = ?").run(publishedAt, studio.id);
    req.log.info({ classId: studio.id, userId: user.id, published: parsed.data.published }, "top 3 publish changed");
    return { top3PublishedAt: publishedAt };
  });

  // Anyone with the class link; empty until the teacher publishes.
  app.get("/api/class/:classToken/top3", async (req, reply) => {
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const published = studio.top3_published_at != null;
    return {
      className: studio.name,
      published,
      recordings: published ? topRecordings(studio.id).map(publicRecording) : [],
    };
  });

  // Plays only the published Top 3, never any other recording of the class.
  app.get("/api/class/:classToken/top3/:submissionId/audio", async (req, reply) => {
    const studio = requireClass(req, reply);
    if (!studio) {
      return;
    }
    const { submissionId } = req.params as { submissionId: string };
    const listed =
      studio.top3_published_at != null &&
      topRecordings(studio.id).some((recording) => recording.submissionIds[0] === submissionId);
    if (!listed) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    return streamFile(req, reply, submissionAudioPath(submissionId), "recording.mp3", "audio/mpeg", true);
  });
}
