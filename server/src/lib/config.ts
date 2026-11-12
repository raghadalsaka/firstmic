const DEFAULT_MAX_EPISODE_SECONDS = 180;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

export const MAX_EPISODE_SECONDS: number = positiveInt(
  process.env.FIRSTMIC_MAX_SECONDS,
  DEFAULT_MAX_EPISODE_SECONDS
);

/** Same variable and value as QuestRush's .env: the web build bakes it in, and the server checks each token was issued to it. */
export const GOOGLE_CLIENT_ID: string | null = process.env.VITE_GOOGLE_CLIENT_ID?.trim() || null;

/** Overridable so tests can stand in for Google. */
export const GOOGLE_TOKENINFO_URL: string =
  process.env.GOOGLE_TOKENINFO_URL?.trim() || "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_USERINFO_URL: string =
  process.env.GOOGLE_USERINFO_URL?.trim() || "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_REQUEST_TIMEOUT_MS: number = positiveInt(process.env.GOOGLE_REQUEST_TIMEOUT_MS, 5000);

/** Wrong PINs in a row before that student is locked out for PIN_LOCK_MINUTES. */
export const PIN_MAX_ATTEMPTS: number = positiveInt(process.env.PIN_MAX_ATTEMPTS, 5);
export const PIN_LOCK_MINUTES: number = positiveInt(process.env.PIN_LOCK_MINUTES, 15);

/** After a group take stops, how long the server waits for both voices to arrive before the take fails. */
export const GROUP_UPLOAD_TIMEOUT_MS: number = positiveInt(process.env.FIRSTMIC_GROUP_UPLOAD_MINUTES, 5) * 60_000;
export const PIN_ATTEMPTS_PER_MINUTE_PER_IP: number = positiveInt(process.env.PIN_ATTEMPTS_PER_MINUTE_PER_IP, 30);
