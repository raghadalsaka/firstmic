<script setup lang="ts">
import AudioPlayer from '../components/AudioPlayer.vue'
import { describeVersion } from '../utils/format'

export type PastVersion = {
  id: string
  version: number
  duration_ms: number | null
  sent_at: number
  feedback: string | null
  has_audio: number
  /** Group podcasts only: each student's voice, while the version still has its files. */
  voices?: { track_id: string; name: string }[]
}

defineProps<{ versions: PastVersion[]; audioPath: (id: string) => string }>()
</script>

<template>
  <details v-if="versions.length > 0" class="rounded-tile bg-board p-3" data-testid="version-history">
    <summary class="cursor-pointer font-semibold">Earlier versions ({{ versions.length }})</summary>
    <ul class="mt-3 flex flex-col gap-3">
      <li v-for="item in versions" :key="item.id" class="flex flex-col gap-2 border-t-2 border-rule pt-3" data-testid="past-version">
        <p class="text-ink-soft">{{ describeVersion(`Version ${item.version}`, item.sent_at, item.duration_ms) }}</p>
        <p v-if="item.feedback" class="whitespace-pre-line" dir="auto">{{ item.feedback }}</p>
        <template v-if="item.has_audio">
          <AudioPlayer :src="audioPath(item.id)" :duration-ms="item.duration_ms" preload="none" />
          <div class="flex flex-wrap gap-3">
            <a class="btn btn-small" :href="`${audioPath(item.id)}?download=1`">{{ item.voices ? 'Download Mix' : 'Download' }}</a>
            <a
              v-for="voice in item.voices ?? []"
              :key="voice.track_id"
              class="btn btn-small"
              :href="`${audioPath(item.id)}?voice=${voice.track_id}&download=1`"
              dir="auto"
            >
              {{ voice.name }}'s Voice
            </a>
          </div>
        </template>
        <p v-else class="text-ink-soft">No feedback, so the audio was deleted when a newer version was sent.</p>
      </li>
    </ul>
  </details>
</template>
