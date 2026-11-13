import fs from "node:fs";
import { db, type SubmissionRow, type TrackRow } from "../lib/db.js";
import { MAX_EPISODE_SECONDS } from "../lib/config.js";
import {
  groupMixPath,
  groupVoicePath,
  rawTrackPath,
  submissionAudioPath,
  trackChunksDir,
  wavTrackPath,
} from "../lib/storage.js";
import { disconnect } from "../lib/rooms.js";
import { enqueue, getTrack, onTrackSettled } from "./pipeline.js";
import { probe, toSubmissionMp3 } from "./ffmpeg.js";
import { nextVersion } from "../lib/episodes.js";

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

// A student's episodes include the groups they're a member of, so removing them never leaves their voice behind.
const EPISODES_IN_SCOPE = {
  id: "SELECT id FROM sessions WHERE id = @value",
  studio_id: "SELECT id FROM sessions WHERE studio_id = @value",
  topic_id: "SELECT id FROM sessions WHERE topic_id = @value",
  student_id:
    "SELECT id FROM sessions WHERE student_id = @value UNION SELECT session_id FROM participants WHERE student_id = @value",
} satisfies Record<string, string>;

/** Everything on disk for these group takes and tracks (solo or group): mixes, voice MP3s and intermediates. */
export function removeRecordingFiles(takeIds: readonly string[], trackIds: readonly string[]): void {
  for (const takeId of takeIds) {
    fs.rmSync(groupMixPath(takeId), { force: true });
  }
  for (const trackId of trackIds) {
    fs.rmSync(groupVoicePath(trackId), { force: true });
    removeTrackMedia(trackId);
  }
}

/**
 * Deletes the episodes in scope (solo and group: their submissions, takes, tracks and tokens cascade), plus whatever
 * `alsoDelete` removes in the same transaction, then the episodes' files, and closes their live rooms.
 */
export function deleteEpisodes(
  scope: keyof typeof EPISODES_IN_SCOPE,
  value: string,
  alsoDelete?: () => void
): { episodes: number; recordings: number } {
  const episodesInScope = EPISODES_IN_SCOPE[scope];
  const { sessionIds, submissionIds, takeIds, trackIds } = db.transaction(() => {
    const ids = (sql: string): string[] =>
      (db.prepare(sql).all({ value }) as { id: string }[]).map((row) => row.id);
    const found = {
      sessionIds: ids(episodesInScope),
      submissionIds: ids(`SELECT id FROM submissions WHERE session_id IN (${episodesInScope})`),
      takeIds: ids(`SELECT id FROM group_takes WHERE session_id IN (${episodesInScope})`),
      trackIds: ids(`SELECT id FROM tracks WHERE session_id IN (${episodesInScope})`),
    };
    db.prepare(`DELETE FROM sessions WHERE id IN (${episodesInScope})`).run({ value });
    alsoDelete?.();
    return found;
  })();
  for (const submissionId of submissionIds) {
    fs.rmSync(submissionAudioPath(submissionId), { force: true });
  }
  removeRecordingFiles(takeIds, trackIds);
  for (const sessionId of sessionIds) {
    disconnect(sessionId);
  }
  return { episodes: sessionIds.length, recordings: submissionIds.length + takeIds.length };
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
 * Saves a finished recording in the student's My Recordings. Starting a newer take fails the older "sending" ones, so
 * a submission that is no longer sending is simply not saved.
 */
const saveSubmission = db.transaction((submission: SubmissionRow, durationMs: number | null): void => {
  const updated = db
    .prepare(
      `UPDATE submissions SET status = 'ready', version = ?, duration_ms = ?, ready_at = ?, error = NULL
       WHERE id = ? AND status = 'sending'`
    )
    .run(nextVersion(submission.session_id), durationMs, Date.now(), submission.id);
  if (updated.changes === 0) {
    throw new Error("Superseded before it finished");
  }
});

/** Deletes one saved recording and its MP3 (a student submitted it? the submission goes with it). */
export function deleteRecording(submission: Pick<SubmissionRow, "id" | "recording_id">): void {
  // The recording row cascades its track and the submission; students.submitted_submission_id is set to NULL.
  db.prepare("DELETE FROM recordings WHERE id = ?").run(submission.recording_id);
  fs.rmSync(submissionAudioPath(submission.id), { force: true });
}

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
    saveSubmission(submission, meta.durationMs);
    console.log(`[submissions] ${submissionId} saved for episode ${submission.session_id}`);
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
