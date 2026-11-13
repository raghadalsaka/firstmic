<script setup lang="ts">
import { onMounted } from 'vue'
import { injectAuth } from '../composables/useAuth'
import { googleSignIn, preloadGoogleSignIn } from '../services/googleAuth'
import CreatorCredit from './CreatorCredit.vue'

const auth = injectAuth()

onMounted(() => {
  void preloadGoogleSignIn().catch(() => {})
})
</script>

<template>
  <!-- The teacher sign-in page (/teacher/sign-in). Nothing in the app links here; teachers keep the link. -->
  <main class="mx-auto grid min-h-svh max-w-lg content-center px-4 py-12">
    <!-- Google sign-in opens its popup inside this submit, so nothing is awaited before auth.login. -->
    <form v-if="googleSignIn" class="panel grid justify-items-center gap-5 p-8 text-center" @submit.prevent="auth.login()">
      <div>
        <p class="font-display text-xl font-extrabold">First Mic</p>
        <h1 class="font-display text-4xl leading-tight font-extrabold">Teacher sign in</h1>
      </div>
      <p class="text-lg">Sign in with your Google account to see your classes and recordings.</p>
      <p v-if="auth.error.value !== ''" role="alert" class="alert-bad w-full">{{ auth.error.value }}</p>
      <button type="submit" class="btn btn-primary btn-large" :disabled="auth.busy.value">
        {{ auth.busy.value ? 'Signing In…' : 'Sign In with Google' }}
      </button>
      <CreatorCredit />
    </form>
    <section v-else class="panel grid gap-5 p-8 text-center">
      <div>
        <p class="font-display text-xl font-extrabold">First Mic</p>
        <h1 class="font-display text-4xl leading-tight font-extrabold">Teacher sign-in isn't set up</h1>
      </div>
      <p class="text-lg">This copy of First Mic was built without a Google client ID, so teachers can't sign in yet.</p>
    </section>
  </main>
</template>
