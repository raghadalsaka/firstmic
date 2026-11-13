<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import { api, errorMessage } from '../services/api'
import { classPath } from '../utils/slug'
import CreatorCredit from './CreatorCredit.vue'

type PublicClass = { name: string; classToken: string }

const classes = shallowRef<PublicClass[] | null>(null)
const error = ref('')

async function load(): Promise<void> {
  error.value = ''
  try {
    classes.value = (await api<{ classes: PublicClass[] }>('/api/classes')).classes
  } catch (caught) {
    error.value = errorMessage(caught, "Can't load the classes. Check your internet and try again.")
  }
}

onMounted(load)
</script>

<template>
  <main class="mx-auto grid max-w-4xl content-start gap-6 px-4 py-8">
    <header>
      <p class="font-display text-2xl font-extrabold">First Mic</p>
    </header>

    <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h1 class="font-display text-4xl font-extrabold">Pick your class</h1>
      <CreatorCredit />
    </div>
    <div v-if="error !== ''" role="alert" class="alert-bad grid justify-items-start gap-2">
      <p>{{ error }}</p>
      <button type="button" class="btn btn-small" @click="load">Try Again</button>
    </div>
    <p v-else-if="classes === null" role="status" class="text-xl">Loading the classes…</p>
    <p v-else-if="classes.length === 0" class="text-xl">No classes yet. Ask your teacher for your class link.</p>
    <ul v-else class="grid gap-3 sm:grid-cols-2">
      <li v-for="item in classes" :key="item.classToken">
        <RouterLink :to="classPath(item.classToken, item.name)" class="btn btn-large w-full" dir="auto">{{ item.name }}</RouterLink>
      </li>
    </ul>
  </main>
</template>
