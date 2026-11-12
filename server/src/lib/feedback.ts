import { db } from "./db.js";

export const FEEDBACK_MAX_CHARS = 2000;

export type FeedbackKind = "submission" | "groupTake";

type FeedbackTarget = {
  /** The version rows feedback attaches to. */
  table: string;
  /** The session column that points at the current version. */
  pointer: string;
  sentStatuses: string;
  sentAt: string;
  sessionKind: "solo" | "group";
};

export const FEEDBACK_TARGETS: Record<FeedbackKind, FeedbackTarget> = {
  submission: {
    table: "submissions",
    pointer: "current_submission_id",
    sentStatuses: "'ready', 'replaced'",
    sentAt: "ready_at",
    sessionKind: "solo",
  },
  groupTake: {
    table: "group_takes",
    pointer: "current_take_id",
    sentStatuses: "'sent', 'replaced'",
    sentAt: "sent_at",
    sessionKind: "group",
  },
};

/**
 * Whether version row `alias` still has its audio: the current one always does, and a replaced one only if it had
 * feedback when it was replaced (feedback on a replaced version can't change after that).
 */
export function hasAudioSql(kind: FeedbackKind, alias: string, sessionAlias: string): string {
  const { pointer } = FEEDBACK_TARGETS[kind];
  return `(${sessionAlias}.${pointer} = ${alias}.id OR (${alias}.status = 'replaced' AND ${alias}.feedback IS NOT NULL))`;
}

export type SaveFeedbackResult = { ok: true; sessionId: string } | { ok: false; status: 404 | 409; error: string };

/**
 * Saves (or, with null, clears) the teacher's comment on a sent version of a class they're a member of. Only the
 * current version takes feedback: the send that replaces it reads the comment in its own transaction to decide
 * whether the audio stays, so a comment can't land on a version whose audio is already gone.
 */
export const saveFeedback = db.transaction(
  (kind: FeedbackKind, versionId: string, userId: string, text: string | null): SaveFeedbackResult => {
    const { table, pointer, sentStatuses } = FEEDBACK_TARGETS[kind];
    const row = db
      .prepare(
        `SELECT v.session_id AS sessionId, s.${pointer} AS currentId FROM ${table} v
         INNER JOIN sessions s ON s.id = v.session_id
         INNER JOIN studio_members m ON m.studio_id = s.studio_id AND m.user_id = ?
         WHERE v.id = ? AND v.status IN (${sentStatuses})`
      )
      .get(userId, versionId) as { sessionId: string; currentId: string | null } | undefined;
    if (!row) {
      return { ok: false, status: 404, error: "Recording not found" };
    }
    if (row.currentId !== versionId) {
      return { ok: false, status: 409, error: "A newer recording was sent, so this one can't be changed. Reload the page." };
    }
    const now = text === null ? null : Date.now();
    db.prepare(`UPDATE ${table} SET feedback = ?, feedback_at = ?, feedback_by = ? WHERE id = ?`).run(
      text,
      now,
      text === null ? null : userId,
      versionId
    );
    return { ok: true, sessionId: row.sessionId };
  }
);

/** A student's earlier version with the teacher's comment; its audio was kept because of that comment. */
export type PastFeedback = { id: string; version: number; sentAt: number; durationMs: number | null; feedback: string };

/** The episode's replaced versions that have feedback, newest first: what students see under Past Feedback. */
export function pastFeedback(kind: FeedbackKind, sessionId: string): PastFeedback[] {
  const { table, sentAt } = FEEDBACK_TARGETS[kind];
  return db
    .prepare(
      `SELECT id, version, ${sentAt} AS sentAt, duration_ms AS durationMs, feedback FROM ${table}
       WHERE session_id = ? AND status = 'replaced' AND feedback IS NOT NULL
       ORDER BY version DESC`
    )
    .all(sessionId) as PastFeedback[];
}
