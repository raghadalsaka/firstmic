<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StudentBadge from '../components/StudentBadge.vue'
import { PIN_LENGTH } from '../config'
import { api, ApiError, errorMessage } from '../services/api'
import type { PublicStudent } from '../types/roster'
import { isPin } from '../utils/roster'
import { classPath } from '../utils/slug'
import type { GroupAccess } from '../group/types'
import GroupPanel from './GroupPanel.vue'
import RecordPanel from './RecordPanel.vue'
import { forgetStudent, loadLogin, saveLogin, type StoredLogin } from './storage'

type Topic = { id: string; title: string }
type ClassInfo = { class: { name: string }; topics: Topic[]; students: PublicStudent[]; maxSeconds: number }

const props = defineProps<{ classToken: string }>()
const route = useRoute()
const router = useRouter()

const info = ref<ClassInfo | null>(null)
const loadError = ref<'not-found' | 'offline' | null>(null)
const login = ref<StoredLogin | null>(null)
const picked = ref<PublicStudent | null>(null)
const pin = ref('')
const pinError = ref('')
const signingIn = ref(false)
const topic = ref<Topic | null>(null)
const recordAlone = ref(false)
const groupAccess = ref<GroupAccess | null>(null)
const joining = ref(false)
const groupPin = ref('')
const groupError = ref('')
const groupBusy = ref(false)
const notice = ref('')

const pinComplete = computed(() => isPin(pin.value))
const groupPinComplete = computed(() => isPin(groupPin.value))

/** A sign-in kept on this device still counts only if the server agrees (the PIN may have changed). */
async function restoreLogin(): Promise<void> {
  const stored = loadLogin(props.classToken)
  if (!stored) {
    return
  }
  try {
    const response = await api<{ student: PublicStudent }>(`/api/class/${encodeURIComponent(props.classToken)}/me`, {
      token: stored.studentToken,
    })
    login.value = { studentToken: stored.studentToken, student: response.student }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      forgetStudent(props.classToken)
    }
  }
}

onMounted(async () => {
  // restoreLogin handles its own errors, so it runs alongside the class fetch.
  const restoring = restoreLogin()
  try {
    info.value = await api<ClassInfo>(`/api/class/${encodeURIComponent(props.classToken)}`)
    const canonical = classPath(props.classToken, info.value.class.name)
    if (route.path !== canonical) {
      await router.replace(canonical)
    }
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'not-found' : 'offline'
  }
  await restoring
})

function pick(student: PublicStudent): void {
  picked.value = student
  pin.value = ''
  pinError.value = ''
}

async function signIn(): Promise<void> {
  const student = picked.value
  if (!student || !pinComplete.value || signingIn.value) {
    return
  }
  signingIn.value = true
  pinError.value = ''
  try {
    const response = await api<StoredLogin>(`/api/class/${encodeURIComponent(props.classToken)}/sign-in`, {
      body: { studentId: student.id, pin: pin.value },
    })
    saveLogin(props.classToken, response)
    login.value = response
    picked.value = null
  } catch (err) {
    pinError.value = errorMessage(err, "Couldn't check your PIN. Check your internet and try again.")
    pin.value = ''
  } finally {
    signingIn.value = false
  }
}

function notMe(): void {
  forgetStudent(props.classToken)
  login.value = null
  picked.value = null
  backToTopics()
}

function backToTopics(): void {
  topic.value = null
  recordAlone.value = false
  groupAccess.value = null
  joining.value = false
  groupError.value = ''
}

function pickTopic(item: Topic): void {
  notice.value = ''
  topic.value = item
}

/** Opens the student's group for the topic (or the one they join by PIN); a 401 means their sign-in stopped working. */
async function openGroup(path: string, body: Record<string, string>): Promise<void> {
  if (!login.value || groupBusy.value) {
    return
  }
  groupBusy.value = true
  groupError.value = ''
  try {
    groupAccess.value = await api<GroupAccess>(`/api/class/${encodeURIComponent(props.classToken)}/${path}`, {
      token: login.value.studentToken,
      body,
    })
    joining.value = false
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      notMe()
      return
    }
    groupError.value = errorMessage(err, "Couldn't reach First Mic. Check your internet and try again.")
    groupPin.value = ''
  } finally {
    groupBusy.value = false
  }
}

function startJoining(): void {
  notice.value = ''
  groupPin.value = ''
  groupError.value = ''
  joining.value = true
}

/** The group token stopped working: either the student's PIN changed, or the teacher removed the group. */
async function groupGone(): Promise<void> {
  backToTopics()
  await restoreLogin()
  if (!loadLogin(props.classToken)) {
    notMe()
    return
  }
  notice.value = "That group isn't available any more. Ask your teacher if you're not sure why."
}
</script>

<template>
  <main class="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
    <header class="flex items-center justify-between gap-3">
      <RouterLink to="/" class="font-display text-xl font-extrabold">First Mic</RouterLink>
      <p v-if="info" class="truncate text-ink-soft" dir="auto">{{ info.class.name }}</p>
    </header>

    <div v-if="loadError === 'not-found'" class="panel p-6 text-center">
      <h1 class="font-display text-2xl font-extrabold">This link doesn't work</h1>
      <p class="mt-2 text-ink-soft">Go back to the home page and pick your class.</p>
    </div>

    <div v-else-if="loadError === 'offline'" class="panel p-6 text-center">
      <h1 class="font-display text-2xl font-extrabold">Can't reach First Mic</h1>
      <p class="mt-2 text-ink-soft">Check your internet, then reload this page.</p>
    </div>

    <p v-else-if="!info" class="text-center text-lg text-ink-soft">Loading…</p>

    <section v-else-if="!login && picked" class="flex flex-col items-center gap-5 text-center">
      <StudentBadge :student="picked" size="lg" />
      <h1 class="font-display text-3xl font-extrabold" dir="auto">Hi {{ picked.name }}!</h1>
      <form class="flex w-full max-w-xs flex-col gap-4" @submit.prevent="signIn">
        <label for="pin" class="text-lg font-semibold">Type your PIN</label>
        <input
          id="pin"
          v-model="pin"
          class="field-input text-center font-mono text-3xl tracking-[0.4em]"
          inputmode="numeric"
          autocomplete="one-time-code"
          :maxlength="PIN_LENGTH"
          pattern="[0-9]*"
          @input="pin = pin.replace(/\D/g, '')"
        />
        <p v-if="pinError" class="alert-bad" role="alert">{{ pinError }}</p>
        <button class="btn btn-primary btn-large" type="submit" :disabled="!pinComplete || signingIn">
          {{ signingIn ? 'Checking…' : 'Next' }}
        </button>
      </form>
      <button class="-my-2 py-2 text-base font-semibold text-ink-soft underline underline-offset-4" @click="picked = null">
        That's not me
      </button>
    </section>

    <section v-else-if="!login" class="flex flex-col gap-4">
      <h1 class="font-display text-2xl font-extrabold">Who are you?</h1>
      <p v-if="info.students.length === 0" class="panel p-6 text-center text-ink-soft">
        Your teacher hasn't added your name yet. Check back soon.
      </p>
      <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <li v-for="student in info.students" :key="student.id">
          <button class="btn h-full w-full flex-col py-3" @click="pick(student)">
            <StudentBadge :student="student" size="md" />
            <span dir="auto">{{ student.name }}</span>
          </button>
        </li>
      </ul>
    </section>

    <GroupPanel
      v-else-if="groupAccess"
      :key="groupAccess.groupId"
      :class-token="classToken"
      :group-id="groupAccess.groupId"
      :token="groupAccess.token"
      @leave="backToTopics"
      @gone="groupGone"
    />

    <section v-else-if="joining" class="flex flex-col items-center gap-5 text-center">
      <h1 class="font-display text-3xl font-extrabold">Join a partner</h1>
      <form class="flex w-full max-w-xs flex-col gap-4" @submit.prevent="openGroup('groups/join', { pin: groupPin })">
        <label for="group-pin" class="text-lg font-semibold">Type your partner's group PIN</label>
        <input
          id="group-pin"
          v-model="groupPin"
          class="field-input text-center font-mono text-3xl tracking-[0.4em]"
          inputmode="numeric"
          autocomplete="off"
          :maxlength="PIN_LENGTH"
          pattern="[0-9]*"
          @input="groupPin = groupPin.replace(/\D/g, '')"
        />
        <p v-if="groupError" class="alert-bad" role="alert">{{ groupError }}</p>
        <button class="btn btn-primary btn-large" type="submit" :disabled="!groupPinComplete || groupBusy">
          {{ groupBusy ? 'Checking…' : 'Join' }}
        </button>
      </form>
      <button class="-my-2 py-2 text-base font-semibold text-ink-soft underline underline-offset-4" @click="backToTopics">
        Back
      </button>
    </section>

    <section v-else-if="!topic" class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <h1 class="flex items-center gap-3 font-display text-2xl font-extrabold" dir="auto">
          <StudentBadge :student="login.student" size="sm" />
          Hi {{ login.student.name }}! Pick a topic
        </h1>
        <button class="-my-2 shrink-0 py-2 text-base font-semibold text-ink-soft underline underline-offset-4" @click="notMe">
          Not you?
        </button>
      </div>
      <p v-if="info.topics.length === 0" class="panel p-6 text-center text-ink-soft">
        Your teacher hasn't added topics yet. Check back soon.
      </p>
      <p v-if="notice" class="alert-bad" role="status">{{ notice }}</p>
      <button
        v-for="item in info.topics"
        :key="item.id"
        class="btn btn-large w-full justify-start text-left"
        dir="auto"
        @click="pickTopic(item)"
      >
        {{ item.title }}
      </button>
      <div class="mt-4 flex flex-col items-center gap-3 border-t-3 border-rule pt-6 text-center">
        <p class="text-ink-soft">Did a partner give you a group PIN?</p>
        <button class="btn" @click="startJoining">Join a Partner</button>
      </div>
    </section>

    <section v-else-if="!recordAlone" class="flex flex-col items-center gap-5 text-center">
      <div>
        <p class="text-ink-soft">Your topic</p>
        <h1 class="font-display text-3xl font-extrabold" dir="auto">{{ topic.title }}</h1>
      </div>
      <p class="text-lg font-semibold">How do you want to record?</p>
      <div class="flex w-full max-w-sm flex-col gap-4">
        <button class="btn btn-primary btn-large" @click="recordAlone = true">On My Own</button>
        <button class="btn btn-large" :disabled="groupBusy" @click="openGroup('groups', { topicId: topic.id })">
          {{ groupBusy ? 'Opening…' : 'With a Partner' }}
        </button>
      </div>
      <p class="max-w-sm text-ink-soft">With a partner, you get a group PIN to share. You talk live and record one podcast together.</p>
      <p v-if="groupError" class="alert-bad max-w-sm" role="alert">{{ groupError }}</p>
      <button class="-my-2 py-2 text-base font-semibold text-ink-soft underline underline-offset-4" @click="backToTopics">
        Change topic
      </button>
    </section>

    <RecordPanel
      v-else
      :key="topic.id"
      :class-token="classToken"
      :topic-id="topic.id"
      :topic-title="topic.title"
      :student-token="login.studentToken"
      :max-seconds="info.maxSeconds"
      @change-topic="backToTopics"
      @signed-out="notMe"
    />
  </main>
</template>
