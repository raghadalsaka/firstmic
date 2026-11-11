<script setup lang="ts">
// QuestRush's PawnBadge: the student's photo when there is a valid one, otherwise their emoji.
import { computed } from 'vue'
import { shownPhoto } from '../utils/photo'

type BadgeSize = 'sm' | 'md' | 'lg'

const SIZES: Record<BadgeSize, string> = {
  sm: 'size-10 text-xl border-2',
  md: 'size-16 text-4xl border-3',
  lg: 'size-24 text-6xl border-3',
}

const props = defineProps<{
  student: { emoji: string; photo: string | null }
  size: BadgeSize
}>()

const photo = computed(() => shownPhoto(props.student.photo))
</script>

<template>
  <span class="grid shrink-0 place-items-center overflow-hidden rounded-full border-ink bg-card leading-none" :class="SIZES[size]" aria-hidden="true">
    <img v-if="photo !== null" :src="photo" alt="" class="size-full object-cover" />
    <span v-else>{{ student.emoji }}</span>
  </span>
</template>
