<script setup lang="ts">
import { computed, provide, watch } from 'vue'
import { useRoute } from 'vue-router'
import LandingScreen from './components/LandingScreen.vue'
import LoginScreen from './components/LoginScreen.vue'
import { authKey, useAuth } from './composables/useAuth'

const route = useRoute()
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
</script>

<template>
  <template v-if="needsTeacher">
    <p v-if="auth.state.value === 'unknown'" class="p-8 text-xl" role="status">Loading…</p>
    <LandingScreen v-else-if="auth.state.value === 'signed-out' && route.name === 'home'" />
    <LoginScreen v-else-if="auth.state.value === 'signed-out'" />
    <RouterView v-else />
  </template>
  <RouterView v-else />
</template>
