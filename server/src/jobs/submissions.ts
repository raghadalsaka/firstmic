import fs from "node:fs";
import { db, type SubmissionRow, type TrackRow } from "../lib/db.js";
import { MAX_EPISODE_SECONDS } from "../lib/config.js";
import {
  rawTrackPath,
  submissionAudioPath,
  trackChunksDir,
  wavTrackPath,
} from "../lib/storage.js";
import { enqueue, getTrack, onTrackSettled } from "./pipeline.js";
import { probe, toSubmissionMp3 } from "./ffmpeg.js";

const RAW_EXTENSIONS: readonly string[] = ["webm", "mp4", "pcm"];

function getSubmission(submissionId: string): SubmissionRow | undefined {
  return db.prepare("SELECT * FROM submissions WHERE id = ?").get(submissionId) as SubmissionRow | undefined;
}

function submissionForTrack(trackId: string): SubmissionRow | undefined {
  return db.prepare("SELECT * FROM submissions WHERE track_id = ?").get(trackId) as SubmissionRow | undefined;
}

/** Everything a take leaves on disk besides the submission MP3. */
export function removeTrackMedia(trackId: string): void {
  fs.rmSync(trackChunksDir(trackId), { recursive: true, force: true });
  fs.rmSync(wavTrackPath(trackId), { force: true });
  for (const ext of RAW_EXTENSIONS) {
    fs.rmSync(rawTrackPath(trackId, ext), { force: true });
  }
}

/**
 * Deletes the episodes where `scope = value` (their submissions, tracks and tokens cascade), plus whatever
 * `alsoDelete` removes in the same transaction, then the episodes' files.
 */
export function deleteEpisodes(
  scope: "id" | "student_id" | "topic_id",
  value: string,
  alsoDelete?: () => void
): { episodes: number; recordings: number } {
  const { files, episodes } = db.transaction(() => {
    const files = db
      .prepare(
        `SELECT sub.id, sub.track_id FROM submissions sub
         INNER JOIN sessions s ON s.id = sub.session_id
         WHERE s.${scope} = ?`
      )
      .all(value) as Pick<SubmissionRow, "id" | "track_id">[];
    const episodes = db.prepare(`DELETE FROM sessions WHERE ${scope} = ?`).run(value).changes;
    alsoDelete?.();
    return { files, episodes };
  })();
  for (const file of files) {
    fs.rmSync(submissionAudioPath(file.id), { force: true });
    removeTrackMedia(file.track_id);
  }
  return { episodes, recordings: files.length };
}

export function failSubmission(submissionId: string, reason: string): void {
  const result = db
    .prepare("UPDATE submissions SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'")
    .run(reason.slice(0, 2000), submissionId);
  if (result.changes > 0) {
    console.error(`[submissions] ${submissionId} failed: ${reason.slice(0, 300)}`);
  }
}

/**
 * Makes a finished submission the episode's current one. Starting a newer take fails the
 * older "sending" ones, so a submission that is no longer sending is simply not promoted.
 */
const promoteSubmission = db.transaction((submission: SubmissionRow, durationMs: number | null): string | null => {
  const currentId = (
    db.prepare("SELECT current_submission_id AS id FROM sessions WHERE id = ?").get(submission.session_id) as
      | { id: string | null }
      | undefined
  )?.id ?? null;
  const nextVersion = (
    db
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM submissions WHERE session_id = ?")
      .get(submission.session_id) as { v: number }
  ).v;
  const updated = db
    .prepare(
      `UPDATE submissions SET status = 'ready', version = ?, duration_ms = ?, ready_at = ?, error = NULL
       WHERE id = ? AND status = 'sending'`
    )
    .run(nextVersion, durationMs, Date.now(), submission.id);
  if (updated.changes === 0) {
    throw new Error("Superseded before it finished");
  }
  if (currentId) {
    db.prepare("UPDATE submissions SET status = 'replaced' WHERE id = ?").run(currentId);
  }
  db.prepare("UPDATE sessions SET current_submission_id = ? WHERE id = ?").run(submission.id, submission.session_id);
  return currentId;
});

async function encodeSubmission(submissionId: string): Promise<void> {
  const submission = getSubmission(submissionId);
  if (!submission) {
    return;
  }
  const output = submissionAudioPath(submissionId);
  try {
    if (submission.status !== "sending") {
      return;
    }
    await toSubmissionMp3(wavTrackPath(submission.track_id), output, MAX_EPISODE_SECONDS);
    const meta = await probe(output);
    const replacedId = promoteSubmission(submission, meta.durationMs);
    if (replacedId) {
      fs.rmSync(submissionAudioPath(replacedId), { force: true });
    }
    console.log(
      `[submissions] ${submissionId} is now current for episode ${submission.session_id}` +
        (replacedId ? ` (replaced ${replacedId})` : "")
    );
  } catch (err) {
    fs.rmSync(output, { force: true });
    failSubmission(submissionId, err instanceof Error ? err.message : String(err));
  } finally {
    removeTrackMedia(submission.track_id);
  }
}

function handleTrackSettled(trackId: string, status: "ready" | "failed"): void {
  const submission = submissionForTrack(trackId);
  if (!submission) {
    return;
  }
  if (submission.status === "sending" && status === "ready") {
    enqueue(() => encodeSubmission(submission.id));
    return;
  }
  if (status === "failed") {
    failSubmission(submission.id, getTrack(trackId)?.error ?? "Track processing failed");
  }
  removeTrackMedia(trackId);
}

/** A restart can land after the track settled but before its submission did; the pipeline resumes the rest. */
function resumeSettledSubmissions(): void {
  const settled = db
    .prepare(
      `SELECT t.id, t.status FROM submissions sub
       INNER JOIN tracks t ON t.id = sub.track_id
       WHERE sub.status = 'sending' AND t.status IN ('ready', 'failed')`
    )
    .all() as Pick<TrackRow, "id" | "status">[];
  for (const track of settled) {
    handleTrackSettled(track.id, track.status as "ready" | "failed");
  }
}

export function startSubmissionJobs(): void {
  onTrackSettled(handleTrackSettled);
  resumeSettledSubmissions();
}
