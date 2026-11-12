<script setup lang="ts">
import { onBeforeUnmount, onUnmounted, ref } from 'vue'
import AudioPlayer from '../components/AudioPlayer.vue'
import type { PastFeedback } from '../types/feedback'
import { describeVersion } from '../utils/format'

const props = defineProps<{
  current: string | null
  past: PastFeedback[]
  loadAudio: (id: string) => Promise<Blob>
}>()

// A group pauses its microphone while a recording plays, so the partner doesn't hear it twice.
const emit = defineEmits<{ playing: [boolean] }>()

const audioUrls = ref<Record<string, string>>({})
const loadingId = ref<string | null>(null)
const failedId = ref<string | null>(null)
let playing = false

function setPlaying(next: boolean): void {
  playing = next
  emit('playing', next)
}

// Hidden mid-playback (the partner tapped Record): the audio stops without a pause event reaching us.
onBeforeUnmount(() => {
  if (playing) {
    setPlaying(false)
  }
})

async function listen(id: string): Promise<void> {
  loadingId.value = id
  failedId.value = null
  try {
    const blob = await props.loadAudio(id)
    audioUrls.value = { ...audioUrls.value, [id]: URL.createObjectURL(blob) }
  } catch (err) {
    console.error('Loading a past recording failed', err)
    failedId.value = id
  } finally {
    loadingId.value = null
  }
}

onUnmounted(() => Object.values(audioUrls.value).forEach((url) => URL.revokeObjectURL(url)))
</script>

<template>
  <div v-if="current || past.length > 0" class="flex w-full max-w-sm flex-col gap-4 text-start">
    <section v-if="current" class="panel flex flex-col gap-2 p-5" data-testid="current-feedback">
      <h2 class="font-display text-xl font-extrabold">Teacher Feedback</h2>
      <p class="whitespace-pre-line text-lg" dir="auto">{{ current }}</p>
    </section>

    <section v-if="past.length > 0" class="flex flex-col gap-3" data-testid="past-feedback">
      <h2 class="font-display text-xl font-extrabold">Past Feedback</h2>
      <article v-for="item in past" :key="item.id" class="flex flex-col gap-2 rounded-tile border-3 border-rule p-4">
        <p class="text-ink-soft">{{ describeVersion(`Recording ${item.version}`, item.sentAt, item.durationMs) }}</p>
        <p class="whitespace-pre-line" dir="auto">{{ item.feedback }}</p>
        <AudioPlayer
          v-if="audioUrls[item.id]"
          :src="audioUrls[item.id] ?? ''"
          :duration-ms="item.durationMs"
          autoplay
          @play="setPlaying(true)"
          @pause="setPlaying(false)"
          @ended="setPlaying(false)"
        />
        <button v-else class="btn btn-small self-start" :disabled="loadingId === item.id" @click="listen(item.id)">
          {{ loadingId === item.id ? 'Loading…' : 'Listen' }}
        </button>
        <p v-if="failedId === item.id" class="alert-bad" role="alert">That recording didn't load. Try again.</p>
      </article>
    </section>
  </div>
</template>
