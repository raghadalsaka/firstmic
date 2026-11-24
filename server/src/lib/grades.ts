import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import { db, type GradeRow } from "./db.js";
import { newId } from "./ids.js";
import { submissionAudioPath } from "./storage.js";

const CRITERIA = ["content", "organization", "delivery", "language"] as const;
type Criterion = (typeof CRITERIA)[number];
type Scores = Record<Criterion, number>;
type Highlight = { startMs: number; endMs: number; note: string };

const TOP_RECORDING_COUNT = 3;
const MAX_HIGHLIGHTS = 5;
const MAX_NOTE_LENGTH = 200;
const MAX_COMMENT_LENGTH = 1000;
const MAX_GRADES_PER_UPLOAD = 500;
// A recording's stored length can be a little shorter than its file, so a highlight may end just past it.
const HIGHLIGHT_END_SLACK_MS = 1000;

const level = z.number().int().min(1).max(4);
const highlightSchema = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
    note: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
  })
  .refine((highlight) => highlight.endMs > highlight.startMs, { message: "A highlight must end after it starts" });

const gradeInputSchema = z.object({
  submissionId: z.string().min(1),
  scores: z.object({ content: level, organization: level, delivery: level, language: level }),
  highlights: z.array(highlightSchema).max(MAX_HIGHLIGHTS).default([]),
  comment: z
    .string()
    .trim()
    .max(MAX_COMMENT_LENGTH)
    .nullish()
    .transform((value) => value || null),
});
export type GradeInput = z.infer<typeof gradeInputSchema>;

export const gradesUploadSchema = z.object({ grades: z.array(gradeInputSchema).min(1).max(MAX_GRADES_PER_UPLOAD) });

type GradeView = {
  scores: Scores;
  total: number;
  highlights: Highlight[];
  comment: string | null;
};

/** One submitted recording: a solo take, or a partner mix that one or both partners submitted. */
export type ClassRecording = {
  recordingKey: string;
  submissionIds: string[];
  names: string[];
  topicTitle: string | null;
  durationMs: number | null;
  submittedAt: number;
  grade: GradeView | null;
  rank: number | null;
};

type SubmittedRow = {
  submission_id: string;
  duration_ms: number | null;
  with_names: string | null;
  mix_sha256: string | null;
  submitted_at: number;
  student_name: string;
  topic_title: string | null;
};

export function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Fills in mix_sha256 for partner copies saved before the column existed; a copy whose file is gone stays NULL. */
export function backfillMixHashes(): void {
  const rows = db
    .prepare("SELECT id FROM submissions WHERE with_names IS NOT NULL AND mix_sha256 IS NULL AND status = 'ready'")
    .all() as { id: string }[];
  const update = db.prepare("UPDATE submissions SET mix_sha256 = ? WHERE id = ?");
  let filled = 0;
  for (const row of rows) {
    try {
      update.run(fileSha256(submissionAudioPath(row.id)), row.id);
      filled++;
    } catch {
      // No file to hash; the copy is graded on its own, as a solo recording is.
    }
  }
  if (rows.length > 0) {
    console.log(`[grades] filled in mix hashes for ${filled} of ${rows.length} partner copies`);
  }
}

function toGradeView(row: GradeRow): GradeView {
  const scores: Scores = {
    content: row.content,
    organization: row.organization,
    delivery: row.delivery,
    language: row.language,
  };
  return {
    scores,
    total: CRITERIA.reduce((sum, criterion) => sum + scores[criterion], 0),
    highlights: JSON.parse(row.highlights_json) as Highlight[],
    comment: row.comment,
  };
}

/** Highest total first; a tie goes to the higher Content score, then to the recording submitted first. */
function compareGraded(a: ClassRecording, b: ClassRecording): number {
  const gradeA = a.grade as GradeView;
  const gradeB = b.grade as GradeView;
  if (gradeA.total !== gradeB.total) {
    return gradeB.total - gradeA.total;
  }
  if (gradeA.scores.content !== gradeB.scores.content) {
    return gradeB.scores.content - gradeA.scores.content;
  }
  return a.submittedAt - b.submittedAt;
}

/** The class's submitted recordings with their grades; graded ones come first, in rank order. */
export function classRecordings(studioId: string): ClassRecording[] {
  const rows = db
    .prepare(
      `SELECT sub.id AS submission_id, sub.duration_ms, sub.with_names, sub.mix_sha256, stu.submitted_at,
         stu.name AS student_name, t.title AS topic_title
       FROM students stu
       INNER JOIN submissions sub ON sub.id = stu.submitted_submission_id
       INNER JOIN sessions s ON s.id = sub.session_id
       LEFT JOIN topics t ON t.id = s.topic_id
       WHERE stu.studio_id = ?
       ORDER BY stu.submitted_at`
    )
    .all(studioId) as SubmittedRow[];
  const grades = new Map(
    (db.prepare("SELECT * FROM grades WHERE studio_id = ?").all(studioId) as GradeRow[]).map((row) => [row.recording_key, row])
  );

  const byKey = new Map<string, ClassRecording>();
  for (const row of rows) {
    // A solo recording is its own submission; partners' copies of one mix share the mix's hash.
    const key = row.mix_sha256 ?? row.submission_id;
    const partners = row.with_names ? row.with_names.split(" & ") : [];
    const existing = byKey.get(key);
    if (existing) {
      existing.submissionIds.push(row.submission_id);
      for (const name of [row.student_name, ...partners]) {
        if (!existing.names.includes(name)) {
          existing.names.push(name);
        }
      }
      continue;
    }
    const grade = grades.get(key);
    byKey.set(key, {
      recordingKey: key,
      submissionIds: [row.submission_id],
      names: [row.student_name, ...partners],
      topicTitle: row.topic_title,
      durationMs: row.duration_ms,
      submittedAt: row.submitted_at,
      grade: grade ? toGradeView(grade) : null,
      rank: null,
    });
  }

  const recordings = [...byKey.values()];
  const graded = recordings.filter((recording) => recording.grade !== null).sort(compareGraded);
  graded.forEach((recording, index) => (recording.rank = index + 1));
  return [...graded, ...recordings.filter((recording) => recording.grade === null)];
}

export type RankedRecording = ClassRecording & { grade: GradeView; rank: number };

export function topRecordings(studioId: string): RankedRecording[] {
  return classRecordings(studioId)
    .filter((recording): recording is RankedRecording => recording.rank !== null)
    .slice(0, TOP_RECORDING_COUNT);
}

export function recordingsBySubmission(recordings: ClassRecording[]): Map<string, ClassRecording> {
  return new Map(recordings.flatMap((recording) => recording.submissionIds.map((id) => [id, recording])));
}

/** Why each grade can't be saved; empty when all of them can. */
export function gradeProblems(bySubmission: Map<string, ClassRecording>, inputs: GradeInput[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  inputs.forEach((input, index) => {
    const label = `Grade ${index + 1}`;
    const recording = bySubmission.get(input.submissionId);
    if (!recording) {
      problems.push(`${label}: no submitted recording ${input.submissionId} in this class`);
      return;
    }
    if (seen.has(recording.recordingKey)) {
      problems.push(`${label}: ${recording.names.join(" & ")} is graded twice in this upload`);
    }
    seen.add(recording.recordingKey);
    const limitMs = recording.durationMs === null ? null : recording.durationMs + HIGHLIGHT_END_SLACK_MS;
    if (limitMs !== null && input.highlights.some((highlight) => highlight.endMs > limitMs)) {
      problems.push(`${label}: a highlight ends after the recording does`);
    }
  });
  return problems;
}

/** Saves every grade or none; a recording's earlier grade is replaced. Run gradeProblems first. */
export function saveGrades(
  studioId: string,
  userId: string,
  bySubmission: Map<string, ClassRecording>,
  inputs: GradeInput[]
): void {
  const upsert = db.prepare(
    `INSERT INTO grades (id, studio_id, recording_key, content, organization, delivery, language, highlights_json, comment,
       graded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (studio_id, recording_key) DO UPDATE SET
       content = excluded.content, organization = excluded.organization, delivery = excluded.delivery,
       language = excluded.language, highlights_json = excluded.highlights_json, comment = excluded.comment,
       graded_by = excluded.graded_by, updated_at = excluded.updated_at`
  );
  const now = Date.now();
  db.transaction(() => {
    for (const input of inputs) {
      const recording = bySubmission.get(input.submissionId) as ClassRecording;
      const highlights = [...input.highlights].sort((a, b) => a.startMs - b.startMs);
      upsert.run(
        newId(),
        studioId,
        recording.recordingKey,
        input.scores.content,
        input.scores.organization,
        input.scores.delivery,
        input.scores.language,
        JSON.stringify(highlights),
        input.comment,
        userId,
        now,
        now
      );
    }
  })();
}
