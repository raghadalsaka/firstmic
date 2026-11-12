<script setup lang="ts">
import { computed, ref } from 'vue'
import StudentBadge from '../components/StudentBadge.vue'
import { MAX_STUDENTS } from '../config'
import { api, errorMessage } from '../services/api'
import type { NewStudent, RosterStudent } from '../types/roster'
import { nextEmoji } from '../utils/roster'
import StudentForm from './StudentForm.vue'

const props = defineProps<{ classId: string; className: string; students: RosterStudent[] }>()
const emit = defineEmits<{ changed: [] }>()

// 'new' while adding, a student id while editing, null otherwise.
const editing = ref<string | null>(null)
const busy = ref(false)
const error = ref('')

const editingStudent = computed(() => props.students.find((student) => student.id === editing.value) ?? null)
const pinsInUse = computed(
  () => new Set(props.students.filter((student) => student.id !== editing.value).map((student) => student.pin)),
)
const suggestedEmoji = computed(() => nextEmoji(props.students.map((student) => student.emoji)))

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
    editing.value = null
    emit('changed')
  } catch (caught) {
    error.value = errorMessage(caught, 'That did not work. Try again.')
  } finally {
    busy.value = false
  }
}

function save(student: NewStudent): void {
  if (editing.value === 'new') {
    void run(() => api(`/api/teacher/classes/${props.classId}/students`, { body: { students: [student] } }))
    return
  }
  void run(() => api(`/api/teacher/students/${editing.value}`, { method: 'PATCH', body: student }))
}

function newPin(): void {
  const student = editingStudent.value
  if (!student || !window.confirm(`Give ${student.name} a new PIN? Their old PIN stops working.`)) {
    return
  }
  void run(() => api(`/api/teacher/students/${student.id}/new-pin`, { method: 'POST' }))
}

function remove(): void {
  const student = editingStudent.value
  if (!student || !window.confirm(`Remove ${student.name}? Their recordings are deleted too, including podcasts they recorded with a partner. This can't be undone.`)) {
    return
  }
  void run(() => api(`/api/teacher/students/${student.id}`, { method: 'DELETE' }))
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function printPins(): void {
  const rows = props.students
    .map((student) => `<tr><td>${escapeHtml(student.emoji)}</td><td>${escapeHtml(student.name)}</td><td>${student.pin}</td></tr>`)
    .join('')
  const page = window.open('', '_blank')
  if (!page) {
    error.value = 'Allow pop-ups for this site to print the PINs.'
    return
  }
  page.document.write(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(props.className)} PINs</title>` +
      '<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}' +
      'td,th{border:1px solid #999;padding:.6rem;font-size:1.2rem;text-align:start}td:last-child{font-family:monospace;letter-spacing:.15em}</style>' +
      `<h1>${escapeHtml(props.className)}: First Mic PINs</h1><table><tr><th></th><th>Name</th><th>PIN</th></tr>${rows}</table>`,
  )
  page.document.close()
  page.focus()
  page.print()
}
</script>

<template>
  <section class="panel flex flex-col gap-4 p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-display text-xl font-extrabold">Students</h2>
      <div class="flex flex-wrap gap-2">
        <button v-if="students.length > 0" type="button" class="btn btn-small" @click="printPins">Print PINs</button>
        <button
          type="button"
          class="btn btn-small btn-primary"
          :disabled="editing !== null || students.length >= MAX_STUDENTS"
          @click="editing = 'new'"
        >
          Add Student
        </button>
      </div>
    </div>
    <p class="text-ink-soft">Students pick their name on the class page, then type their PIN. Give each student their PIN.</p>
    <p v-if="error !== ''" role="alert" class="alert-bad">{{ error }}</p>

    <StudentForm
      v-if="editing === 'new'"
      :student="null"
      :suggested-emoji="suggestedEmoji"
      :pins-in-use="pinsInUse"
      :busy="busy"
      @save="save"
      @cancel="editing = null"
    />

    <p v-if="students.length === 0 && editing === null" class="text-ink-soft">No students yet. Add them so they can record.</p>
    <ul class="flex flex-col gap-2">
      <li v-for="student in students" :key="student.id" class="grid gap-2">
        <div class="flex flex-wrap items-center gap-3 rounded-tile border-3 border-rule p-2" data-testid="student-row">
          <StudentBadge :student="student" size="sm" />
          <span class="flex-1 font-semibold" dir="auto">{{ student.name }}</span>
          <span class="font-mono text-lg tracking-widest" :aria-label="`PIN ${student.pin.split('').join(' ')}`">{{ student.pin }}</span>
          <button type="button" class="btn btn-small" :disabled="editing !== null" @click="editing = student.id">Edit</button>
        </div>
        <StudentForm
          v-if="editing === student.id"
          :key="`${student.id}-${student.pin}`"
          :student="student"
          :suggested-emoji="student.emoji"
          :pins-in-use="pinsInUse"
          :busy="busy"
          @save="save"
          @new-pin="newPin"
          @remove="remove"
          @cancel="editing = null"
        />
      </li>
    </ul>
  </section>
</template>
