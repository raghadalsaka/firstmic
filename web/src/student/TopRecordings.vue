<script setup lang="ts">
import { onMounted, ref } from 'vue'
import HighlightPlayer from '../components/HighlightPlayer.vue'
import { api, ApiError } from '../services/api'
import { MAX_TOTAL, type Highlight } from '../utils/grading'
import { classPath } from '../utils/slug'

type TopRecording = {
  rank: number
  submissionId: string
  names: string[]
  topicTitle: string | null
  durationMs: number | null
  total: number
  highlights: Highlight[]
}
type TopResponse = { className: string; published: boolean; recordings: TopRecording[] }

const RANK_LABELS = ['1st', '2nd', '3rd']

const props = defineProps<{ classToken: string }>()

const data = ref<TopResponse | null>(null)
const loadError = ref<'not-found' | 'offline' | null>(null)

onMounted(async () => {
  try {
    data.value = await api<TopResponse>(`/api/class/${props.classToken}/top3`)
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'not-found' : 'offline'
  }
})
</script>

<template>
  <main class="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:max-w-4xl">
    <header class="flex items-center justify-between gap-3">
      <RouterLink to="/" class="font-display text-xl font-extrabold">First Mic</RouterLink>
      <RouterLink
        v-if="data"
        :to="classPath(classToken, data.className)"
        class="truncate text-ink-soft underline underline-offset-4"
        dir="auto"
      >
        {{ data.className }}
      </RouterLink>
    </header>

    <div v-if="loadError === 'not-found'" class="panel p-6 text-center">
      <h1 class="font-display text-2xl font-extrabold">This link doesn't work</h1>
      <p class="mt-2 text-ink-soft">Ask your teacher for the class link.</p>
    </div>

    <div v-else-if="loadError === 'offline'" class="panel p-6 text-center">
      <h1 class="font-display text-2xl font-extrabold">Can't reach First Mic</h1>
      <p class="mt-2 text-ink-soft">Check your internet, then reload this page.</p>
    </div>

    <p v-else-if="!data" class="text-center text-lg text-ink-soft">Loading…</p>

    <div v-else-if="!data.published || data.recordings.length === 0" class="panel p-6 text-center">
      <h1 class="font-display text-2xl font-extrabold">Top 3 coming soon</h1>
      <p class="mt-2 text-ink-soft">Your teacher hasn't shared the best recordings yet.</p>
    </div>

    <template v-else>
      <div class="text-center">
        <p class="text-ink-soft" dir="auto">{{ data.className }}</p>
        <h1 class="font-display text-4xl font-extrabold">Top 3 Podcasts</h1>
      </div>
      <ol class="grid gap-5 lg:grid-cols-3 lg:items-start">
        <li
          v-for="recording in data.recordings"
          :key="recording.submissionId"
          class="panel flex flex-col gap-4 p-5"
          data-testid="top-recording"
        >
          <div class="flex items-start justify-between gap-3">
            <span class="font-display text-3xl font-extrabold text-rec">{{ RANK_LABELS[recording.rank - 1] }}</span>
            <span class="font-display text-xl font-extrabold tabular-nums">{{ recording.total }}/{{ MAX_TOTAL }}</span>
          </div>
          <div>
            <h2 class="font-display text-2xl font-extrabold" dir="auto">{{ recording.names.join(' & ') }}</h2>
            <p class="text-ink-soft" dir="auto">{{ recording.topicTitle }}</p>
          </div>
          <HighlightPlayer
            :src="`/api/class/${classToken}/top3/${recording.submissionId}/audio`"
            :duration-ms="recording.durationMs"
            :highlights="recording.highlights"
          />
        </li>
      </ol>
    </template>
  </main>
</template>
