<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import StudentBadge from '../components/StudentBadge.vue'
import { api, ApiError, errorMessage } from '../services/api'
import type { RosterStudent } from '../types/roster'
import { formatClock, formatDateTime } from '../utils/format'
import { classPath } from '../utils/slug'
import StudentsPanel from './StudentsPanel.vue'

type Topic = { id: string; title: string; active: number; sort: number }
type Submission = {
  id: string
  episode_id: string
  version: number
  duration_ms: number | null
  ready_at: number
  student_name: string
  student_id: string | null
  topic_id: string | null
  topic_title: string | null
}
type GroupRecording = {
  id: string
  episode_id: string
  version: number
  duration_ms: number | null
  sent_at: number
  topic_id: string | null
  topic_title: string | null
  voices: { track_id: string; student_id: string | null; name: string }[]
}
type ClassDetail = {
  class: { id: string; name: string; classToken: string }
  topics: Topic[]
  students: RosterStudent[]
  submissions: Submission[]
  groupRecordings: GroupRecording[]
}

const props = defineProps<{ classId: string }>()

const detail = ref<ClassDetail | null>(null)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const copied = ref(false)
const topicDraft = ref('')
const editingId = ref<string | null>(null)
const topicInput = ref<HTMLInputElement | null>(null)
const topicFilter = ref('')

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

const visibleGroupRecordings = computed(() => {
  const students = studentsById.value
  return (detail.value?.groupRecordings ?? [])
    .filter((item) => !topicFilter.value || item.topic_id === topicFilter.value)
    .map((item) => ({
      ...item,
      names: item.voices.map((voice) => voice.name).join(' & '),
      voices: item.voices.map((voice) => ({ ...voice, student: voice.student_id ? students.get(voice.student_id) : undefined })),
    }))
})

async function load(): Promise<void> {
  try {
    detail.value = await api<ClassDetail>(`/api/teacher/classes/${props.classId}`)
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

/** One form adds a topic, or saves the one picked with Edit. */
function saveTopic(): void {
  const title = topicDraft.value.trim()
  if (!title) {
    return
  }
  const id = editingId.value
  void run(async () => {
    if (id === null) {
      await api(`/api/teacher/classes/${props.classId}/topics`, { body: { title } })
    } else {
      await api(`/api/teacher/topics/${id}`, { method: 'PATCH', body: { title } })
    }
    cancelEdit()
  })
}

function startEdit(topic: Topic): void {
  editingId.value = topic.id
  topicDraft.value = topic.title
  topicInput.value?.focus()
}

function cancelEdit(): void {
  editingId.value = null
  topicDraft.value = ''
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
  const recordings =
    (detail.value?.submissions.filter((item) => item.topic_id === topic.id).length ?? 0) +
    (detail.value?.groupRecordings.filter((item) => item.topic_id === topic.id).length ?? 0)
  const warning =
    recordings === 0
      ? 'No recordings have been sent for it yet.'
      : `All ${recordings} recording${recordings === 1 ? '' : 's'} sent for this topic will be deleted too.`
  if (!window.confirm(`Delete the topic "${topic.title}"? ${warning} This can't be undone.`)) {
    return
  }
  void run(() => api(`/api/teacher/topics/${topic.id}`, { method: 'DELETE' }))
}

function deleteEpisode(episodeId: string, question: string): void {
  if (!window.confirm(`${question} This can't be undone.`)) {
    return
  }
  void run(() => api(`/api/teacher/episodes/${episodeId}`, { method: 'DELETE' }))
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
        <form class="flex flex-col gap-3 sm:flex-row" @submit.prevent="saveTopic">
          <input
            ref="topicInput"
            v-model="topicDraft"
            class="field-input"
            placeholder="New topic, e.g. My favourite animal"
            maxlength="200"
            dir="auto"
            :aria-label="editingId === null ? 'New topic' : 'Topic title'"
          />
          <button class="btn btn-primary btn-small shrink-0" type="submit" :disabled="!topicDraft.trim()">
            {{ editingId === null ? 'Add Topic' : 'Edit Topic' }}
          </button>
          <button v-if="editingId !== null" class="btn btn-small shrink-0" type="button" @click="cancelEdit">Cancel</button>
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

      <section class="panel flex flex-col gap-4 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-extrabold">Recordings</h2>
          <select v-model="topicFilter" class="field-input w-auto text-base" aria-label="Filter by topic">
            <option value="">All topics</option>
            <option v-for="topic in detail.topics" :key="topic.id" :value="topic.id">{{ topic.title }}</option>
          </select>
        </div>
        <p v-if="visibleSubmissions.length === 0 && visibleGroupRecordings.length === 0" class="text-ink-soft">No recordings yet.</p>
        <ul v-if="visibleGroupRecordings.length > 0" class="flex flex-col gap-4">
          <li
            v-for="item in visibleGroupRecordings"
            :key="item.id"
            class="flex flex-col gap-3 rounded-tile border-3 border-rule p-4"
            data-testid="group-recording"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="flex flex-wrap items-center gap-2 text-lg font-bold" dir="auto">
                <template v-for="voice in item.voices" :key="voice.track_id">
                  <StudentBadge v-if="voice.student" :student="voice.student" size="sm" />
                </template>
                {{ item.names }}
              </p>
              <p class="text-ink-soft">
                Together · {{ item.topic_title ?? 'Topic removed' }} ·
                {{ item.duration_ms === null ? '' : formatClock(item.duration_ms) + ' · ' }}
                <span v-if="item.version > 1">sent {{ item.version }} times · </span>
                {{ formatDateTime(item.sent_at) }}
              </p>
            </div>
            <audio :src="`/api/teacher/group-takes/${item.id}/audio`" controls preload="none" class="w-full"></audio>
            <div class="flex flex-wrap gap-3">
              <a class="btn btn-small" :href="`/api/teacher/group-takes/${item.id}/audio?download=1`">Download Mix</a>
              <a
                v-for="voice in item.voices"
                :key="voice.track_id"
                class="btn btn-small"
                :href="`/api/teacher/group-takes/${item.id}/audio?voice=${voice.track_id}&download=1`"
                dir="auto"
              >
                {{ voice.name }}'s Voice
              </a>
              <button class="btn btn-small" @click="deleteEpisode(item.episode_id, `Delete the podcast by ${item.names}? Their group is removed too.`)">Delete</button>
            </div>
          </li>
        </ul>
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
              <p class="text-ink-soft">
                {{ item.topic_title ?? 'Topic removed' }} ·
                {{ item.duration_ms === null ? '' : formatClock(item.duration_ms) + ' · ' }}
                <span v-if="item.version > 1">sent {{ item.version }} times · </span>
                {{ formatDateTime(item.ready_at) }}
              </p>
            </div>
            <audio :src="`/api/teacher/submissions/${item.id}/audio`" controls preload="none" class="w-full"></audio>
            <div class="flex flex-wrap gap-3">
              <a class="btn btn-small" :href="`/api/teacher/submissions/${item.id}/audio?download=1`">Download</a>
              <button class="btn btn-small" @click="deleteEpisode(item.episode_id, `Delete ${item.student_name}'s recording?`)">Delete</button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>
