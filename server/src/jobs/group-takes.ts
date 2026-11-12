import fs from "node:fs";
import { db, type GroupTakeRow, type GroupTakeStatus, type ParticipantRow, type TrackRow } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { GROUP_UPLOAD_TIMEOUT_MS, MAX_EPISODE_SECONDS } from "../lib/config.js";
import { broadcastGroup, getTake, GROUP_SIZE, groupMembers, openTake, takeControllerId } from "../lib/groups.js";
import { groupMixPath, groupVoicePath, trackChunksDir, wavTrackPath } from "../lib/storage.js";
import { enqueue, onTrackSettled } from "./pipeline.js";
import { groupTakeExport, probe, type MixInput } from "./ffmpeg.js";
import { removeRecordingFiles, removeTrackMedia } from "./submissions.js";

type TakeResult = { ok: true; takeId: string } | { ok: false; status: number; error: string };

const MAX_TAKE_MS = MAX_EPISODE_SECONDS * 1000;
const VOICES_LATE = "Both voices did not arrive in time";

// Per take: the recording time limit while it records, then the deadline for both voices to arrive.
const timers = new Map<string, NodeJS.Timeout>();
const mixesQueued = new Set<string>();

function setTimer(takeId: string, delayMs: number, fire: () => void): void {
  clearTimer(takeId);
  timers.set(
    takeId,
    setTimeout(() => {
      timers.delete(takeId);
      fire();
    }, Math.max(0, delayMs))
  );
}

function clearTimer(takeId: string): void {
  const timer = timers.get(takeId);
  if (timer) {
    clearTimeout(timer);
  }
  timers.delete(takeId);
}

function armStopTimer(takeId: string, delayMs: number): void {
  setTimer(takeId, delayMs, () => stopTake(takeId));
}

function armUploadTimer(takeId: string, delayMs: number): void {
  setTimer(takeId, delayMs, () => failTake(takeId, VOICES_LATE));
}

function takeTracks(take: GroupTakeRow): TrackRow[] {
  return db.prepare("SELECT * FROM tracks WHERE recording_id = ?").all(take.recording_id) as TrackRow[];
}

function takeTrackIds(take: GroupTakeRow): string[] {
  return takeTracks(take).map((track) => track.id);
}

/** The student who started the take, or whoever takeControllerId hands it to while they're away. */
export function canControl(take: GroupTakeRow, participantId: string): boolean {
  return take.controller_id === participantId || takeControllerId(take, groupMembers(take.session_id)) === participantId;
}

/** Refuses late uploads from a device still sending its voice for a take that ended. */
function failOpenTracks(take: GroupTakeRow, reason: string): void {
  db.prepare(
    "UPDATE tracks SET status = 'failed', error = ? WHERE recording_id = ? AND status IN ('recording', 'uploading')"
  ).run(reason, take.recording_id);
}

const startTransaction = db.transaction((sessionId: string, controllerId: string): string | null => {
  if (openTake(sessionId)) {
    return null;
  }
  const now = Date.now();
  const recordingId = newId();
  // The take row, not the recording, says whether the group is recording, so Tributary's room timers leave it alone.
  db.prepare("INSERT INTO recordings (id, session_id, started_at_ms, status) VALUES (?, ?, ?, 'uploading')").run(
    recordingId,
    sessionId,
    now
  );
  const takeId = newId();
  db.prepare(
    "INSERT INTO group_takes (id, session_id, recording_id, controller_id, status, created_at) VALUES (?, ?, ?, ?, 'recording', ?)"
  ).run(takeId, sessionId, recordingId, controllerId, now);
  return takeId;
});

/** Starts a take once both members are connected; whoever starts it controls it. */
export function startTake(sessionId: string, participant: ParticipantRow): TakeResult {
  const members = groupMembers(sessionId);
  if (members.length < GROUP_SIZE) {
    return { ok: false, status: 409, error: "Wait for your partner to join." };
  }
  const away = members.find((member) => !member.online);
  if (away) {
    return { ok: false, status: 409, error: `Wait for ${away.name} to come back.` };
  }
  const takeId = startTransaction(sessionId, participant.id);
  if (!takeId) {
    return { ok: false, status: 409, error: "Your group is already working on a take." };
  }
  armStopTimer(takeId, MAX_TAKE_MS);
  console.log(`[groups] take ${takeId} started in group ${sessionId} by ${participant.id}`);
  broadcastGroup(sessionId);
  return { ok: true, takeId };
}

/** Ends recording; both devices then upload their voice, and the mix starts once both have arrived. */
export function stopTake(takeId: string): boolean {
  const take = getTake(takeId);
  if (!take || take.status !== "recording") {
    return false;
  }
  const now = Date.now();
  const stopped = db.transaction(() => {
    const changes = db
      .prepare("UPDATE group_takes SET status = 'mixing', stopped_at = ?, duration_ms = ? WHERE id = ? AND status = 'recording'")
      .run(now, Math.min(now - take.created_at, MAX_TAKE_MS), take.id).changes;
    db.prepare("UPDATE recordings SET stopped_at_ms = ? WHERE id = ?").run(now, take.recording_id);
    return changes > 0;
  })();
  if (!stopped) {
    return false;
  }
  armUploadTimer(take.id, GROUP_UPLOAD_TIMEOUT_MS);
  console.log(`[groups] take ${take.id} stopped after ${now - take.created_at} ms`);
  broadcastGroup(take.session_id);
  checkVoicesArrived(take.id);
  return true;
}

/** The server track a member uploads their voice into; asking again returns the same one, so a reloaded page resumes. */
export function voiceTrack(
  take: GroupTakeRow,
  participant: ParticipantRow,
  voice: { mimeType: string; startOffsetMs: number; durationMs: number }
): { ok: true; trackId: string } | { ok: false; status: number; error: string } {
  if (take.status !== "recording" && take.status !== "mixing") {
    return { ok: false, status: 409, error: "This take has ended." };
  }
  const existing = db
    .prepare("SELECT id FROM tracks WHERE recording_id = ? AND participant_id = ?")
    .get(take.recording_id, participant.id) as { id: string } | undefined;
  if (existing) {
    return { ok: true, trackId: existing.id };
  }
  const trackId = newId();
  db.prepare(
    `INSERT INTO tracks (id, recording_id, session_id, participant_id, type, mime_type, status,
       start_offset_ms, duration_ms, created_at)
     VALUES (?, ?, ?, ?, 'camera', ?, 'recording', ?, ?, ?)`
  ).run(
    trackId,
    take.recording_id,
    take.session_id,
    participant.id,
    voice.mimeType,
    voice.startOffsetMs,
    voice.durationMs,
    Date.now()
  );
  fs.mkdirSync(trackChunksDir(trackId), { recursive: true });
  return { ok: true, trackId };
}

/** Moves an open take to `status` and throws away its files; the group's sent take, if any, stays with the teacher. */
function endTake(
  take: GroupTakeRow,
  status: "failed" | "discarded",
  from: readonly GroupTakeStatus[],
  reason: string
): boolean {
  const ended = db.transaction(() => {
    const changes = db
      .prepare(`UPDATE group_takes SET status = ?, error = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
      .run(status, reason, take.id, ...from).changes;
    if (changes > 0) {
      failOpenTracks(take, reason);
    }
    return changes > 0;
  })();
  if (!ended) {
    return false;
  }
  clearTimer(take.id);
  removeRecordingFiles([take.id], takeTrackIds(take));
  (status === "failed" ? console.error : console.log)(`[groups] take ${take.id} ${status}: ${reason.slice(0, 300)}`);
  broadcastGroup(take.session_id);
  return true;
}

function failTake(takeId: string, reason: string): void {
  const take = getTake(takeId);
  if (take) {
    endTake(take, "failed", ["recording", "mixing"], reason.slice(0, 2000));
  }
}

/** Try Again: throws the take away. */
export function discardTake(take: GroupTakeRow): boolean {
  return endTake(take, "discarded", ["mixing", "listening", "failed"], "The take was thrown away");
}

const sendTransaction = db.transaction((take: GroupTakeRow): { version: number; replaced: GroupTakeRow | null } | null => {
  const now = Date.now();
  const version = (
    db
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM group_takes WHERE session_id = ?")
      .get(take.session_id) as { v: number }
  ).v;
  const sent = db
    .prepare("UPDATE group_takes SET status = 'sent', version = ?, sent_at = ? WHERE id = ? AND status = 'listening'")
    .run(version, now, take.id).changes;
  if (sent === 0) {
    return null;
  }
  const currentId = (
    db.prepare("SELECT current_take_id AS id FROM sessions WHERE id = ?").get(take.session_id) as { id: string | null }
  ).id;
  const replaced = currentId ? getTake(currentId) ?? null : null;
  if (replaced) {
    db.prepare("UPDATE group_takes SET status = 'replaced' WHERE id = ?").run(replaced.id);
  }
  db.prepare("UPDATE sessions SET current_take_id = ? WHERE id = ?").run(take.id, take.session_id);
  return { version, replaced };
});

/** Send: hands the mix and both voices to the teacher together, replacing the group's previous sent take. */
export function sendTake(take: GroupTakeRow): { version: number } | null {
  const result = sendTransaction(take);
  if (!result) {
    return null;
  }
  if (result.replaced) {
    removeRecordingFiles([result.replaced.id], takeTrackIds(result.replaced));
  }
  console.log(
    `[groups] take ${take.id} sent as version ${result.version}` + (result.replaced ? ` (replaced ${result.replaced.id})` : "")
  );
  broadcastGroup(take.session_id);
  return { version: result.version };
}

/** Queues the mix once every member's voice is processed; a failed voice fails the take. */
function checkVoicesArrived(takeId: string): void {
  const take = getTake(takeId);
  if (!take || take.status !== "mixing" || mixesQueued.has(take.id)) {
    return;
  }
  const tracks = takeTracks(take);
  const failed = tracks.find((track) => track.status === "failed");
  if (failed) {
    failTake(take.id, failed.error ?? "A voice could not be processed");
    return;
  }
  const members = db.prepare("SELECT id FROM participants WHERE session_id = ?").all(take.session_id) as { id: string }[];
  const allReady = members.every((member) =>
    tracks.some((track) => track.participant_id === member.id && track.status === "ready")
  );
  if (!allReady) {
    return;
  }
  mixesQueued.add(take.id);
  enqueue(() => mixTake(take.id).finally(() => mixesQueued.delete(take.id)));
}

/** Lines both voices up on the take's timeline, then writes the mix and each voice as MP3s. */
async function mixTake(takeId: string): Promise<void> {
  const take = getTake(takeId);
  if (!take || take.status !== "mixing") {
    return;
  }
  const tracks = takeTracks(take).filter((track) => track.status === "ready");
  const trackIds = tracks.map((track) => track.id);
  const inputs: MixInput[] = tracks.map((track) => ({
    filePath: wavTrackPath(track.id),
    offsetMs: track.start_offset_ms,
    hasAudio: true,
    hasVideo: false,
    label: track.participant_id,
  }));
  let kept = false;
  try {
    await groupTakeExport(inputs, groupMixPath(take.id), trackIds.map(groupVoicePath), take.duration_ms ?? MAX_TAKE_MS);
    const meta = await probe(groupMixPath(take.id));
    kept =
      db
        .prepare("UPDATE group_takes SET status = 'listening', duration_ms = COALESCE(?, duration_ms) WHERE id = ? AND status = 'mixing'")
        .run(meta.durationMs, take.id).changes > 0;
    if (kept) {
      clearTimer(take.id);
      console.log(`[groups] take ${take.id} mixed`);
      broadcastGroup(take.session_id);
    }
  } catch (err) {
    failTake(take.id, err instanceof Error ? err.message : String(err));
  } finally {
    if (kept) {
      trackIds.forEach(removeTrackMedia);
    } else {
      removeRecordingFiles([take.id], trackIds);
    }
  }
}

function handleTrackSettled(trackId: string): void {
  const take = db
    .prepare("SELECT gt.* FROM group_takes gt INNER JOIN tracks t ON t.recording_id = gt.recording_id WHERE t.id = ?")
    .get(trackId) as GroupTakeRow | undefined;
  if (!take || take.status === "recording") {
    // Solo track, or a voice that finished uploading before Stop reached the server: stopTake checks it.
    return;
  }
  if (take.status === "mixing") {
    checkVoicesArrived(take.id);
    return;
  }
  // The take ended without this voice; its MP3s, if any, went when it ended.
  removeTrackMedia(trackId);
}

/** The timers live in memory, so a restart re-arms them; track processing itself resumes in the pipeline. */
function resumeOpenTakes(): void {
  const now = Date.now();
  const takes = db
    .prepare("SELECT * FROM group_takes WHERE status IN ('recording', 'mixing')")
    .all() as GroupTakeRow[];
  for (const take of takes) {
    if (take.status === "recording") {
      armStopTimer(take.id, take.created_at + MAX_TAKE_MS - now);
    } else {
      armUploadTimer(take.id, (take.stopped_at ?? now) + GROUP_UPLOAD_TIMEOUT_MS - now);
      checkVoicesArrived(take.id);
    }
  }
}

export function startGroupJobs(): void {
  onTrackSettled(handleTrackSettled);
  resumeOpenTakes();
}
