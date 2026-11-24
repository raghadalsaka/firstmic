<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import HighlightPlayer from '../components/HighlightPlayer.vue'
import { api, ApiError, errorMessage } from '../services/api'
import { formatClock } from '../utils/format'
import {
  CRITERIA,
  CRITERION_LABELS,
  MAX_HIGHLIGHTS,
  MAX_TOTAL,
  parseClock,
  RUBRIC,
  type ClassRecording,
  type Criterion,
  type GradesResponse,
  type Highlight,
} from '../utils/grading'

type HighlightDraft = { start: string; end: string; note: string }

const props = defineProps<{ classId: string; submissionId: string }>()
const router = useRouter()

const className = ref('')
const recording = ref<ClassRecording | null>(null)
const loadError = ref<string | null>(null)
const scores = ref<Record<Criterion, number | null>>({ content: null, organization: null, delivery: null, language: null })
const highlightDrafts = ref<HighlightDraft[]>([])
const comment = ref('')
const saving = ref(false)
const saveError = ref<string | null>(null)

const total = computed(() => CRITERIA.reduce((sum, criterion) => sum + (scores.value[criterion] ?? 0), 0))
const allScored = computed(() => CRITERIA.every((criterion) => scores.value[criterion] !== null))
// The draft rows read back as highlights; a row with a bad time is left out and flagged.
const parsedHighlights = computed(() =>
  highlightDrafts.value.map((draft): Highlight | null => {
    const startMs = parseClock(draft.start)
    const endMs = parseClock(draft.end)
    if (startMs === null || endMs === null || endMs <= startMs || !draft.note.trim()) {
      return null
    }
    return { startMs, endMs, note: draft.note.trim() }
  }),
)
const validHighlights = computed(() => parsedHighlights.value.filter((item): item is Highlight => item !== null))
const highlightsOk = computed(() => parsedHighlights.value.every((item) => item !== null))

onMounted(async () => {
  try {
    const data = await api<GradesResponse>(`/api/teacher/classes/${props.classId}/grades`)
    className.value = data.class.name
    recording.value = data.recordings.find((item) => item.submissionIds.includes(props.submissionId)) ?? null
    if (!recording.value) {
      loadError.value = 'This recording is no longer submitted.'
      return
    }
    const grade = recording.value.grade
    if (grade) {
      scores.value = { ...grade.scores }
      highlightDrafts.value = grade.highlights.map((highlight) => ({
        start: formatClock(highlight.startMs),
        end: formatClock(highlight.endMs),
        note: highlight.note,
      }))
      comment.value = grade.comment ?? ''
    }
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'Class not found.' : 'Could not load the recording.'
  }
})

function addHighlight(): void {
  highlightDrafts.value.push({ start: '', end: '', note: '' })
}

function removeHighlight(index: number): void {
  highlightDrafts.value.splice(index, 1)
}

async function save(): Promise<void> {
  saving.value = true
  saveError.value = null
  try {
    await api(`/api/teacher/classes/${props.classId}/grades`, {
      method: 'PUT',
      body: {
        grades: [
          {
            submissionId: props.submissionId,
            scores: scores.value,
            highlights: validHighlights.value,
            comment: comment.value.trim() || null,
          },
        ],
      },
    })
    await router.push(`/teacher/classes/${props.classId}/grades`)
  } catch (err) {
    saveError.value = errorMessage(err, 'The grade was not saved. Try again.')
  } finally {
    saving.value = false
  }
}

async function removeGrade(): Promise<void> {
  if (!window.confirm('Remove this grade? The recording leaves the ranking until it is graded again.')) {
    return
  }
  saveError.value = null
  try {
    await api(`/api/teacher/classes/${props.classId}/grades/${props.submissionId}`, { method: 'DELETE' })
    await router.push(`/teacher/classes/${props.classId}/grades`)
  } catch (err) {
    saveError.value = errorMessage(err, 'The grade was not removed. Try again.')
  }
}
</script>

<template>
  <main class="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8">
    <RouterLink :to="`/teacher/classes/${classId}/grades`" class="self-start font-semibold text-ink-soft underline underline-offset-4">
      Back to grades
    </RouterLink>

    <p v-if="loadError" class="panel p-6">{{ loadError }}</p>
    <p v-else-if="!recording" class="text-ink-soft">Loading…</p>

    <form v-else class="flex flex-col gap-8" @submit.prevent="save">
      <div>
        <p class="text-ink-soft" dir="auto">{{ className }} · {{ recording.topicTitle ?? 'Topic removed' }}</p>
        <h1 class="font-display text-3xl font-extrabold" dir="auto">{{ recording.names.join(' & ') }}</h1>
      </div>

      <section class="panel flex flex-col gap-3 p-5">
        <h2 class="font-display text-xl font-extrabold">Listen</h2>
        <HighlightPlayer
          :src="`/api/teacher/submissions/${submissionId}/audio`"
          :duration-ms="recording.durationMs"
          :highlights="validHighlights"
          preload="metadata"
        />
      </section>

      <section class="panel flex flex-col gap-5 p-5">
        <h2 class="font-display text-xl font-extrabold">
          Scores <span class="tabular-nums text-ink-soft" data-testid="edit-total">{{ total }}/{{ MAX_TOTAL }}</span>
        </h2>
        <fieldset v-for="criterion in CRITERIA" :key="criterion" class="flex flex-col gap-2">
          <legend class="mb-2 font-bold">{{ CRITERION_LABELS[criterion] }}</legend>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label
              v-for="(text, index) in RUBRIC[criterion]"
              :key="index"
              class="flex cursor-pointer items-start gap-2 rounded-tile border-3 p-2 text-base"
              :class="scores[criterion] === index + 1 ? 'border-ink bg-card' : 'border-rule'"
            >
              <input
                v-model="scores[criterion]"
                type="radio"
                class="mt-1.5 shrink-0"
                :name="criterion"
                :value="index + 1"
                :data-testid="`score-${criterion}-${index + 1}`"
              />
              <span><strong>{{ index + 1 }}</strong> {{ text }}</span>
            </label>
          </div>
        </fieldset>
      </section>

      <section class="panel flex flex-col gap-4 p-5">
        <h2 class="font-display text-xl font-extrabold">Highlights</h2>
        <p class="text-ink-soft">The best moments, played first on the Top 3 page. Times are minutes:seconds, like 0:42.</p>
        <div
          v-for="(draft, index) in highlightDrafts"
          :key="index"
          class="flex flex-col gap-2 rounded-tile border-3 p-3 sm:flex-row sm:items-center"
          :class="parsedHighlights[index] ? 'border-rule' : 'border-bad'"
          data-testid="highlight-row"
        >
          <input v-model="draft.start" class="field-input text-base sm:w-24" placeholder="0:42" aria-label="Start" />
          <input v-model="draft.end" class="field-input text-base sm:w-24" placeholder="0:58" aria-label="End" />
          <input v-model="draft.note" class="field-input flex-1 text-base" maxlength="200" placeholder="What makes it great" aria-label="Note" dir="auto" />
          <button type="button" class="btn btn-small" @click="removeHighlight(index)">Remove</button>
        </div>
        <p v-if="!highlightsOk" class="text-bad">Each highlight needs a start, a later end and a note.</p>
        <button
          type="button"
          class="btn btn-small self-start"
          :disabled="highlightDrafts.length >= MAX_HIGHLIGHTS"
          @click="addHighlight"
        >
          Add Highlight
        </button>
      </section>

      <section class="panel flex flex-col gap-3 p-5">
        <label for="comment" class="font-display text-xl font-extrabold">Comment for you</label>
        <p class="text-ink-soft">Only teachers see this.</p>
        <textarea id="comment" v-model="comment" class="field-input text-base" rows="3" maxlength="1000" dir="auto"></textarea>
      </section>

      <p v-if="saveError" class="alert-bad whitespace-pre-line" role="alert">{{ saveError }}</p>
      <div class="flex flex-wrap gap-3">
        <button class="btn btn-primary" type="submit" :disabled="saving || !allScored || !highlightsOk" data-testid="grade-save">
          {{ saving ? 'Saving…' : 'Save Grade' }}
        </button>
        <button v-if="recording.grade" class="btn" type="button" @click="removeGrade">Remove Grade</button>
      </div>
    </form>
  </main>
</template>
