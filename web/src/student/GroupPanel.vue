<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import StudentBadge from '../components/StudentBadge.vue'
import { SUGGESTED_MIN_SECONDS } from '../config'
import { formatClock } from '../utils/format'
import { useGroupRoom } from './useGroupRoom'

const props = defineProps<{ classToken: string; groupId: string; token: string }>()
const emit = defineEmits<{ leave: []; gone: [] }>()

const room = useGroupRoom({
  classToken: props.classToken,
  groupId: props.groupId,
  token: props.token,
  onGone: () => emit('gone'),
})
const { phase, group, view, maxMs, partnerStream, callState, elapsedMs, uploadPercent, mixUrl, busy, actionError } = room

const partnerAudio = ref<HTMLAudioElement | null>(null)
watch([partnerAudio, partnerStream], ([element, stream]) => {
  if (element && element.srcObject !== stream) {
    element.srcObject = stream
    void element.play().catch(() => undefined)
  }
})

const current = computed(() => view.value?.view ?? null)
const partnerName = computed(() => view.value?.partner?.name ?? 'your partner')
const controllerName = computed(() => view.value?.controller?.name ?? 'your partner')
const showTimer = computed(() => ['recording', 'mixing', 'listening'].includes(current.value ?? ''))
const hitLimit = computed(() => elapsedMs.value >= maxMs.value - 250)
const isShort = computed(() => elapsedMs.value < SUGGESTED_MIN_SECONDS * 1000)
const canLeave = computed(() => current.value !== 'recording' && uploadPercent.value === null)
const callText = computed(() => {
  if (callState.value === 'connected') {
    return `You can hear ${partnerName.value}.`
  }
  return `Connecting you to ${partnerName.value}…`
})
</script>

<template>
  <section class="flex flex-col items-center gap-6 text-center">
    <div>
      <p class="text-ink-soft">Your topic</p>
      <h1 class="font-display text-3xl font-extrabold" dir="auto">{{ group?.topic?.title ?? '…' }}</h1>
    </div>

    <ul v-if="group" class="flex flex-wrap justify-center gap-4" aria-label="Your group">
      <li v-for="member in group.members" :key="member.participantId" class="flex items-center gap-2 font-semibold" data-testid="group-member">
        <StudentBadge :student="{ emoji: member.emoji ?? '🎙️', photo: member.photo }" size="sm" />
        <span dir="auto">{{ member.name }}</span>
        <span
          class="size-3 rounded-full"
          :class="member.online ? 'bg-good' : 'bg-rule'"
          :title="member.online ? 'Here' : 'Away'"
          aria-hidden="true"
        ></span>
        <span class="sr-only">{{ member.online ? '(here)' : '(away)' }}</span>
      </li>
    </ul>

    <audio ref="partnerAudio" autoplay data-testid="partner-audio" class="hidden"></audio>

    <p
      v-if="showTimer"
      class="font-display text-6xl font-extrabold tabular-nums"
      :class="current === 'recording' ? 'text-rec' : 'text-ink'"
      role="timer"
      aria-live="off"
    >
      {{ formatClock(elapsedMs) }}<span class="text-3xl text-ink-soft"> / {{ formatClock(maxMs) }}</span>
    </p>

    <p v-if="phase === 'unsupported'" class="alert-bad max-w-sm" role="alert">
      This browser can't record with a partner. Try the latest Chrome or Safari.
    </p>

    <p v-else-if="phase === 'replaced'" class="alert-bad max-w-sm" role="alert">
      Your group is open on another tab or device. Use that one, or reload this page to use this one.
    </p>

    <template v-else-if="phase === 'mic-blocked'">
      <p class="alert-bad max-w-sm" role="alert">
        Your microphone is turned off for this page. Allow the microphone in your browser, then tap Try Again.
      </p>
      <button class="btn btn-primary btn-large" @click="room.startMic">Try Again</button>
    </template>

    <template v-if="current === 'waiting-partner'">
      <div class="panel flex w-full max-w-sm flex-col gap-2 p-5">
        <p class="text-lg font-semibold">Your group PIN</p>
        <p class="font-mono text-5xl font-extrabold tracking-[0.2em]" data-testid="group-pin">{{ group?.pin }}</p>
        <p class="text-ink-soft">Tell your partner to tap <strong>Join a Partner</strong> and type this PIN.</p>
      </div>
      <p class="text-ink-soft">Waiting for your partner to join…</p>
    </template>

    <p v-else-if="current === 'partner-away'" class="text-lg text-ink-soft">
      Waiting for {{ partnerName }} to come back…
    </p>

    <p v-else-if="phase === 'loading' || (phase === 'live' && !current)" class="text-lg text-ink-soft">Getting ready…</p>

    <template v-else-if="current === 'ready' && phase === 'live'">
      <p class="text-ink-soft">{{ callText }}</p>
      <button class="btn btn-rec btn-mic" :disabled="busy" @click="room.record">Record</button>
      <p class="max-w-sm text-ink-soft">
        Either of you can tap Record. Whoever does is in charge of the take. You can talk for up to {{ formatClock(maxMs) }}.
      </p>
      <p class="max-w-sm text-ink-soft">Tip: wear headphones so your partner's voice doesn't echo.</p>
    </template>

    <template v-else-if="current === 'recording'">
      <p class="flex items-center gap-2 font-bold text-rec">
        <span class="size-3 animate-rec-pulse rounded-full bg-rec" aria-hidden="true"></span>
        Recording
      </p>
      <button v-if="view?.canControl" class="btn btn-primary btn-mic" :disabled="busy" @click="room.stop">Stop</button>
      <p v-else class="max-w-sm text-lg text-ink-soft">{{ controllerName }} is in charge. {{ controllerName }} taps Stop.</p>
    </template>

    <template v-else-if="current === 'mixing'">
      <p class="text-xl font-bold" aria-live="polite">Putting your voices together…</p>
      <p v-if="uploadPercent !== null" class="text-ink-soft">Sending your voice… {{ uploadPercent }}%</p>
      <p class="text-ink-soft">Keep this page open.</p>
    </template>

    <template v-else-if="current === 'listening'">
      <audio
        v-if="mixUrl"
        :src="mixUrl"
        controls
        preload="metadata"
        class="w-full max-w-sm"
        data-testid="mix-player"
        @play="room.setMicLive(false)"
        @pause="room.setMicLive(true)"
        @ended="room.setMicLive(true)"
      ></audio>
      <p v-else class="text-ink-soft">Loading your recording…</p>
      <p v-if="hitLimit" class="text-ink-soft">Time's up! Your recording stopped at {{ formatClock(maxMs) }}.</p>
      <p v-else-if="isShort" class="text-ink-soft">Tip: try to talk for at least 2 minutes.</p>
      <div v-if="view?.canControl" class="flex w-full max-w-sm flex-col gap-4">
        <button class="btn btn-good btn-large" :disabled="busy" @click="room.send">Send</button>
        <button class="btn" :disabled="busy" @click="room.tryAgain">Try Again</button>
      </div>
      <p v-else class="max-w-sm text-ink-soft">Listen together. {{ controllerName }} chooses Send or Try Again.</p>
    </template>

    <template v-else-if="current === 'failed'">
      <p class="alert-bad max-w-sm" role="alert">We couldn't put your voices together. Please record again.</p>
      <button v-if="view?.canControl" class="btn" :disabled="busy" @click="room.tryAgain">Try Again</button>
      <p v-else class="text-ink-soft">{{ controllerName }} can tap Try Again.</p>
    </template>

    <template v-else-if="current === 'sent'">
      <p class="animate-stamp font-display text-4xl font-extrabold text-good" role="status">Sent!</p>
      <audio v-if="mixUrl" :src="mixUrl" controls preload="metadata" class="w-full max-w-sm"></audio>
      <p class="max-w-sm text-ink-soft">Your teacher has your podcast. It stays with them until you send a new one.</p>
      <button class="btn" @click="room.tryAgain">Try Again</button>
    </template>

    <p v-if="actionError" class="alert-bad max-w-sm" role="alert">{{ actionError }}</p>

    <button
      v-if="canLeave"
      class="-my-2 py-2 text-base font-semibold text-ink-soft underline underline-offset-4"
      @click="emit('leave')"
    >
      Change topic
    </button>
  </section>
</template>
