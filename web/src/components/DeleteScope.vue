<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/lib/i18n";
withDefaults(
  defineProps<{
    scoped?: boolean;
    allowWhole?: boolean;
    preserveOption?: boolean;
    disabled?: boolean;
  }>(),
  { preserveOption: true },
);
const whole = defineModel<boolean>("whole", { default: false });
const includeLast = defineModel<boolean>("includeLast", { default: true });
const mode = defineModel<"delete" | "detach">("mode", { default: "delete" });
const preserveLast = computed({
  get: () => !includeLast.value,
  set: (value: boolean) => {
    includeLast.value = !value;
  },
});
</script>
<template>
  <fieldset :disabled="disabled" class="min-w-0 space-y-3">
    <label class="block space-y-2"
      ><span>{{ t("removal.mode") }}</span>
      <select v-model="mode" class="native-select w-full">
        <option value="delete">{{ t("removal.delete") }}</option>
        <option value="detach">{{ t("removal.detach") }}</option>
      </select>
    </label>
    <p class="subtle">
      {{ t(mode === "detach" ? "removal.detachHint" : "removal.deleteHint") }}
    </p>
    <label v-if="allowWhole" class="block space-y-2"
      ><span>{{ t("replicas.scope") }}</span>
      <select v-model="whole" class="native-select w-full">
        <option :value="false">{{ t("replicas.onlySource") }}</option>
        <option :value="true">{{ t("replicas.wholeImage") }}</option>
      </select>
    </label>
    <template v-if="scoped && !whole">
      <label v-if="preserveOption" class="flex items-start gap-2 text-sm"
        ><input v-model="preserveLast" type="checkbox" class="mt-1" />{{
          t("removal.preserveLast")
        }}</label
      >
    </template>
  </fieldset>
</template>
