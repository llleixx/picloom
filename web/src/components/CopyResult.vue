<script setup lang="ts">
import { computed } from "vue";
import { Copy, ChevronDown, Check, ExternalLink } from "lucide-vue-next";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItemIndicator,
} from "reka-ui";
import { t } from "@/lib/i18n";
import { copy } from "@/lib/api";
import {
  copyFormats,
  copyPreferences,
  formatLink,
  type CopyFormat,
} from "@/lib/link-formats";
import { Button } from "@/components/ui/button";
const props = defineProps<{
  url: string;
  label: string;
  compact?: boolean;
  openLink?: boolean;
}>();
const value = computed(() => formatLink(props.url, copyPreferences.format));
function setFormat(format: unknown) {
  copyPreferences.format = format as CopyFormat;
}
</script>
<template>
  <div
    class="flex min-w-0 items-center gap-1.5"
    role="group"
    :aria-label="t('ui.copy')"
  >
    <input
      :aria-label="label"
      readonly
      :value="value"
      class="native-select min-w-0 flex-1 text-xs"
    />
    <div class="inline-flex shrink-0 rounded-md border">
      <Button
        type="button"
        variant="ghost"
        class="gap-1.5 px-2 text-xs"
        :class="!compact && 'rounded-r-none'"
        @click="copy(value)"
      >
        <Copy :size="14" />{{ t("ui.copy")
        }}<span v-if="!compact">{{ copyPreferences.format }}</span>
      </Button>
      <DropdownMenuRoot v-if="!compact">
        <DropdownMenuTrigger as-child
          ><Button
            type="button"
            variant="ghost"
            size="icon"
            class="w-7 rounded-l-none border-l"
            :aria-label="t('uploads.copyFormat')"
            ><ChevronDown /></Button
        ></DropdownMenuTrigger>
        <DropdownMenuPortal
          ><DropdownMenuContent
            align="end"
            :side-offset="6"
            class="z-50 min-w-40 rounded-lg border bg-background p-1 shadow-lg"
          >
            <DropdownMenuRadioGroup
              :model-value="copyPreferences.format"
              @update:model-value="setFormat"
            >
              <DropdownMenuRadioItem
                v-for="format in copyFormats"
                :key="format"
                :value="format"
                class="relative cursor-default rounded py-2 pr-3 pl-7 text-sm outline-none data-[highlighted]:bg-muted"
              >
                <DropdownMenuItemIndicator class="absolute left-2"
                  ><Check :size="14" /></DropdownMenuItemIndicator
                >{{ format }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent></DropdownMenuPortal
        >
      </DropdownMenuRoot>
    </div>
    <a
      v-if="openLink"
      :href="url"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="t('linkBuilder.open')"
      :title="t('linkBuilder.open')"
      class="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      ><ExternalLink :size="16"
    /></a>
  </div>
</template>
