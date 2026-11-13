import { db, type StudentRow, type TopicRow } from "./db.js";
import { newId, newToken } from "./ids.js";

/** The student's one solo episode for the topic, created the first time; any of their devices gets the same one. */
export const getOrCreateEpisode = db.transaction(
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

/** The next version number in the episode: each saved recording, made alone or a group copy, gets the next one. */
export function nextVersion(sessionId: string): number {
  return (
    db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM submissions WHERE session_id = ?").get(sessionId) as { v: number }
  ).v;
}

/**
 * Inside a transaction: saves a copy of the group's recording in the student's own episode for the topic, so it shows in
 * their My Recordings like one they made alone. Its MP3 must already be at submissionAudioPath(submissionId).
 */
export function saveCopy(
  studioId: string,
  student: StudentRow,
  topic: TopicRow,
  copy: { submissionId: string; durationMs: number | null; withNames: string }
): void {
  const { episodeId } = getOrCreateEpisode(studioId, student, topic);
  const participant = db.prepare("SELECT id FROM participants WHERE session_id = ?").get(episodeId) as { id: string };
  const now = Date.now();
  const recordingId = newId();
  const trackId = newId();
  const version = nextVersion(episodeId);
  db.prepare(
    "INSERT INTO recordings (id, session_id, started_at_ms, stopped_at_ms, status) VALUES (?, ?, ?, ?, 'ready')"
  ).run(recordingId, episodeId, now, now);
  // The copy is a finished MP3, so its track is already ready and takes no uploads.
  db.prepare(
    `INSERT INTO tracks (id, recording_id, session_id, participant_id, type, mime_type, status, start_offset_ms, duration_ms,
       created_at)
     VALUES (?, ?, ?, ?, 'camera', 'audio/mpeg', 'ready', 0, ?, ?)`
  ).run(trackId, recordingId, episodeId, participant.id, copy.durationMs, now);
  db.prepare(
    `INSERT INTO submissions (id, session_id, recording_id, track_id, status, version, duration_ms, with_names, created_at,
       ready_at)
     VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`
  ).run(copy.submissionId, episodeId, recordingId, trackId, version, copy.durationMs, copy.withNames, now, now);
}
