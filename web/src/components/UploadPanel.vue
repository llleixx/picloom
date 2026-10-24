<script setup lang="ts">
import { t } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import UploadContent from "./UploadContent.vue";
defineProps<{ collectionId?: string }>();
const open = defineModel<boolean>("open", { required: true });
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
      <DialogTitle>{{ t("ui.uploadImages") }}</DialogTitle>
      <DialogDescription>{{
        t("ui.dropPasteOrSelectImages")
      }}</DialogDescription>
      <UploadContent :active="open" :collection-id="collectionId" />
    </DialogContent>
  </Dialog>
</template>
