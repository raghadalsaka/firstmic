<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AudioPlayer from '../components/AudioPlayer.vue'
import StudentBadge from '../components/StudentBadge.vue'
import { api, ApiError, errorMessage } from '../services/api'
import type { RosterStudent } from '../types/roster'
import { formatClock, formatDateTime } from '../utils/format'
import { MAX_GUIDE_SECTION_LENGTH } from '../config'
import { GUIDE_KEYS, GUIDE_LABELS, hasGuide, type TopicGuide } from '../utils/guide'
import { classPath } from '../utils/slug'
import StudentsPanel from './StudentsPanel.vue'

type Topic = { id: string; title: string; active: number; sort: number; guide: TopicGuide }
type GuideDraft = Record<keyof TopicGuide, string>
type Submission = {
  id: string
  version: number
  duration_ms: number | null
  submitted_at: number
  with_names: string | null
  student_name: string
  student_id: string | null
  topic_id: string | null
  topic_title: string | null
}
type ClassDetail = {
  class: { id: string; name: string; classToken: string; deadline: number | null; submissionsOpen: boolean }
  topics: Topic[]
  students: RosterStudent[]
  submissions: Submission[]
}

const props = defineProps<{ classId: string }>()
const router = useRouter()

const detail = ref<ClassDetail | null>(null)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const copied = ref(false)
const topicDraft = ref('')
const editingId = ref<string | null>(null)
const topicInput = ref<HTMLInputElement | null>(null)
const topicFilter = ref('')
const guideDraft = ref<GuideDraft>(blankGuideDraft())
const guideOpen = ref(false)

const GUIDE_HINTS: Record<keyof TopicGuide, string> = {
  prompt: 'Shown to everyone: the questions to answer.',
  solo: 'Shown when a student records on their own.',
  partner: 'Shown to both partners when they record together.',
  language: 'Shown to everyone: words or grammar to try.',
}
const deadlineDraft = ref('')

const classLink = computed(() =>
  detail.value ? `${window.location.origin}${classPath(detail.value.class.classToken, detail.value.class.name)}` : '',
)
const classLinkShown = computed(() => decodeURI(classLink.value))
// Recordings carry only the student's id; the badge comes from the roster so each photo is sent once.
const studentsById = computed(() => new Map((detail.value?.students ?? []).map((student) => [student.id, student])))
const visibleSubmissions = computed(() => {
  const students = studentsById.value
  return (detail.value?.submissions ?? [])
    .filter((item) => !topicFilter.value || item.topic_id === topicFilter.value)
    .map((item) => ({ ...item, student: item.student_id ? students.get(item.student_id) : undefined }))
})

// Students who haven't submitted a recording yet, in roster order.
const notSubmitted = computed(() => {
  const submitted = new Set((detail.value?.submissions ?? []).map((item) => item.student_id))
  return (detail.value?.students ?? []).filter((student) => !submitted.has(student.id))
})
const deadlinePassed = computed(() => detail.value?.class.submissionsOpen === false)

/** "2026-11-20T15:00" in the teacher's own time zone, as a datetime-local input expects. */
function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function blankGuideDraft(guide?: TopicGuide): GuideDraft {
  return Object.fromEntries(GUIDE_KEYS.map((key) => [key, guide?.[key] ?? ''])) as GuideDraft
}

async function load(): Promise<void> {
  try {
    detail.value = await api<ClassDetail>(`/api/teacher/classes/${props.classId}`)
    const deadline = detail.value.class.deadline
    deadlineDraft.value = deadline === null ? '' : toLocalInput(deadline)
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'Class not found.' : 'Could not load the class.'
  }
}

onMounted(load)

async function run(action: () => Promise<unknown>): Promise<void> {
  actionError.value = null
  try {
    await action()
    await load()
  } catch (err) {
    actionError.value = errorMessage(err, 'That did not work. Try again.')
  }
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(classLink.value)
    copied.value = true
    window.setTimeout(() => (copied.value = false), 2000)
  } catch {
    actionError.value = 'Copy did not work. Select the link and copy it yourself.'
  }
}

function rotateLink(): void {
  if (!window.confirm('Make a new class link? The old link stops working for everyone.')) {
    return
  }
  void run(() => api(`/api/teacher/classes/${props.classId}/class-link`, { method: 'POST' }))
}

/** One form adds a topic, or saves the one picked with Edit; an empty guide box clears that section. */
function saveTopic(): void {
  const title = topicDraft.value.trim()
  if (!title) {
    return
  }
  const id = editingId.value
  const guide = { ...guideDraft.value }
  void run(async () => {
    if (id === null) {
      await api(`/api/teacher/classes/${props.classId}/topics`, { body: { title, guide } })
    } else {
      await api(`/api/teacher/topics/${id}`, { method: 'PATCH', body: { title, guide } })
    }
    cancelEdit()
  })
}

function startEdit(topic: Topic): void {
  editingId.value = topic.id
  topicDraft.value = topic.title
  guideDraft.value = blankGuideDraft(topic.guide)
  guideOpen.value = hasGuide(topic.guide)
  topicInput.value?.focus()
}

function cancelEdit(): void {
  editingId.value = null
  topicDraft.value = ''
  guideDraft.value = blankGuideDraft()
  guideOpen.value = false
}

function toggleTopic(topic: Topic): void {
  void run(() => api(`/api/teacher/topics/${topic.id}`, { method: 'PATCH', body: { active: topic.active === 0 } }))
}

function moveTopic(index: number, offset: -1 | 1): void {
  const topics = [...(detail.value?.topics ?? [])]
  const target = index + offset
  const moving = topics[index]
  const other = topics[target]
  if (!moving || !other) {
    return
  }
  topics[index] = other
  topics[target] = moving
  void run(() =>
    api(`/api/teacher/classes/${props.classId}/topic-order`, {
      method: 'PUT',
      body: { topicIds: topics.map((topic) => topic.id) },
    }),
  )
}

function deleteTopic(topic: Topic): void {
  const recordings = detail.value?.submissions.filter((item) => item.topic_id === topic.id).length ?? 0
  const warning =
    recordings === 0
      ? 'No recordings have been sent for it yet.'
      : `All ${recordings} recording${recordings === 1 ? '' : 's'} sent for this topic will be deleted too.`
  if (!window.confirm(`Delete the topic "${topic.title}"? ${warning} This can't be undone.`)) {
    return
  }
  void run(() => api(`/api/teacher/topics/${topic.id}`, { method: 'DELETE' }))
}

async function deleteClass(name: string): Promise<void> {
  const message =
    `Delete the class "${name}"? Its topics, students, PINs and every recording will be deleted, ` +
    "and the class link stops working. This can't be undone."
  if (!window.confirm(message)) {
    return
  }
  actionError.value = null
  try {
    await api(`/api/teacher/classes/${props.classId}`, { method: 'DELETE' })
    await router.push('/')
  } catch (err) {
    actionError.value = errorMessage(err, 'The class was not deleted. Try again.')
  }
}

function saveDeadline(deadline: number | null): void {
  void run(() => api(`/api/teacher/classes/${props.classId}/deadline`, { method: 'PUT', body: { deadline } }))
}

function setDeadline(): void {
  const deadline = new Date(deadlineDraft.value).getTime()
  if (Number.isNaN(deadline)) {
    actionError.value = 'Pick a date and time for the deadline.'
    return
  }
  saveDeadline(deadline)
}

function deleteSubmission(item: Submission): void {
  if (!window.confirm(`Delete ${item.student_name}'s submitted recording? They can submit another. This can't be undone.`)) {
    return
  }
  void run(() => api(`/api/teacher/submissions/${item.id}`, { method: 'DELETE' }))
}
</script>

<template>
  <main class="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8">
    <RouterLink to="/" class="self-start font-semibold text-ink-soft underline underline-offset-4">
      All classes
    </RouterLink>

    <p v-if="loadError" class="panel p-6">{{ loadError }}</p>
    <p v-else-if="!detail" class="text-ink-soft">Loading…</p>

    <template v-else>
      <h1 class="font-display text-3xl font-extrabold">{{ detail.class.name }}</h1>
      <p v-if="actionError" class="alert-bad" role="alert">
        {{ actionError }}
      </p>

      <section class="panel flex flex-col gap-3 p-5">
        <h2 class="font-display text-xl font-extrabold">Class link</h2>
        <p class="text-ink-soft">Students find the class on the home page, or you can share this link. They need their PIN to record.</p>
        <input class="field-input text-base" :value="classLinkShown" dir="auto" readonly aria-label="Class link" @focus="($event.target as HTMLInputElement).select()" />
        <div class="flex flex-wrap gap-3">
          <button class="btn btn-primary btn-small" @click="copyLink">{{ copied ? 'Copied!' : 'Copy Link' }}</button>
          <button class="btn btn-small" @click="rotateLink">New Link</button>
        </div>
      </section>

      <section class="panel flex flex-col gap-4 p-5">
        <h2 class="font-display text-xl font-extrabold">Topics</h2>
        <form class="flex flex-col gap-3" @submit.prevent="saveTopic">
          <input
            ref="topicInput"
            v-model="topicDraft"
            class="field-input"
            placeholder="New topic, e.g. My favourite animal"
            maxlength="200"
            dir="auto"
            :aria-label="editingId === null ? 'New topic' : 'Topic title'"
          />
          <details
            class="rounded-tile border-3 border-rule px-3"
            :open="guideOpen"
            @toggle="guideOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary class="flex min-h-10 cursor-pointer items-center font-semibold">Podcast Guide (optional)</summary>
            <div class="flex flex-col gap-4 pb-3">
              <p class="text-base text-ink-soft">Students can open it under the topic title. Leave a box empty to leave it out.</p>
              <div class="grid gap-4 lg:grid-cols-2">
                <label v-for="key in GUIDE_KEYS" :key="key" class="flex flex-col gap-1 font-semibold">
                  {{ GUIDE_LABELS[key] }}
                  <span class="text-base font-normal text-ink-soft">{{ GUIDE_HINTS[key] }}</span>
                  <textarea
                    v-model="guideDraft[key]"
                    class="field-input text-base"
                    rows="3"
                    :maxlength="MAX_GUIDE_SECTION_LENGTH"
                    dir="auto"
                    :data-testid="`guide-input-${key}`"
                  ></textarea>
                </label>
              </div>
            </div>
          </details>
          <div class="flex flex-wrap gap-3">
            <button class="btn btn-primary btn-small" type="submit" :disabled="!topicDraft.trim()">
              {{ editingId === null ? 'Add Topic' : 'Edit Topic' }}
            </button>
            <button v-if="editingId !== null" class="btn btn-small" type="button" @click="cancelEdit">Cancel</button>
          </div>
        </form>
        <p v-if="detail.topics.length === 0" class="text-ink-soft">No topics yet. Students need at least one.</p>
        <ul class="flex flex-col gap-2">
          <li
            v-for="(topic, index) in detail.topics"
            :key="topic.id"
            class="flex flex-wrap items-center gap-2 rounded-tile border-3 p-2"
            :class="[topic.active ? '' : 'opacity-60', editingId === topic.id ? 'border-ink' : 'border-rule']"
          >
            <span class="flex-1 font-semibold" dir="auto">
              {{ topic.title }}<span v-if="!topic.active" class="text-ink-soft"> (hidden)</span>
              <span v-if="hasGuide(topic.guide)" class="block text-base font-normal text-ink-soft">
                Has a Podcast Guide
              </span>
            </span>
            <button class="btn btn-small" :disabled="index === 0" aria-label="Move up" @click="moveTopic(index, -1)">Up</button>
            <button class="btn btn-small" :disabled="index === detail.topics.length - 1" aria-label="Move down" @click="moveTopic(index, 1)">Down</button>
            <button class="btn btn-small" @click="startEdit(topic)">Edit</button>
            <button class="btn btn-small" @click="toggleTopic(topic)">{{ topic.active ? 'Hide' : 'Show' }}</button>
            <button class="btn btn-small" @click="deleteTopic(topic)">Delete</button>
          </li>
        </ul>
      </section>

      <StudentsPanel :class-id="detail.class.id" :class-name="detail.class.name" :students="detail.students" @changed="load" />

      <section class="panel flex flex-col gap-3 p-5" data-testid="deadline">
        <h2 class="font-display text-xl font-extrabold">Submission deadline</h2>
        <p v-if="detail.class.deadline === null" class="text-ink-soft">
          No deadline. Students can submit and change their submission at any time.
        </p>
        <p v-else-if="deadlinePassed" class="font-semibold text-bad">
          Closed on {{ formatDateTime(detail.class.deadline) }}. Students can still record, but can't change what they submitted.
        </p>
        <p v-else class="text-ink-soft">
          Students can submit and change their submission until {{ formatDateTime(detail.class.deadline) }}.
        </p>
        <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="setDeadline">
          <input v-model="deadlineDraft" type="datetime-local" class="field-input text-base" aria-label="Deadline" />
          <button class="btn btn-primary btn-small shrink-0" type="submit" :disabled="!deadlineDraft">Set Deadline</button>
          <button v-if="detail.class.deadline !== null" class="btn btn-small shrink-0" type="button" @click="saveDeadline(null)">
            Remove Deadline
          </button>
        </form>
      </section>

      <section class="panel flex flex-col gap-4 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-extrabold">
            Submissions
            <span class="text-ink-soft">({{ detail.submissions.length }} of {{ detail.students.length }})</span>
          </h2>
          <select v-model="topicFilter" class="field-input w-auto text-base" aria-label="Filter by topic">
            <option value="">All topics</option>
            <option v-for="topic in detail.topics" :key="topic.id" :value="topic.id">{{ topic.title }}</option>
          </select>
        </div>
        <p v-if="notSubmitted.length > 0" class="text-ink-soft" data-testid="not-submitted" dir="auto">
          Not submitted yet: {{ notSubmitted.map((student) => student.name).join(', ') }}
        </p>
        <p v-if="visibleSubmissions.length === 0" class="text-ink-soft">No submissions yet.</p>
        <ul class="flex flex-col gap-4">
          <li
            v-for="item in visibleSubmissions"
            :key="item.id"
            class="flex flex-col gap-3 rounded-tile border-3 border-rule p-4"
            data-testid="submission"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="flex items-center gap-2 text-lg font-bold" dir="auto">
                <StudentBadge v-if="item.student" :student="item.student" size="sm" />
                {{ item.student_name }}
              </p>
              <p class="text-ink-soft" dir="auto">
                {{ item.topic_title ?? 'Topic removed' }} ·
                <template v-if="item.with_names">with {{ item.with_names }} · </template>
                {{ item.duration_ms === null ? '' : formatClock(item.duration_ms) + ' · ' }}
                submitted {{ formatDateTime(item.submitted_at) }}
              </p>
            </div>
            <AudioPlayer :src="`/api/teacher/submissions/${item.id}/audio`" :duration-ms="item.duration_ms" preload="none" />
            <div class="flex flex-wrap gap-3">
              <a class="btn btn-small" :href="`/api/teacher/submissions/${item.id}/audio?download=1`">Download</a>
              <button class="btn btn-small" @click="deleteSubmission(item)">Delete</button>
            </div>
          </li>
        </ul>
      </section>

      <section class="panel flex flex-col gap-3 p-5" data-testid="delete-class">
        <h2 class="font-display text-xl font-extrabold">Delete class</h2>
        <p class="text-ink-soft">
          Deletes this class with all its topics, students and recordings, for good. Download any recordings you want to keep first.
        </p>
        <button class="btn btn-rec btn-small self-start" @click="deleteClass(detail.class.name)">Delete Class</button>
      </section>
    </template>
  </main>
</template>
