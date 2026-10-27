<script setup lang="ts">
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
defineProps<{ title: string; help: string }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ confirm: [] }>();
</script>
<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogTitle class="pr-6"
        >{{ t("ui.editTranslations") }} · {{ title }}</DialogTitle
      >
      <DialogDescription>{{ help }}</DialogDescription>
      <slot />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" @click="open = false">{{
          t("ui.cancel")
        }}</Button>
        <Button type="button" @click="emit('confirm')">{{
          t("ui.confirm")
        }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
