import {
  GOOGLE_CLIENT_ID,
  GOOGLE_REQUEST_TIMEOUT_MS,
  GOOGLE_TOKENINFO_URL,
  GOOGLE_USERINFO_URL,
} from "./config.js";

export type GoogleProfile = { sub: string; email: string; name: string };

export type GoogleCheck =
  | { ok: true; profile: GoogleProfile }
  | { ok: false; reason: "not-configured" | "invalid-token" | "wrong-client" | "unverified-email" | "unreachable" };

type TokenInfo = { aud?: string; azp?: string; error_description?: string };
type UserInfo = { sub?: string; email?: string; email_verified?: boolean | string; name?: string };

async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  } catch {
    return null;
  }
}

/**
 * Checks a Google OAuth access token from the browser's sign-in popup: it must have been issued to
 * this app's client ID (so a token minted for another site can't sign in here), and the account's
 * email must be verified.
 */
export async function verifyGoogleAccessToken(accessToken: string): Promise<GoogleCheck> {
  if (!GOOGLE_CLIENT_ID) {
    return { ok: false, reason: "not-configured" };
  }
  const info = await getJson<TokenInfo>(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
  if (!info) {
    return { ok: false, reason: "unreachable" };
  }
  if (info.status !== 200) {
    return { ok: false, reason: "invalid-token" };
  }
  if (info.body.aud !== GOOGLE_CLIENT_ID && info.body.azp !== GOOGLE_CLIENT_ID) {
    return { ok: false, reason: "wrong-client" };
  }

  const user = await getJson<UserInfo>(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!user) {
    return { ok: false, reason: "unreachable" };
  }
  const { sub, email, email_verified: verified, name } = user.body;
  if (user.status !== 200 || !sub || !email) {
    return { ok: false, reason: "invalid-token" };
  }
  if (verified !== true && verified !== "true") {
    return { ok: false, reason: "unverified-email" };
  }
  return { ok: true, profile: { sub, email: email.toLowerCase(), name: name?.trim() || email } };
}
