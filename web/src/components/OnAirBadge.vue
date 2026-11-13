<template>
  <!-- Shown under the timer only while a take is recording; the dot pulses (stilled by the reduced-motion rule). -->
  <p
    class="inline-flex items-center gap-2 rounded-full border-2 border-rec bg-card px-3 py-1 text-sm font-extrabold tracking-wider text-rec uppercase"
    role="status"
    data-testid="on-air"
  >
    <span class="size-2.5 animate-rec-pulse rounded-full bg-rec" aria-hidden="true"></span>
    On Air
  </p>
</template>
