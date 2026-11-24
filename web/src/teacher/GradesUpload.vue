<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, ApiError, errorMessage } from '../services/api'
import { formatClock } from '../utils/format'
import { MAX_TOTAL, parseGradesFile, totalOf, type GradeInput, type GradesResponse } from '../utils/grading'

const props = defineProps<{ classId: string }>()
const router = useRouter()

const data = ref<GradesResponse | null>(null)
const loadError = ref<string | null>(null)
const fileName = ref('')
const grades = ref<GradeInput[]>([])
const problems = ref<string[]>([])
const saving = ref(false)
const saveError = ref<string | null>(null)

const EXAMPLE = `{
  "grades": [
    {
      "submissionId": "abc123",
      "scores": { "content": 4, "organization": 3, "delivery": 3, "language": 4 },
      "highlights": [{ "startMs": 42000, "endMs": 58000, "note": "Explains where her name comes from" }],
      "comment": "Lovely story about her grandmother."
    }
  ]
}`

const recordingsBySubmission = computed(
  () => new Map((data.value?.recordings ?? []).flatMap((recording) => recording.submissionIds.map((id) => [id, recording]))),
)
const preview = computed(() =>
  grades.value.map((grade) => ({ grade, recording: recordingsBySubmission.value.get(grade.submissionId) ?? null })),
)
const unmatched = computed(() => preview.value.filter((row) => row.recording === null).length)
const replacing = computed(() => preview.value.filter((row) => row.recording?.grade).length)

onMounted(async () => {
  try {
    data.value = await api<GradesResponse>(`/api/teacher/classes/${props.classId}/grades`)
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'Class not found.' : 'Could not load the class.'
  }
})

async function pickFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  saveError.value = null
  if (!file) {
    return
  }
  fileName.value = file.name
  const parsed = parseGradesFile(await file.text())
  grades.value = parsed.grades
  problems.value = parsed.problems
}

async function upload(): Promise<void> {
  saving.value = true
  saveError.value = null
  try {
    await api(`/api/teacher/classes/${props.classId}/grades`, { method: 'PUT', body: { grades: grades.value } })
    await router.push(`/teacher/classes/${props.classId}/grades`)
  } catch (err) {
    saveError.value = errorMessage(err, 'The scores were not saved. Try again.')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <main class="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8">
    <RouterLink :to="`/teacher/classes/${classId}/grades`" class="self-start font-semibold text-ink-soft underline underline-offset-4">
      Back to grades
    </RouterLink>

    <p v-if="loadError" class="panel p-6">{{ loadError }}</p>
    <p v-else-if="!data" class="text-ink-soft">Loading…</p>

    <template v-else>
      <h1 class="font-display text-3xl font-extrabold" dir="auto">Upload scores: {{ data.class.name }}</h1>

      <section class="panel flex flex-col gap-3 p-5">
        <h2 class="font-display text-xl font-extrabold">Grades file</h2>
        <p class="text-ink-soft">Pick the grades file. You'll see who it matches before anything is saved.</p>
        <label class="btn btn-primary btn-small self-start">
          Choose File
          <input type="file" accept=".json,application/json" class="sr-only" data-testid="grades-file" @change="pickFile" />
        </label>
        <p v-if="fileName" class="text-ink-soft" dir="auto">{{ fileName }}</p>
        <details class="rounded-tile border-3 border-rule px-3">
          <summary class="flex min-h-10 cursor-pointer items-center font-semibold">File format</summary>
          <p class="text-base text-ink-soft">
            Scores are whole numbers from 1 to 4. Highlight times are in milliseconds from the start of the recording.
          </p>
          <pre class="overflow-x-auto pb-3 text-sm">{{ EXAMPLE }}</pre>
        </details>
      </section>

      <section v-if="fileName" class="panel flex flex-col gap-4 p-5" data-testid="grades-preview">
        <h2 class="font-display text-xl font-extrabold">Check before saving</h2>
        <ul v-if="problems.length > 0" class="alert-bad flex flex-col gap-1" role="alert">
          <li v-for="problem in problems" :key="problem">{{ problem }}</li>
        </ul>
        <p v-if="unmatched > 0" class="alert-bad" role="alert">
          {{ unmatched }} grade{{ unmatched === 1 ? '' : 's' }} match no submitted recording in this class. Fix the file first.
        </p>
        <p v-if="replacing > 0" class="text-ink-soft">
          {{ replacing }} recording{{ replacing === 1 ? ' already has a grade' : 's already have grades' }}, which will be replaced.
        </p>
        <ul class="flex flex-col gap-2">
          <li
            v-for="row in preview"
            :key="row.grade.submissionId"
            class="flex flex-wrap items-center gap-3 rounded-tile border-3 p-3"
            :class="row.recording ? 'border-rule' : 'border-bad'"
          >
            <span class="min-w-0 flex-1">
              <span class="block font-bold" dir="auto">{{ row.recording ? row.recording.names.join(' & ') : row.grade.submissionId }}</span>
              <span class="block text-base text-ink-soft" dir="auto">
                {{ row.recording ? row.recording.topicTitle ?? 'Topic removed' : 'Not found in this class' }}
                · {{ row.grade.highlights.length }} highlight{{ row.grade.highlights.length === 1 ? '' : 's' }}
                <template v-if="row.grade.highlights[0]">from {{ formatClock(row.grade.highlights[0].startMs) }}</template>
              </span>
            </span>
            <span class="font-display text-xl font-extrabold tabular-nums">{{ totalOf(row.grade.scores) }}/{{ MAX_TOTAL }}</span>
          </li>
        </ul>
        <p v-if="saveError" class="alert-bad whitespace-pre-line" role="alert">{{ saveError }}</p>
        <button
          class="btn btn-primary self-start"
          :disabled="saving || grades.length === 0 || problems.length > 0 || unmatched > 0"
          data-testid="grades-save"
          @click="upload"
        >
          {{ saving ? 'Saving…' : `Save ${grades.length} Grade${grades.length === 1 ? '' : 's'}` }}
        </button>
      </section>
    </template>
  </main>
</template>
