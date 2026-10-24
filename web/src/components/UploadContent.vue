<script setup lang="ts">
import { isSiteAdmin } from "../../../shared/roles";

import { t } from "@/lib/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { CloudUpload, Check, LoaderCircle, Copy } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import type { UploadProfileView, UploadDefaults } from "../../../shared/api";
import {
  session,
  api,
  copy,
  errorMessage,
  errorText,
  notify,
  messageText,
} from "@/lib/api";
import { size } from "@/lib/utils";
import {
  uploads,
  enqueue,
  enqueueUrls,
  resumeUpload,
  cancelUpload,
  dismissUpload,
} from "@/lib/uploads";
import OrganizationPicker from "./OrganizationPicker.vue";
import CopySettings from "../../../themes/default/src/CopySettings.vue";
import UploadOptions from "../../../themes/default/src/UploadOptions.vue";
import CopyResult from "./CopyResult.vue";
import ImagePreview from "./ImagePreview.vue";
import {
  copyFormats,
  copyPreferences,
  formatLink,
  type CopyFormat,
} from "@/lib/link-formats";
const props = withDefaults(
  defineProps<{ active?: boolean; collectionId?: string }>(),
  {
    active: true,
  },
);
const open = computed(() => props.active);
const tagPicker = ref<InstanceType<typeof OrganizationPicker>>(),
  collectionPicker = ref<InstanceType<typeof OrganizationPicker>>();
const tagIds = ref<string[]>([]),
  collectionIds = ref<string[]>([]);
watch(
  () => [props.collectionId, props.active],
  () => {
    if (props.active) {
      tagIds.value = [];
      collectionIds.value = props.collectionId ? [props.collectionId] : [];
    }
  },
  { immediate: true },
);
const profiles = useQuery({
  queryKey: computed(() => ["profiles", session.value?.user.id ?? "guest"]),
  queryFn: ({ signal }) =>
    api<UploadProfileView[]>("/api/upload-profiles", { signal }),
  enabled: open,
});
const defaults = useQuery({
  queryKey: computed(() => [
    "upload-defaults",
    session.value?.user.id ?? "guest",
  ]),
  queryFn: ({ signal }) =>
    api<UploadDefaults>("/api/upload-defaults", { signal }),
  enabled: open,
});
const preferenceKey = computed(
  () => "uploadProfile:" + (session.value?.user.id ?? "guest"),
);
const remembered = ref(""),
  selected = ref(""),
  input = ref<HTMLInputElement>(),
  dragging = ref(false);
watch(
  preferenceKey,
  (key) => {
    try {
      remembered.value = localStorage.getItem(key) ?? "";
    } catch {
      remembered.value = "";
    }
    selected.value = "";
  },
  { immediate: true },
);
watch(
  [profiles.data, defaults.data, remembered],
  ([values, preferred]) => {
    if (
      values &&
      !profiles.isError.value &&
      remembered.value &&
      !values.some((p) => p.id === remembered.value && p.enabled)
    ) {
      try {
        localStorage.removeItem(preferenceKey.value);
      } catch {}
      remembered.value = "";
    }
    selected.value = remembered.value || preferred?.defaultProfileId || "";
  },
  { immediate: true },
);
function rememberSelection() {
  remembered.value = selected.value;
  try {
    localStorage.setItem(preferenceKey.value, selected.value);
  } catch {}
}
const profile = computed(() =>
  profiles.data.value?.find((p) => p.id === selected.value && p.available),
);
function add(files: File[]) {
  if (!profile.value) {
    notify({ key: "ui.selectAnAvailableUploadProfile" });
    return;
  }
  enqueue(
    files,
    profile.value,
    undefined,
    session.value
      ? { tagIds: tagIds.value, collectionIds: collectionIds.value }
      : undefined,
  );
}
function copyAll() {
  return copy(
    uploads
      .filter((item) => item.result)
      .map((item) => formatLink(item.result!.url, copyPreferences.format))
      .join("\n"),
  );
}
function setCopyPreferences(format: string, auto: boolean) {
  copyPreferences.format = format as CopyFormat;
  copyPreferences.auto = auto;
}
function paste(event: ClipboardEvent) {
  if (!open.value || !event.clipboardData) return;
  if (event.clipboardData.files.length) {
    event.preventDefault();
    add(Array.from(event.clipboardData.files));
    return;
  }
  if (
    (event.target as HTMLElement)?.closest("input, textarea, [contenteditable]")
  )
    return;
  const text = event.clipboardData.getData("text/plain").trim();
  if (!text) return;
  const urls = text.split(/\s+/);
  if (
    !urls.every((value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    })
  )
    return;
  event.preventDefault();
  if (!profile.value) {
    notify({ key: "ui.selectAnAvailableUploadProfile" });
    return;
  }
  enqueueUrls(
    urls,
    profile.value,
    session.value
      ? { tagIds: tagIds.value, collectionIds: collectionIds.value }
      : undefined,
  );
}
onMounted(() => window.addEventListener("paste", paste));
onUnmounted(() => window.removeEventListener("paste", paste));
</script>
<template>
  <div class="space-y-4">
    <p v-if="profiles.isPending.value" class="subtle">
      {{ t("ui.loading") }}
    </p>
    <div v-else-if="profiles.error.value" class="error-box">
      {{ errorText(profiles.error.value)
      }}<Button variant="ghost" size="sm" @click="profiles.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <div
      class="upload-dropzone"
      :class="dragging ? 'border-primary bg-primary/5' : 'border-border'"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="
        dragging = false;
        add(Array.from($event.dataTransfer?.files ?? []));
      "
    >
      <div class="absolute top-2 right-2 z-10">
        <CopySettings
          :format="copyPreferences.format"
          :formats="copyFormats"
          :auto="copyPreferences.auto"
          :t="t"
          @change="setCopyPreferences"
        />
      </div>
      <div
        class="cursor-pointer rounded-2xl px-4 pt-16 pb-8 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:px-6 sm:pb-12"
        role="button"
        tabindex="0"
        :aria-label="t('ui.dropImagesHere')"
        :aria-disabled="!profile"
        @click="profile && input?.click()"
        @keydown.enter.self.prevent="profile && input?.click()"
        @keydown.space.self.prevent="profile && input?.click()"
      >
        <CloudUpload class="mx-auto mb-4 text-primary" :size="32" />
        <p class="mb-2 text-sm font-medium">{{ t("ui.dropImagesHere") }}</p>
        <p class="mb-5 text-xs text-muted-foreground">
          {{ t("ui.orPasteFromYourClipboard") }}
        </p>
        <Button :disabled="!profile" @click.stop="input?.click()">{{
          t("ui.chooseFiles")
        }}</Button>
        <input
          @click.stop
          ref="input"
          data-testid="upload-input"
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          @change="
            add(Array.from(input?.files ?? []));
            if (input) input.value = '';
          "
        />
        <p v-if="profile" class="mt-4 text-xs text-muted-foreground">
          {{ t("uploads.limit", { size: size(profile.maxUploadBytes) }) }} ·
          {{
            profile.allowedMimeTypes
              .map((t) => t.replace("image/", ""))
              .join(" / ")
          }}
        </p>
      </div>
    </div>
    <UploadOptions
      :tags="tagPicker?.selectedItems ?? []"
      :collections="collectionPicker?.selectedItems ?? []"
      :signed-in="!!session"
      :t="t"
      @remove="
        (kind, id) => {
          if (kind === 'tags') tagIds = tagIds.filter((value) => value !== id);
          else collectionIds = collectionIds.filter((value) => value !== id);
        }
      "
    >
      <template #profile>
        <label class="upload-profile">
          <select
            v-model="selected"
            @change="rememberSelection"
            :aria-label="t('ui.uploadProfile')"
          >
            <option value="" disabled>{{ t("ui.selectAProfile") }}</option>
            <option
              v-for="p in profiles.data.value"
              :key="p.id"
              :value="p.id"
              :disabled="!p.available"
            >
              {{ p.name
              }}{{ p.available ? "" : ` · ${errorMessage(p.reasonCode)}` }}
            </option>
          </select>
        </label>
      </template>
      <template #tags
        ><OrganizationPicker
          ref="tagPicker"
          v-model="tagIds"
          kind="tags"
          compact
      /></template>
      <template #collections
        ><OrganizationPicker
          ref="collectionPicker"
          v-model="collectionIds"
          kind="collections"
          compact
      /></template>
    </UploadOptions>
    <p v-if="defaults.error.value" class="error-box">
      {{ errorText(defaults.error.value) }}
    </p>
    <p
      v-if="!profiles.isPending.value && !defaults.isPending.value && !profile"
      class="error-box"
    >
      {{
        profiles.data.value?.some((p) => p.available)
          ? t("profiles.required")
          : !session
            ? t("users.guestUnavailable")
            : isSiteAdmin(session.user.role)
              ? t("ui.noAvailableProfilesCheckProfileAndPlugin")
              : t("users.noProfiles")
      }}
    </p>
    <div v-if="uploads.length" class="space-y-3 border-t pt-4">
      <h3 class="text-sm font-medium">
        {{ t("ui.uploadQueue") }}
        <span class="text-muted-foreground"
          >{{ uploads.filter((u) => u.status === "success").length }} /
          {{ uploads.length }}</span
        >
      </h3>
      <Button
        v-if="uploads.some((item) => item.result)"
        variant="outline"
        size="sm"
        @click="copyAll"
      >
        <Copy />{{ t("uploads.copyAll") }}
      </Button>
      <div
        v-for="item in uploads"
        :key="item.id"
        class="rounded-lg border p-3"
        data-testid="upload-row"
      >
        <div class="flex gap-3">
          <div
            v-if="item.result"
            class="size-12 shrink-0 overflow-hidden rounded"
          >
            <ImagePreview :src="item.result.url" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">{{ item.file.name }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ item.sourceUrl ? t("uploads.fromUrl") : size(item.file.size) }}
              · {{ item.profileName }}
            </p>
          </div>
          <Check
            v-if="item.status === 'success'"
            class="text-emerald-600"
            :size="18"
          /><LoaderCircle
            v-else-if="['uploading', 'processing'].includes(item.status)"
            :size="18"
            class="animate-spin text-primary"
          />
        </div>
        <p class="mt-2 text-xs" aria-live="polite">
          {{
            {
              cancelled: messageText(item.error) || t("uploads.cancelled"),
              queued: t("ui.queued"),
              uploading: t("uploads.progress", { progress: item.progress }),
              processing: t("ui.processingOnServer"),
              success: t("ui.uploaded"),
              failed: messageText(item.error),
            }[item.status]
          }}
        </p>
        <progress
          v-if="item.status === 'uploading'"
          :value="item.progress"
          max="100"
          class="mt-2 h-1 w-full accent-primary"
          :aria-label="t('ui.uploadProgress')"
        />
        <div class="mt-2 flex gap-2">
          <Button
            v-if="item.status === 'failed' && item.resumable"
            variant="outline"
            size="sm"
            @click="resumeUpload(item)"
            >{{ t("uploads.continue") }}</Button
          >
          <Button
            v-if="['queued', 'uploading'].includes(item.status)"
            variant="ghost"
            size="sm"
            @click="cancelUpload(item)"
            >{{ t("ui.cancel") }}</Button
          >
          <Button
            v-if="['failed', 'cancelled'].includes(item.status)"
            variant="ghost"
            size="sm"
            @click="dismissUpload(item)"
            >{{ t("uploads.dismiss") }}</Button
          >
        </div>
        <CopyResult
          v-if="item.result"
          compact
          class="mt-3"
          :url="item.result.url"
          :label="t('uploads.result')"
        />
      </div>
    </div>
  </div>
</template>
