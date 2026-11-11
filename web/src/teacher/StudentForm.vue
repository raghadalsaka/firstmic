<script setup lang="ts">
import { computed, ref } from 'vue'
import StudentBadge from '../components/StudentBadge.vue'
import { MAX_NAME_LENGTH, PIN_LENGTH } from '../config'
import type { NewStudent, RosterStudent } from '../types/roster'
import { photoFromFile } from '../utils/photo'
import { emojiChoices, validateStudent } from '../utils/roster'

const props = defineProps<{
  // null adds a new student.
  student: RosterStudent | null
  suggestedEmoji: string
  pinsInUse: ReadonlySet<string>
  busy: boolean
}>()

const emit = defineEmits<{
  save: [student: NewStudent]
  newPin: []
  remove: []
  cancel: []
}>()

const name = ref(props.student?.name ?? '')
const emoji = ref(props.student?.emoji ?? props.suggestedEmoji)
const pin = ref(props.student?.pin ?? '')
const photo = ref<string | null>(props.student?.photo ?? null)
const readingPhoto = ref(false)
const error = ref('')

const isNew = computed(() => props.student === null)

function save(): void {
  const result = validateStudent({ name: name.value, emoji: emoji.value, pin: pin.value, photo: photo.value }, props.pinsInUse)
  if (!result.ok) {
    error.value = result.error
    return
  }
  error.value = ''
  emit('save', result.student)
}

async function pickPhoto(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file === undefined) {
    return
  }
  readingPhoto.value = true
  try {
    photo.value = await photoFromFile(file)
    error.value = ''
  } catch (caught) {
    console.warn('reading the photo failed', caught)
    error.value = "This photo couldn't be read. Try a JPEG or PNG picture."
  } finally {
    readingPhoto.value = false
  }
}
</script>

<template>
  <form class="grid gap-3 rounded-tile border-3 border-rule p-4" @submit.prevent="save">
    <h3 class="font-display text-xl font-extrabold">{{ isNew ? 'Add a student' : 'Edit student' }}</h3>
    <div class="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
      <label class="flex flex-col gap-1 font-semibold">
        Name
        <input v-model="name" class="field-input" :maxlength="MAX_NAME_LENGTH" dir="auto" required />
      </label>
      <label class="flex flex-col gap-1 font-semibold">
        Emoji
        <select v-model="emoji" class="field-input text-2xl" aria-label="Emoji">
          <option v-for="choice in emojiChoices(emoji)" :key="choice" :value="choice">{{ choice }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 font-semibold">
        PIN
        <input
          v-model="pin"
          class="field-input w-36 font-mono tracking-widest"
          inputmode="numeric"
          autocomplete="off"
          :maxlength="PIN_LENGTH"
          :placeholder="isNew ? 'Auto' : ''"
          :required="!isNew"
          aria-describedby="pin-help"
        />
      </label>
    </div>
    <p id="pin-help" class="text-base text-ink-soft">
      {{ isNew ? 'Leave the PIN empty and First Mic makes a random one.' : 'A new PIN signs this student out on every device.' }}
    </p>
    <div class="flex flex-wrap items-center gap-3">
      <StudentBadge :student="{ emoji, photo }" size="lg" />
      <div class="grid gap-2">
        <div class="flex flex-wrap gap-2">
          <label class="btn btn-small cursor-pointer has-focus-visible:outline-3 has-focus-visible:outline-offset-3 has-focus-visible:outline-ink">
            {{ photo === null ? 'Add Photo' : 'Change Photo' }}
            <input type="file" accept="image/*" class="sr-only" :disabled="readingPhoto" @change="pickPhoto" />
          </label>
          <button v-if="photo !== null" type="button" class="btn btn-small" :disabled="readingPhoto" @click="photo = null">Remove Photo</button>
        </div>
        <p class="text-base text-ink-soft">The photo shows instead of the emoji. Anyone who opens the class can see it.</p>
      </div>
    </div>
    <p v-if="error !== ''" role="alert" class="alert-bad">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <button type="submit" class="btn btn-small btn-primary" :disabled="readingPhoto || busy">{{ isNew ? 'Add Student' : 'Save' }}</button>
      <button v-if="!isNew" type="button" class="btn btn-small" :disabled="busy" @click="emit('newPin')">New PIN</button>
      <button type="button" class="btn btn-small" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button v-if="!isNew" type="button" class="btn btn-small" :disabled="busy" @click="emit('remove')">Remove Student</button>
    </div>
  </form>
</template>
