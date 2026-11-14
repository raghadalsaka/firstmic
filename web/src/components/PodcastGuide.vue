<script setup lang="ts">
import { computed, useId } from 'vue'
import { GUIDE_SPLIT, guideSections, type GuideMode, type TopicGuide } from '../utils/guide'

const props = defineProps<{
  guide: TopicGuide | null | undefined
  mode: GuideMode
  /** Recording screens: the open guide scrolls inside a box that can shrink, so the timer and Record/Stop stay on screen. */
  compact?: boolean
}>()

// Opening or closing the guide only changes this flag; it never touches the recorder, the call or the timer.
const open = defineModel<boolean>('open', { default: false })
const panelId = useId()
const sections = computed(() => guideSections(props.guide, props.mode))
</script>

<template>
  <div
    v-if="sections.length > 0"
    class="flex w-full max-w-sm flex-col items-center gap-3"
    :class="[compact ? '-mt-3' : '', compact && open ? 'min-h-31' : '', open ? GUIDE_SPLIT.guide : '']"
    data-testid="podcast-guide"
  >
    <button
      type="button"
      class="btn btn-small shrink-0"
      :class="GUIDE_SPLIT.toggle"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="open = !open"
    >
      {{ open ? 'Hide Podcast Guide' : 'View Podcast Guide' }}
    </button>
    <div
      v-show="open"
      :id="panelId"
      class="flex w-full flex-col gap-3 rounded-tile border-3 border-rule bg-card text-start"
      :class="[compact ? 'max-h-64 min-h-18 overflow-y-auto overscroll-contain p-3' : 'p-4', GUIDE_SPLIT.panel]"
      role="region"
      aria-label="Podcast Guide"
      :tabindex="compact ? 0 : undefined"
    >
      <section v-for="section in sections" :key="section.key" :data-testid="`guide-${section.key}`">
        <h2 class="font-display text-base font-extrabold">{{ section.label }}</h2>
        <p class="break-words whitespace-pre-line text-ink" dir="auto">{{ section.text }}</p>
      </section>
    </div>
  </div>
</template>
