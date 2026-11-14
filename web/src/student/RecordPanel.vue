<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import AudioPlayer from '../components/AudioPlayer.vue'
import OnAirBadge from '../components/OnAirBadge.vue'
import PodcastGuide from '../components/PodcastGuide.vue'
import { SUGGESTED_MIN_SECONDS } from '../config'
import { formatClock } from '../utils/format'
import type { TopicGuide } from '../utils/guide'
import { useRecorder } from './useRecorder'

const props = defineProps<{
  classToken: string
  topicId: string
  topicTitle: string
  topicGuide?: TopicGuide | null
  studentToken: string
  maxSeconds: number
}>()

const emit = defineEmits<{ changeTopic: []; signedOut: []; saved: [] }>()

const { phase, elapsedMs, maxMs, sendPercent, audioUrl, record, stop, tryAgain, send } = useRecorder({
  classToken: props.classToken,
  topicId: props.topicId,
  studentToken: props.studentToken,
  maxSeconds: props.maxSeconds,
  onSignedOut: () => emit('signedOut'),
  onSaved: () => emit('saved'),
})

const isBusy = computed(() => ['starting', 'recording', 'sending'].includes(phase.value))
const showTimer = computed(() => ['recording', 'recorded', 'sending', 'send-failed'].includes(phase.value))
const isShort = computed(() => elapsedMs.value < SUGGESTED_MIN_SECONDS * 1000)
const showPlayer = computed(() => audioUrl.value !== null && ['recorded', 'send-failed'].includes(phase.value))
const hitLimit = computed(() => elapsedMs.value >= maxMs - 250)
const guideOpen = ref(false)
// ClassPage fits the page to the phone while this is true, so the open guide box shrinks instead of pushing
// Record or Stop off screen.
const fitScreen = defineModel<boolean>('fitScreen', { default: false })
watchEffect(() => {
  fitScreen.value = guideOpen.value && ['ready', 'starting', 'mic-blocked', 'recording'].includes(phase.value)
})
</script>

<template>
  <section class="flex flex-col items-center gap-6 text-center" :class="fitScreen ? 'min-h-0 flex-1' : ''">
    <div>
      <p class="text-ink-soft">Your topic</p>
      <h1 class="font-display text-3xl font-extrabold">{{ topicTitle }}</h1>
    </div>

    <PodcastGuide v-model:open="guideOpen" :guide="topicGuide" mode="solo" compact />

    <p
      v-if="showTimer"
      class="font-display text-6xl font-extrabold tabular-nums"
      :class="phase === 'recording' ? 'text-rec' : 'text-ink'"
      role="timer"
      aria-live="off"
    >
      {{ formatClock(elapsedMs) }}<span class="text-3xl text-ink-soft"> / {{ formatClock(maxMs) }}</span>
    </p>

    <p v-if="phase === 'loading'" class="text-lg text-ink-soft">Getting ready…</p>

    <template v-else-if="phase === 'ready' || phase === 'starting' || phase === 'mic-blocked'">
      <button
        class="btn btn-rec btn-mic"
        :disabled="phase === 'starting'"
        @click="record"
      >
        Record
      </button>
      <p v-if="phase === 'mic-blocked'" class="alert-bad max-w-sm" role="alert">
        Your microphone is turned off for this page. Allow the microphone in your browser, then tap Record again.
      </p>
      <p v-else class="max-w-sm text-ink-soft">You can talk for up to {{ formatClock(maxMs) }}.</p>
    </template>

    <template v-else-if="phase === 'recording'">
      <OnAirBadge />
      <button class="btn btn-primary btn-mic wave" @click="stop">Stop</button>
    </template>

    <AudioPlayer v-if="showPlayer && audioUrl" :src="audioUrl" :duration-ms="elapsedMs" class="max-w-sm" />

    <template v-if="phase === 'recorded' || phase === 'send-failed'">
      <p v-if="phase === 'send-failed'" class="alert-bad max-w-sm" role="alert">
        Couldn't save. Your recording is safe on this device.
      </p>
      <p v-else-if="hitLimit" class="text-ink-soft">Time's up! Your recording stopped at {{ formatClock(maxMs) }}.</p>
      <p v-else-if="isShort" class="text-ink-soft">Tip: try to talk for at least 2 minutes.</p>
      <div class="flex w-full max-w-sm flex-col gap-4">
        <button class="btn btn-good btn-large" @click="send">Save</button>
        <button class="btn" @click="tryAgain">Try Again</button>
      </div>
    </template>

    <template v-else-if="phase === 'sending'">
      <p class="text-xl font-bold" aria-live="polite">Saving… {{ sendPercent }}%</p>
      <p class="text-ink-soft">Keep this page open.</p>
    </template>

    <p v-else-if="phase === 'unsupported'" class="alert-bad max-w-sm" role="alert">
      This browser can't record. Try the latest Chrome or Safari.
    </p>

    <button
      v-if="!isBusy && phase !== 'loading'"
      class="-my-2 py-2 text-base font-semibold text-ink-soft underline underline-offset-4"
      @click="emit('changeTopic')"
    >
      Change topic
    </button>
  </section>
</template>
