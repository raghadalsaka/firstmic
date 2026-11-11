export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onSignedOut: () => void = () => {}

/** Teacher requests ride the session cookie; a 401 on one means the session ended, so the app shows sign-in again. */
export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`
  }
  const res = await fetch(path, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  })
  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !options.token) {
      onSignedOut()
    }
    const message = (data as { error?: unknown }).error
    throw new ApiError(res.status, typeof message === 'string' ? message : `Request failed (${res.status})`)
  }
  return data as T
}

/** The server's message for an API error, or the fallback for anything else (offline, aborted, a bug). */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}
