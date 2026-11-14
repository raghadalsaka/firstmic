<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AudioPlayer from '../components/AudioPlayer.vue'
import { api, ApiError, errorMessage, fetchAudio } from '../services/api'
import type { MyRecording, MyRecordings } from '../types/recordings'
import { formatClock, formatDateTime } from '../utils/format'

const props = defineProps<{ classToken: string; studentToken: string }>()
const emit = defineEmits<{ recordAnother: []; signedOut: [] }>()

const data = ref<MyRecordings | null>(null)
const loadFailed = ref(false)
const actionError = ref('')
const busyId = ref<string | null>(null)
const audioUrls = ref<Record<string, string>>({})

const base = computed(() => `/api/class/${encodeURIComponent(props.classToken)}/recordings`)
const closed = computed(() => data.value?.open === false)
const submitted = computed(() => data.value?.recordings.find((item) => item.id === data.value?.submittedId) ?? null)

function describe(item: MyRecording): string {
  const parts = [item.withNames ? `With ${item.withNames}` : 'On your own', formatDateTime(item.savedAt)]
  return (item.durationMs === null ? parts : [...parts, formatClock(item.durationMs)]).join(' · ')
}

function failed(err: unknown, fallback: string): void {
  if (err instanceof ApiError && err.status === 401) {
    emit('signedOut')
    return
  }
  actionError.value = errorMessage(err, fallback)
}

async function load(): Promise<void> {
  try {
    data.value = await api<MyRecordings>(base.value, { token: props.studentToken })
  } catch (err) {
    loadFailed.value = true
    failed(err, "Couldn't load your recordings. Check your internet and try again.")
  }
}

async function listen(item: MyRecording): Promise<void> {
  busyId.value = item.id
  actionError.value = ''
  try {
    const blob = await fetchAudio(`${base.value}/${item.id}/audio`, props.studentToken)
    audioUrls.value = { ...audioUrls.value, [item.id]: URL.createObjectURL(blob) }
  } catch (err) {
    failed(err, "That recording didn't load. Try again.")
  } finally {
    busyId.value = null
  }
}

async function submit(item: MyRecording): Promise<void> {
  busyId.value = item.id
  actionError.value = ''
  try {
    await api(`${base.value}/${item.id}/submit`, { token: props.studentToken, body: {} })
    await load()
  } catch (err) {
    failed(err, "Couldn't submit. Check your internet and try again.")
  } finally {
    busyId.value = null
  }
}

async function remove(item: MyRecording): Promise<void> {
  if (!window.confirm(`Delete your recording of "${item.topicTitle ?? 'this topic'}"? This can't be undone.`)) {
    return
  }
  busyId.value = item.id
  actionError.value = ''
  try {
    await api(`${base.value}/${item.id}`, { method: 'DELETE', token: props.studentToken })
    await load()
  } catch (err) {
    failed(err, "Couldn't delete it. Check your internet and try again.")
  } finally {
    busyId.value = null
  }
}

onMounted(load)
onUnmounted(() => Object.values(audioUrls.value).forEach((url) => URL.revokeObjectURL(url)))
</script>

<template>
  <section class="flex flex-col gap-5" data-testid="my-recordings">
    <h1 class="font-display text-3xl font-extrabold">My Recordings</h1>

    <p v-if="loadFailed" class="alert-bad" role="alert">Couldn't load your recordings. Check your internet and try again.</p>
    <p v-else-if="!data" class="text-ink-soft">Loading…</p>

    <template v-else>
      <div class="panel flex flex-col gap-1 p-4" data-testid="submission-status">
        <p v-if="submitted" class="text-lg font-bold text-good">
          ✓ You submitted "{{ submitted.topicTitle ?? 'a topic' }}" to your teacher.
        </p>
        <p v-else class="text-lg font-bold">You haven't submitted a recording yet.</p>
        <p v-if="data.deadline !== null && closed" class="text-ink-soft">
          The deadline was {{ formatDateTime(data.deadline) }}, so your submission can't change now.
        </p>
        <p v-else-if="data.deadline !== null" class="text-ink-soft">
          Submit one recording by {{ formatDateTime(data.deadline) }}. You can change it until then.
        </p>
        <p v-else class="text-ink-soft">Pick the one you like best and submit it. You can change it later.</p>
      </div>

      <p v-if="actionError" class="alert-bad" role="alert">{{ actionError }}</p>

      <p v-if="data.recordings.length === 0" class="panel p-6 text-center text-ink-soft">
        No recordings yet. Pick a topic and record one.
      </p>

      <div class="grid gap-5 lg:grid-cols-2 lg:items-start">
        <article
          v-for="item in data.recordings"
          :key="item.id"
          class="flex flex-col gap-3 rounded-tile border-3 p-4"
          :class="item.id === data.submittedId ? 'border-good' : 'border-rule'"
          data-testid="my-recording"
        >
          <div class="flex items-start justify-between gap-3">
            <h2 class="font-display text-xl font-extrabold" dir="auto">{{ item.topicTitle ?? 'Topic removed' }}</h2>
            <span
              v-if="item.id === data.submittedId"
              class="shrink-0 rounded-full bg-good-soft px-3 py-0.5 text-base font-bold text-good"
            >
              ✓ Submitted
            </span>
          </div>
          <p class="text-ink-soft" dir="auto">{{ describe(item) }}</p>
          <AudioPlayer v-if="audioUrls[item.id]" :src="audioUrls[item.id] ?? ''" :duration-ms="item.durationMs" />
          <div class="flex flex-wrap gap-3">
            <button v-if="!audioUrls[item.id]" class="btn btn-small" :disabled="busyId === item.id" @click="listen(item)">
              Listen
            </button>
            <button
              v-if="item.id !== data.submittedId && !closed"
              class="btn btn-good btn-small"
              :disabled="busyId === item.id"
              @click="submit(item)"
            >
              Submit to Teacher
            </button>
            <button v-if="item.id !== data.submittedId" class="btn btn-small" :disabled="busyId === item.id" @click="remove(item)">
              Delete
            </button>
          </div>
        </article>
      </div>
    </template>

    <button class="btn btn-primary btn-large" @click="emit('recordAnother')">Record Another</button>
  </section>
</template>
