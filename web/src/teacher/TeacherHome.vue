<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { injectAuth } from '../composables/useAuth'
import { api, errorMessage } from '../services/api'

type ClassSummary = { id: string; name: string; topic_count: number; submission_count: number }

const auth = injectAuth()
const router = useRouter()
const classes = ref<ClassSummary[] | null>(null)
const newName = ref('')
const error = ref<string | null>(null)

async function load(): Promise<void> {
  classes.value = (await api<{ classes: ClassSummary[] }>('/api/teacher/classes')).classes
}

onMounted(load)

async function createClass(): Promise<void> {
  error.value = null
  try {
    const created = await api<{ class: { id: string } }>('/api/teacher/classes', { body: { name: newName.value } })
    await router.push(`/teacher/classes/${created.class.id}`)
  } catch (err) {
    error.value = errorMessage(err, 'Could not create the class.')
  }
}
</script>

<template>
  <main class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="font-display text-2xl font-extrabold">First Mic</p>
        <h1 class="font-display text-4xl font-extrabold">Your classes</h1>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <span v-if="auth.teacher.value" class="text-base text-ink-soft">{{ auth.teacher.value.name }}</span>
        <button type="button" class="btn btn-small" @click="auth.logout()">Sign Out</button>
      </div>
    </header>

    <form class="panel flex flex-col gap-3 p-5 sm:flex-row sm:items-end" @submit.prevent="createClass">
      <label class="flex flex-1 flex-col gap-1 font-semibold">
        New class
        <input v-model="newName" class="field-input" placeholder="Room 12B" maxlength="120" required />
      </label>
      <button class="btn btn-primary" type="submit" :disabled="!newName.trim()">Create Class</button>
    </form>
    <p v-if="error" class="alert-bad" role="alert">{{ error }}</p>

    <p v-if="classes === null" class="text-ink-soft">Loading…</p>
    <p v-else-if="classes.length === 0" class="text-ink-soft">No classes yet. Create one above.</p>
    <ul v-else class="flex flex-col gap-3">
      <li v-for="item in classes" :key="item.id">
        <RouterLink :to="`/teacher/classes/${item.id}`" class="btn w-full justify-between">
          <span>{{ item.name }}</span>
          <span class="text-base font-semibold text-ink-soft">
            {{ item.topic_count }} topics · {{ item.submission_count }} recordings
          </span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>
