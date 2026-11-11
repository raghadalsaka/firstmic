// Ported from QuestRush's src/services/googleAuth.ts: same Google Identity Services popup and the same
// VITE_GOOGLE_CLIENT_ID, asking only for the teacher's basic profile instead of the sheet.

const GIS_SCRIPT_URL: string = 'https://accounts.google.com/gsi/client'
const PROFILE_SCOPE: string = 'openid email profile'

export class GoogleSignInError extends Error {}

interface TokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void
}

interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback?: (error: { type?: string; message?: string }) => void
      }) => TokenClient
      revoke: (token: string, done?: () => void) => void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentity
  }
}

let scriptLoad: Promise<void> | null = null
let tokenClient: TokenClient | null = null
let pending: { resolve: (token: string) => void; reject: (error: GoogleSignInError) => void } | null = null
let accessToken: string = ''

export function googleClientId(): string {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
}

export const googleSignIn: boolean = googleClientId() !== ''

// The sign-in popup must open inside the click, so the Google script is loaded before the teacher clicks.
export function preloadGoogleSignIn(): Promise<void> {
  if (!googleSignIn) {
    return Promise.resolve()
  }
  if (scriptLoad === null) {
    scriptLoad = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = GIS_SCRIPT_URL
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        scriptLoad = null
        reject(new GoogleSignInError("Google sign-in couldn't load. Check the connection and try again."))
      }
      document.head.appendChild(script)
    })
  }
  return scriptLoad
}

// Call from a click handler without awaiting anything first, or the browser blocks the popup.
export function requestToken(): Promise<string> {
  const google = window.google
  if (google === undefined) {
    void preloadGoogleSignIn().catch(() => {})
    return Promise.reject(new GoogleSignInError('Google sign-in is still loading. Try again in a moment.'))
  }
  if (tokenClient === null) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId(),
      scope: PROFILE_SCOPE,
      callback: (response) => finish(response),
      error_callback: (error) => fail(new GoogleSignInError(`Google sign-in didn't finish (${error.type ?? 'closed'}). Try again.`)),
    })
  }
  return new Promise<string>((resolve, reject) => {
    pending?.reject(new GoogleSignInError('Google sign-in was started again.'))
    pending = { resolve, reject }
    tokenClient?.requestAccessToken({ prompt: accessToken === '' ? 'select_account' : '' })
  })
}

export function forgetToken(): void {
  const token = accessToken
  accessToken = ''
  if (token !== '') {
    window.google?.accounts.oauth2.revoke(token)
  }
}

function finish(response: TokenResponse): void {
  if (response.access_token === undefined || response.error !== undefined) {
    fail(new GoogleSignInError(response.error_description ?? "Google didn't finish signing you in."))
    return
  }
  accessToken = response.access_token
  pending?.resolve(accessToken)
  pending = null
}

function fail(error: GoogleSignInError): void {
  console.warn('Google sign-in failed', error.message)
  pending?.reject(error)
  pending = null
}
