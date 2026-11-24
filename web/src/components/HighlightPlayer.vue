<script setup lang="ts">
import { computed, ref } from 'vue'
import AudioPlayer from './AudioPlayer.vue'
import { formatClock } from '../utils/format'
import type { Highlight } from '../utils/grading'

const props = withDefaults(
  defineProps<{
    src: string
    highlights: Highlight[]
    durationMs?: number | null
    preload?: 'none' | 'metadata' | 'auto'
  }>(),
  { durationMs: null, preload: 'none' },
)

// "highlights" plays every highlight in order and then the whole recording; "clip" plays one highlight and stops.
type Mode = 'idle' | 'highlights' | 'clip' | 'full'

const player = ref<InstanceType<typeof AudioPlayer> | null>(null)
const mode = ref<Mode>('idle')
const index = ref(0)

const sorted = computed(() => [...props.highlights].sort((a, b) => a.startMs - b.startMs))
const activeHighlight = computed(() =>
  mode.value === 'highlights' || mode.value === 'clip' ? (sorted.value[index.value] ?? null) : null,
)
const status = computed(() => {
  if (activeHighlight.value) {
    return `Highlight ${index.value + 1} of ${sorted.value.length}: ${activeHighlight.value.note}`
  }
  if (mode.value === 'full') {
    return 'Full recording'
  }
  return sorted.value.length > 0 ? 'Press play to hear the highlights first, then the full recording.' : ''
})

/** The first Play runs the highlights; Play after a pause carries on from where it stopped. */
function onPlay(): void {
  if (mode.value !== 'idle') {
    return
  }
  const first = sorted.value[0]
  if (!first) {
    mode.value = 'full'
    return
  }
  mode.value = 'highlights'
  index.value = 0
  player.value?.seekTo(first.startMs)
}

function playClip(clipIndex: number): void {
  const highlight = sorted.value[clipIndex]
  if (!highlight) {
    return
  }
  mode.value = 'clip'
  index.value = clipIndex
  player.value?.seekTo(highlight.startMs)
  player.value?.play()
}

function playFull(): void {
  mode.value = 'full'
  player.value?.seekTo(0)
  player.value?.play()
}

function onTimeUpdate(ms: number): void {
  const highlight = activeHighlight.value
  if (!highlight || ms < highlight.endMs) {
    return
  }
  if (mode.value === 'clip') {
    mode.value = 'idle'
    player.value?.pause()
    return
  }
  const next = sorted.value[index.value + 1]
  if (next) {
    index.value += 1
    player.value?.seekTo(next.startMs)
    return
  }
  mode.value = 'full'
  player.value?.seekTo(0)
}
</script>

<template>
  <div class="flex w-full flex-col gap-3">
    <AudioPlayer
      ref="player"
      :src="src"
      :duration-ms="durationMs"
      :preload="preload"
      :markers="sorted"
      @play="onPlay"
      @timeupdate="onTimeUpdate"
      @seek="mode = 'full'"
      @ended="mode = 'idle'"
    />
    <p v-if="status" class="text-base text-ink-soft" aria-live="polite" data-testid="highlight-status" dir="auto">{{ status }}</p>
    <ol v-if="sorted.length > 0" class="flex flex-col gap-2">
      <li v-for="(highlight, i) in sorted" :key="i">
        <button
          type="button"
          class="flex w-full items-start gap-3 rounded-tile border-3 p-2 text-start"
          :class="activeHighlight && index === i ? 'border-ink bg-card' : 'border-rule'"
          @click="playClip(i)"
        >
          <span class="shrink-0 font-display font-bold tabular-nums">{{ formatClock(highlight.startMs) }}</span>
          <span class="text-base" dir="auto">{{ highlight.note }}</span>
        </button>
      </li>
    </ol>
    <button v-if="sorted.length > 0" type="button" class="btn btn-small self-start" @click="playFull">Play Full Recording</button>
  </div>
</template>
