<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatClock } from '../utils/format'

const props = withDefaults(
  defineProps<{
    src: string
    /** Known length, shown before the file loads and for recordings whose file doesn't report one (MediaRecorder WebM). */
    durationMs?: number | null
    preload?: 'none' | 'metadata' | 'auto'
    autoplay?: boolean
  }>(),
  { durationMs: null, preload: 'metadata', autoplay: false },
)

const emit = defineEmits<{ play: []; pause: []; ended: [] }>()

const audio = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const currentMs = ref(0)
const fileDurationMs = ref<number | null>(null)

const totalMs = computed(() => fileDurationMs.value ?? props.durationMs ?? 0)
const progress = computed(() => (totalMs.value > 0 ? Math.min(100, (currentMs.value / totalMs.value) * 100) : 0))

watch(
  () => props.src,
  () => {
    playing.value = false
    currentMs.value = 0
    fileDurationMs.value = null
  },
)

function readDuration(): void {
  const seconds = audio.value?.duration ?? NaN
  fileDurationMs.value = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

function toggle(): void {
  const element = audio.value
  if (!element) {
    return
  }
  if (element.paused) {
    void element.play().catch(() => undefined)
  } else {
    element.pause()
  }
}

function seek(event: Event): void {
  const element = audio.value
  if (!element || totalMs.value === 0) {
    return
  }
  const ms = (Number((event.target as HTMLInputElement).value) / 100) * totalMs.value
  element.currentTime = ms / 1000
  currentMs.value = ms
}

function onPlay(): void {
  playing.value = true
  emit('play')
}

function onPause(): void {
  playing.value = false
  emit('pause')
}

function onEnded(): void {
  playing.value = false
  currentMs.value = totalMs.value
  emit('ended')
}
</script>

<template>
  <div class="flex w-full items-center gap-3 rounded-tile border-3 border-ink bg-card p-3 pe-4">
    <button
      type="button"
      class="btn btn-primary size-14 shrink-0 rounded-full p-0 [--wave-color:var(--color-ink)] [--wave-scale:1.25]"
      :class="{ wave: playing }"
      :aria-label="playing ? 'Pause' : 'Play'"
      @click="toggle"
    >
      <svg v-if="playing" viewBox="0 0 24 24" class="size-6" fill="currentColor" aria-hidden="true">
        <rect x="5" y="4" width="5" height="16" rx="1.5" />
        <rect x="14" y="4" width="5" height="16" rx="1.5" />
      </svg>
      <svg v-else viewBox="0 0 24 24" class="ms-1 size-6" fill="currentColor" aria-hidden="true">
        <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
      </svg>
    </button>
    <input
      type="range"
      class="player-range min-w-0 flex-1"
      min="0"
      max="100"
      step="0.1"
      :value="progress"
      :style="{ '--progress': `${progress}%` }"
      :disabled="totalMs === 0"
      aria-label="Position"
      :aria-valuetext="`${formatClock(currentMs)} of ${formatClock(totalMs)}`"
      @input="seek"
    />
    <span class="shrink-0 font-display text-base font-bold tabular-nums">
      {{ formatClock(currentMs) }}<span class="text-ink-soft"> / {{ formatClock(totalMs) }}</span>
    </span>
    <audio
      ref="audio"
      :src="src"
      :preload="preload"
      :autoplay="autoplay"
      class="hidden"
      @loadedmetadata="readDuration"
      @durationchange="readDuration"
      @timeupdate="currentMs = (audio?.currentTime ?? 0) * 1000"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
    ></audio>
  </div>
</template>
