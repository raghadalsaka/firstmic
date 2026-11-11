import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, type StudentRow } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { newId, newToken } from "../lib/ids.js";
import { requireClassMember } from "../lib/access.js";
import {
  emojiSchema,
  MAX_STUDENTS_PER_CLASS,
  newPin,
  photoSchema,
  pinSchema,
  studentNameSchema,
} from "../lib/roster.js";
import { deleteEpisodes } from "../jobs/submissions.js";

const newStudentSchema = z.object({
  name: studentNameSchema,
  emoji: emojiSchema,
  pin: pinSchema.optional(),
  photo: photoSchema.nullable().optional(),
});
const addStudentsSchema = z.object({ students: z.array(newStudentSchema).min(1).max(MAX_STUDENTS_PER_CLASS) });
const updateStudentSchema = z
  .object({
    name: studentNameSchema.optional(),
    emoji: emojiSchema.optional(),
    pin: pinSchema.optional(),
    photo: photoSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid student";
}

function studentForMember(req: FastifyRequest, reply: FastifyReply): StudentRow | null {
  const user = requireUser(req, reply);
  if (!user) {
    return null;
  }
  const { studentId } = req.params as { studentId: string };
  const student = db
    .prepare(
      `SELECT s.* FROM students s
       INNER JOIN studio_members m ON m.studio_id = s.studio_id AND m.user_id = ?
       WHERE s.id = ?`
    )
    .get(user.id, studentId) as StudentRow | undefined;
  if (!student) {
    reply.code(404).send({ error: "Student not found" });
    return null;
  }
  return student;
}

function takenPins(studioId: string): Set<string> {
  const rows = db.prepare("SELECT pin FROM students WHERE studio_id = ?").all(studioId) as { pin: string }[];
  return new Set(rows.map((row) => row.pin));
}

/**
 * A new or changed PIN signs the student out on every device: their PIN sign-ins go, and each episode's
 * upload token is replaced, so a device can't keep sending recordings. Episodes and sent recordings stay.
 */
function setPin(student: StudentRow, pin: string): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE students SET pin = ?, failed_pin_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?"
    ).run(pin, Date.now(), student.id);
    db.prepare("DELETE FROM student_logins WHERE student_id = ?").run(student.id);
    const participants = db
      .prepare(
        `SELECT p.id FROM participants p
         INNER JOIN sessions s ON s.id = p.session_id
         WHERE s.student_id = ?`
      )
      .all(student.id) as { id: string }[];
    const replaceToken = db.prepare("UPDATE participants SET token = ? WHERE id = ?");
    for (const participant of participants) {
      replaceToken.run(newToken(), participant.id);
    }
  })();
}

export function registerRosterRoutes(app: FastifyInstance): void {
  app.post("/api/teacher/classes/:classId/students", async (req, reply) => {
    const member = requireClassMember(req, reply);
    if (!member) {
      return;
    }
    const { user, studio } = member;
    const parsed = addStudentsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: firstIssue(parsed.error) });
    }
    const existing = db.prepare("SELECT pin, sort FROM students WHERE studio_id = ?").all(studio.id) as Pick<
      StudentRow,
      "pin" | "sort"
    >[];
    if (existing.length + parsed.data.students.length > MAX_STUDENTS_PER_CLASS) {
      return reply.code(400).send({ error: `A class can have at most ${MAX_STUDENTS_PER_CLASS} students` });
    }
    const taken = new Set(existing.map((student) => student.pin));
    const clashes: string[] = [];
    for (const student of parsed.data.students) {
      if (student.pin) {
        if (taken.has(student.pin)) {
          clashes.push(`${student.name} (${student.pin})`);
        }
        taken.add(student.pin);
      }
    }
    if (clashes.length > 0) {
      return reply.code(409).send({ error: `These PINs are already used in this class: ${clashes.join(", ")}` });
    }

    const now = Date.now();
    let sort = existing.reduce((max, student) => Math.max(max, student.sort), -1);
    const insert = db.prepare(
      `INSERT INTO students (id, studio_id, name, emoji, photo, pin, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const added = db.transaction(() =>
      parsed.data.students.map((student) => {
        const row = { id: newId(), name: student.name, emoji: student.emoji, pin: student.pin ?? newPin(taken) };
        taken.add(row.pin);
        insert.run(row.id, studio.id, row.name, row.emoji, student.photo ?? null, row.pin, ++sort, now, now);
        return row;
      })
    )();
    req.log.info({ classId: studio.id, userId: user.id, added: added.length }, "students added");
    return { students: added };
  });

  app.patch("/api/teacher/students/:studentId", async (req, reply) => {
    const student = studentForMember(req, reply);
    if (!student) {
      return;
    }
    const parsed = updateStudentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: firstIssue(parsed.error) });
    }
    const { name, emoji, pin, photo } = parsed.data;
    const pinChanged = pin !== undefined && pin !== student.pin;
    if (pinChanged && takenPins(student.studio_id).has(pin)) {
      return reply.code(409).send({ error: "Another student in this class already has that PIN" });
    }
    db.transaction(() => {
      if (pinChanged) {
        setPin(student, pin);
      }
      db.prepare("UPDATE students SET name = ?, emoji = ?, photo = ?, updated_at = ? WHERE id = ?").run(
        name ?? student.name,
        emoji ?? student.emoji,
        photo === undefined ? student.photo : photo,
        Date.now(),
        student.id
      );
    })();
    return { ok: true };
  });

  app.post("/api/teacher/students/:studentId/new-pin", async (req, reply) => {
    const student = studentForMember(req, reply);
    if (!student) {
      return;
    }
    const pin = newPin(takenPins(student.studio_id));
    setPin(student, pin);
    req.log.info({ studentId: student.id }, "student PIN replaced");
    return { pin };
  });

  app.delete("/api/teacher/students/:studentId", async (req, reply) => {
    const student = studentForMember(req, reply);
    if (!student) {
      return;
    }
    const { recordings } = deleteEpisodes("student_id", student.id, () => {
      db.prepare("DELETE FROM students WHERE id = ?").run(student.id);
    });
    req.log.info({ studentId: student.id, recordings }, "student removed");
    return { ok: true };
  });
}
