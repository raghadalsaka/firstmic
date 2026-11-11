// Same shape as QuestRush's src/composables/useAuth.ts: App provides it, screens inject it.
import { inject, readonly, ref, type InjectionKey } from 'vue'
import { api, errorMessage, setSignedOutHandler } from '../services/api'
import { forgetToken, GoogleSignInError, requestToken } from '../services/googleAuth'

export type AuthState = 'unknown' | 'signed-out' | 'signed-in'

export type Teacher = { id: string; email: string; name: string }

function signInError(caught: unknown): string {
  return caught instanceof GoogleSignInError ? caught.message : errorMessage(caught, "Couldn't sign you in. Try again.")
}

export function useAuth() {
  const state = ref<AuthState>('unknown')
  const teacher = ref<Teacher | null>(null)
  const error = ref('')
  const busy = ref(false)

  function signedOut(): void {
    teacher.value = null
    state.value = 'signed-out'
  }

  setSignedOutHandler(signedOut)

  async function check(): Promise<void> {
    try {
      const response = await api<{ user: Teacher | null }>('/api/auth/me')
      teacher.value = response.user
      state.value = response.user ? 'signed-in' : 'signed-out'
      error.value = ''
    } catch (caught) {
      error.value = errorMessage(caught, "Couldn't check whether you're signed in. Try again.")
      signedOut()
    }
  }

  // requestToken comes first because Google's popup only opens inside the click.
  async function login(): Promise<void> {
    if (busy.value) {
      return
    }
    busy.value = true
    error.value = ''
    try {
      const accessToken = await requestToken()
      const response = await api<{ user: Teacher }>('/api/auth/google', { body: { accessToken } })
      teacher.value = response.user
      state.value = 'signed-in'
    } catch (caught) {
      error.value = signInError(caught)
    } finally {
      busy.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch (caught) {
      console.error('Sign out failed', caught)
    }
    forgetToken()
    signedOut()
  }

  return {
    state: readonly(state),
    teacher: readonly(teacher),
    error: readonly(error),
    busy: readonly(busy),
    check,
    login,
    logout,
  }
}

export type Auth = ReturnType<typeof useAuth>

export const authKey: InjectionKey<Auth> = Symbol('auth')

export function injectAuth(): Auth {
  const auth = inject(authKey)
  if (auth === undefined) {
    throw new Error('injectAuth() must be used below App, which provides authKey.')
  }
  return auth
}
