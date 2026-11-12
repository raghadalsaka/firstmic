<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MAX_FEEDBACK_LENGTH } from '../config'
import { api, errorMessage } from '../services/api'

const props = defineProps<{ saveUrl: string; initial: string | null }>()
const emit = defineEmits<{ saved: [] }>()

const draft = ref(props.initial ?? '')
const saving = ref(false)
const status = ref<string | null>(null)
const error = ref<string | null>(null)

watch(
  () => props.initial,
  (initial) => {
    draft.value = initial ?? ''
  },
)

const changed = computed(() => draft.value.trim() !== (props.initial ?? ''))

async function save(): Promise<void> {
  saving.value = true
  status.value = null
  error.value = null
  try {
    await api(props.saveUrl, { method: 'PUT', body: { text: draft.value } })
    status.value = draft.value.trim() ? 'Feedback saved. Students can see it.' : 'Feedback removed.'
    emit('saved')
  } catch (err) {
    error.value = errorMessage(err, 'Saving did not work. Try again.')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="flex flex-col gap-2" @submit.prevent="save">
    <label class="font-semibold">
      Feedback
      <textarea
        v-model="draft"
        class="field-input mt-1 min-h-24 text-base"
        :maxlength="MAX_FEEDBACK_LENGTH"
        dir="auto"
        placeholder="Write a comment the students will see"
        data-testid="feedback-input"
      ></textarea>
    </label>
    <div class="flex flex-wrap items-center gap-3">
      <button class="btn btn-primary btn-small" type="submit" :disabled="saving || !changed">Save Feedback</button>
      <p v-if="status" class="text-ink-soft" role="status">{{ status }}</p>
    </div>
    <p v-if="error" class="alert-bad" role="alert">{{ error }}</p>
  </form>
</template>
