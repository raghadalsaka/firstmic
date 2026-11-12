/** Microphone settings for every recording, solo or with a partner. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

export type WakeLock = { release(): Promise<void> }

/** Keeps the screen on while recording, where the browser allows it. */
export async function requestWakeLock(): Promise<WakeLock | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } }
    return (await nav.wakeLock?.request('screen')) ?? null
  } catch {
    return null
  }
}
