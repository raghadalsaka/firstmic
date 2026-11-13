<script setup lang="ts">
import { computed, provide, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LandingScreen from './components/LandingScreen.vue'
import { authKey, useAuth } from './composables/useAuth'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
provide(authKey, auth)

const needsTeacher = computed(() => route.meta.teacher === true)

watch(
  needsTeacher,
  (needed) => {
    if (needed && auth.state.value === 'unknown') {
      void auth.check()
    }
  },
  { immediate: true },
)

const signedOut = computed(() => auth.state.value === 'signed-out')
const onSignIn = computed(() => route.name === 'teacher-sign-in')

// The sign-in page is the only way in: signed out, any other teacher page goes to the public home page,
// and once signed in the sign-in page goes to the class list.
watch(
  [needsTeacher, () => auth.state.value, onSignIn],
  ([needed, state, signIn]) => {
    const strayWhileSignedOut = needed && state === 'signed-out' && !signIn && route.name !== 'home'
    if (strayWhileSignedOut || (signIn && state === 'signed-in')) {
      void router.replace({ name: 'home' })
    }
  },
  { immediate: true },
)
</script>

<template>
  <template v-if="needsTeacher">
    <p v-if="auth.state.value === 'unknown'" class="p-8 text-xl" role="status">Loading…</p>
    <LandingScreen v-else-if="signedOut && route.name === 'home'" />
    <RouterView v-else-if="!signedOut || onSignIn" />
  </template>
  <RouterView v-else />
</template>
