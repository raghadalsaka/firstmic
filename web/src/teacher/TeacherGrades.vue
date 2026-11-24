<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, ApiError, errorMessage } from '../services/api'
import { formatClock, formatDateTime } from '../utils/format'
import { CRITERIA, CRITERION_LABELS, MAX_TOTAL, type GradesResponse } from '../utils/grading'
import { topPath } from '../utils/slug'

const props = defineProps<{ classId: string }>()

const data = ref<GradesResponse | null>(null)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const copied = ref(false)

const gradedCount = computed(() => data.value?.recordings.filter((recording) => recording.grade !== null).length ?? 0)
const topLink = computed(() =>
  data.value ? `${window.location.origin}${topPath(data.value.class.classToken, data.value.class.name)}` : '',
)

async function load(): Promise<void> {
  try {
    data.value = await api<GradesResponse>(`/api/teacher/classes/${props.classId}/grades`)
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'Class not found.' : 'Could not load the grades.'
  }
}

onMounted(load)

async function setPublished(published: boolean): Promise<void> {
  actionError.value = null
  try {
    const result = await api<{ top3PublishedAt: number | null }>(`/api/teacher/classes/${props.classId}/top3`, {
      method: 'PUT',
      body: { published },
    })
    if (data.value) {
      data.value.class.top3PublishedAt = result.top3PublishedAt
    }
  } catch (err) {
    actionError.value = errorMessage(err, 'That did not work. Try again.')
  }
}

async function copyTopLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(topLink.value)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 2000)
  } catch {
    actionError.value = 'Copy did not work. Select the link and copy it yourself.'
  }
}
</script>

<template>
  <main class="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8">
    <RouterLink :to="`/teacher/classes/${classId}`" class="self-start font-semibold text-ink-soft underline underline-offset-4">
      Back to the class
    </RouterLink>

    <p v-if="loadError" class="panel p-6">{{ loadError }}</p>
    <p v-else-if="!data" class="text-ink-soft">Loading…</p>

    <template v-else>
      <h1 class="font-display text-3xl font-extrabold" dir="auto">Grades: {{ data.class.name }}</h1>
      <p v-if="actionError" class="alert-bad" role="alert">{{ actionError }}</p>

      <section class="panel flex flex-col gap-3 p-5" data-testid="top3-publish">
        <h2 class="font-display text-xl font-extrabold">Top 3 page</h2>
        <template v-if="data.class.top3PublishedAt !== null">
          <p class="font-semibold text-good">Published on {{ formatDateTime(data.class.top3PublishedAt) }}.</p>
          <p class="text-ink-soft">Anyone with this link can play the class's 3 best recordings, highlights first.</p>
          <input class="field-input text-base" :value="decodeURI(topLink)" dir="auto" readonly aria-label="Top 3 link" @focus="($event.target as HTMLInputElement).select()" />
          <div class="flex flex-wrap gap-3">
            <button class="btn btn-primary btn-small" @click="copyTopLink">{{ copied ? 'Copied!' : 'Copy Link' }}</button>
            <a class="btn btn-small" :href="topLink" target="_blank" rel="noopener">Open Page</a>
            <button class="btn btn-small" @click="setPublished(false)">Hide Top 3</button>
          </div>
        </template>
        <template v-else>
          <p class="text-ink-soft">Hidden. Review the grades below, then publish to share the class's 3 best recordings.</p>
          <button class="btn btn-primary btn-small self-start" :disabled="gradedCount === 0" @click="setPublished(true)">
            Publish Top 3
          </button>
        </template>
      </section>

      <section class="panel flex flex-col gap-4 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-extrabold">
            Recordings <span class="text-ink-soft">({{ gradedCount }} of {{ data.recordings.length }} graded)</span>
          </h2>
          <RouterLink :to="`/teacher/classes/${classId}/grades/upload`" class="btn btn-small">Upload Scores</RouterLink>
        </div>
        <p class="text-ink-soft">
          Each recording is scored from 1 to 4 on {{ CRITERIA.map((criterion) => CRITERION_LABELS[criterion]).join(', ') }},
          out of {{ MAX_TOTAL }}. Partners share one score.
        </p>
        <p v-if="data.recordings.length === 0" class="text-ink-soft">No submissions yet.</p>
        <ul class="flex flex-col gap-3">
          <li
            v-for="recording in data.recordings"
            :key="recording.recordingKey"
            class="flex flex-wrap items-center gap-3 rounded-tile border-3 border-rule p-3"
            data-testid="grade-row"
          >
            <span class="w-10 shrink-0 text-center font-display text-xl font-extrabold">
              {{ recording.rank === null ? '–' : `#${recording.rank}` }}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block font-bold" dir="auto">{{ recording.names.join(' & ') }}</span>
              <span class="block text-base text-ink-soft" dir="auto">
                {{ recording.topicTitle ?? 'Topic removed' }}{{ recording.durationMs === null ? '' : ` · ${formatClock(recording.durationMs)}` }}
              </span>
            </span>
            <span class="font-display text-xl font-extrabold tabular-nums" data-testid="grade-total">
              {{ recording.grade ? `${recording.grade.total}/${MAX_TOTAL}` : 'Not graded' }}
            </span>
            <RouterLink :to="`/teacher/classes/${classId}/grades/${recording.submissionIds[0]}`" class="btn btn-small">
              {{ recording.grade ? 'Edit' : 'Grade' }}
            </RouterLink>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>
