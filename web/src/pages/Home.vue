<script setup lang="ts">
import { useSite } from "@/lib/site";
const { homeTitle, description } = useSite();
import UploadContent from "@/components/UploadContent.vue";
</script>
<template>
  <main class="mx-auto max-w-3xl px-5 py-12 sm:py-20">
    <div class="mb-10 text-center">
      <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">
        {{ homeTitle }}
      </h1>
      <p class="mt-4 text-muted-foreground">{{ description }}</p>
    </div>
    <UploadContent />
  </main>
</template>
