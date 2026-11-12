import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo-root data dir: server/src/lib -> repo root is ../../..
export const DATA_DIR =
  process.env.FIRSTMIC_DATA_DIR ?? path.resolve(__dirname, "../../../data");

export const CHUNKS_DIR = path.join(DATA_DIR, "chunks");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const EXPORTS_DIR = path.join(DATA_DIR, "exports");
export const SUBMISSIONS_DIR = path.join(DATA_DIR, "submissions");

for (const dir of [DATA_DIR, CHUNKS_DIR, MEDIA_DIR, EXPORTS_DIR, SUBMISSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function chunkPath(trackId: string, idx: number): string {
  return path.join(CHUNKS_DIR, trackId, `${idx}.bin`);
}

export function trackChunksDir(trackId: string): string {
  return path.join(CHUNKS_DIR, trackId);
}

/** Assembled raw recording (concatenated MediaRecorder chunks, usually .webm). */
export function rawTrackPath(trackId: string, ext: string): string {
  return path.join(MEDIA_DIR, `${trackId}.raw.${ext}`);
}

export function mp4TrackPath(trackId: string): string {
  return path.join(MEDIA_DIR, `${trackId}.mp4`);
}

export function wavTrackPath(trackId: string): string {
  return path.join(MEDIA_DIR, `${trackId}.wav`);
}

/** Noise-reduced + loudness-normalized voice track ("Magic Audio"-style). */
export function enhancedWavPath(trackId: string): string {
  return path.join(MEDIA_DIR, `${trackId}.enhanced.wav`);
}

export function exportPath(exportId: string, ext: string): string {
  return path.join(EXPORTS_DIR, `${exportId}.${ext}`);
}

export function submissionAudioPath(submissionId: string): string {
  return path.join(SUBMISSIONS_DIR, `${submissionId}.mp3`);
}

/** A group take's mix of both voices: what the students listen to and the teacher plays. */
export function groupMixPath(takeId: string): string {
  return path.join(SUBMISSIONS_DIR, `${takeId}.mix.mp3`);
}

/** One student's voice from a group take, lined up with the mix. */
export function groupVoicePath(trackId: string): string {
  return path.join(SUBMISSIONS_DIR, `${trackId}.voice.mp3`);
}
