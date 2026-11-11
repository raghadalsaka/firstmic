import crypto from "node:crypto";
import { z } from "zod";
import { db, type StudentRow } from "./db.js";

// Same rules as QuestRush's roster (web/src/utils/roster.ts), so the dashboard preview predicts what is accepted.
export const MAX_NAME_LENGTH = 60;
export const MAX_EMOJI_LENGTH = 16;
export const MAX_STUDENTS_PER_CLASS = 200;
export const MAX_PHOTO_LENGTH = 45000;
export const PIN_PATTERN = /^\d{6}$/;
// Only small inline pictures: never a link to elsewhere, and never SVG, which can carry script.
const PHOTO_URL_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export const studentNameSchema = z
  .string()
  .transform((raw) => raw.trim().split(/\s+/u).join(" "))
  .refine((name) => name !== "" && [...name].length <= MAX_NAME_LENGTH, "Name must be 1-60 characters")
  .refine((name) => !/\p{Cc}/u.test(name), "Name contains control characters")
  .refine((name) => /\p{L}/u.test(name), "Name has no letters");

export const emojiSchema = z
  .string()
  .transform((raw) => raw.trim())
  .refine(
    (emoji) =>
      emoji !== "" &&
      [...emoji].length <= MAX_EMOJI_LENGTH &&
      Buffer.byteLength(emoji) <= MAX_EMOJI_LENGTH * 4 &&
      !/[\s\p{Cc}]/u.test(emoji),
    "Choose one emoji"
  );

export const photoSchema = z
  .string()
  .max(MAX_PHOTO_LENGTH)
  .regex(PHOTO_URL_PATTERN, "Photo must be a small JPEG, PNG or WebP picture");

export const pinSchema = z.string().regex(PIN_PATTERN, "PIN must be 6 digits");

/** A random 6-digit PIN that isn't in `taken`. */
export function newPin(taken: ReadonlySet<string>): string {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    if (!taken.has(pin)) {
      return pin;
    }
  }
}

export function pinMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function classStudents(studioId: string): StudentRow[] {
  return db
    .prepare("SELECT * FROM students WHERE studio_id = ? ORDER BY sort, created_at")
    .all(studioId) as StudentRow[];
}
