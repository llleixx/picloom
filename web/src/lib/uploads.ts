import { copyPreferences, formatLink } from "./link-formats";
import { reactive } from "vue";
import type {
  ClientSettings,
  FileView,
  ChunkedUploadSession,
  UploadProfileView,
  UploadResult,
} from "../../../shared/api";
import {
  api,
  ApiError,
  copy,
  decodeError,
  errorValue,
  type DisplayMessage,
  onUnauthorized,
  queryClient,
  session,
  sessionCleanups,
} from "./api";
import type { OrganizationSelection } from "../../../shared/organization";
export interface UploadItem {
  organization?: OrganizationSelection;
  id: string;
  file: File;
  sourceUrl?: string;
  batchId: string;
  profileId: string;
  profileName: string;
  progress: number;
  status:
    | "queued"
    | "uploading"
    | "processing"
    | "success"
    | "failed"
    | "cancelled";
  resumable?: boolean;
  error?: DisplayMessage;
  result?: UploadResult;
  replaceId?: string;
}
interface Transfer {
  session?: ChunkedUploadSession;
  done: Set<number>;
  controller?: AbortController;
}
export const uploads = reactive<UploadItem[]>([]);
const transfers = new Map<string, Transfer>();
let active = 0;
// Queue and batch IDs are local to this page; no secure-context API is needed.
let nextId = 0;
// Session changes do not invalidate uploads already controlled by an upload key.
sessionCleanups.add(() => {
  for (const item of uploads) {
    if (
      (item.replaceId || !transfers.get(item.id)?.session) &&
      ["queued", "uploading", "processing"].includes(item.status)
    ) {
      item.status = "cancelled";
      transfers.get(item.id)?.controller?.abort();
    }
  }
});
export function enqueue(
  files: File[],
  profile: UploadProfileView,
  replaceId?: string,
  organization?: OrganizationSelection,
) {
  const batchId = String(++nextId);
  for (const file of files)
    uploads.push({
      id: String(++nextId),
      batchId,
      organization: organization
        ? {
            tagIds: [...organization.tagIds],
            collectionIds: [...organization.collectionIds],
          }
        : undefined,
      replaceId,
      file,
      profileId: profile.id,
      profileName: profile.name,
      progress: 0,
      status:
        !file.size || file.size > profile.maxUploadBytes ? "failed" : "queued",
      error:
        !file.size || file.size > profile.maxUploadBytes
          ? { key: "ui.fileIsEmptyOrExceedsTheUpload" }
          : undefined,
    });
  pump();
  return batchId;
}
export function enqueueUrls(
  urls: string[],
  profile: UploadProfileView,
  organization?: OrganizationSelection,
) {
  const batchId = String(++nextId);
  for (const url of urls)
    uploads.push({
      id: String(++nextId),
      batchId,
      sourceUrl: url,
      organization: organization
        ? {
            tagIds: [...organization.tagIds],
            collectionIds: [...organization.collectionIds],
          }
        : undefined,
      file: new File(
        [],
        new URL(url).pathname.split("/").pop() || "remote-image",
      ),
      profileId: profile.id,
      profileName: profile.name,
      progress: 0,
      status: "queued",
    });
  pump();
}
export function resumeUpload(item: UploadItem) {
  if (item.status !== "failed" || !item.resumable) return;
  item.status = "queued";
  item.error = undefined;
  pump();
}
export async function cancelUpload(item: UploadItem) {
  if (item.status === "processing" || item.result) return;
  const transfer = transfers.get(item.id);
  item.status = "cancelled";
  item.resumable = false;
  transfer?.controller?.abort();
  if (transfer?.session) {
    try {
      await api(`/api/uploads/${transfer.session.id}`, {
        method: "DELETE",
        headers: { "X-Upload-Key": transfer.session.uploadKey },
      });
    } catch (error) {
      item.error = errorValue(error);
    }
  }
  transfers.delete(item.id);
}
export async function dismissUpload(item: UploadItem) {
  if (!["failed", "cancelled"].includes(item.status)) return;
  await cancelUpload(item);
  const index = uploads.findIndex((upload) => upload.id === item.id);
  if (index >= 0) uploads.splice(index, 1);
}
function send<T>(
  method: string,
  path: string,
  body: XMLHttpRequestBodyInit,
  signal: AbortSignal,
  progress: (loaded: number, total: number) => void,
  transmitted?: () => void,
  uploadKey?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open(method, path);
    xhr.responseType = "json";
    xhr.timeout = 120_000;
    if (uploadKey) xhr.setRequestHeader("X-Upload-Key", uploadKey);
    else if (session.value)
      xhr.setRequestHeader("X-CSRF-Token", session.value.csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(e.loaded, e.total);
    };
    xhr.upload.onload = () => transmitted?.();
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
      else {
        reject(decodeError(xhr.response, xhr.status));
        if (xhr.status === 401) onUnauthorized();
      }
    };
    xhr.onerror = xhr.ontimeout = () => reject(new ApiError("NETWORK", ""));
    xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}
const retryable = (error: unknown) =>
  !(error instanceof ApiError) ||
  error.status === 0 ||
  error.status === 429 ||
  error.status >= 500;
async function run(
  item: UploadItem,
  transfer: Transfer,
  signal: AbortSignal,
  settings: ClientSettings,
) {
  signal.throwIfAborted();
  if (item.sourceUrl) {
    item.status = "processing";
    return api<UploadResult>("/api/files/from-url", {
      method: "POST",
      signal,
      body: JSON.stringify({
        url: item.sourceUrl,
        profileId: item.profileId,
        organization: item.organization,
      }),
    });
  }
  if (item.file.size <= settings.chunkedUpload.thresholdBytes) {
    const form = new FormData();
    form.set("file", item.file);
    form.set("profileId", item.profileId);
    if (item.organization)
      form.set("organization", JSON.stringify(item.organization));
    return send<UploadResult>(
      "POST",
      "/api/files",
      form,
      signal,
      (loaded, total) => {
        item.progress = Math.round((loaded / total) * 100);
      },
      () => {
        item.progress = 100;
        item.status = "processing";
      },
    );
  }
  if (!transfer.session) {
    // Creation is not automatically retried: a lost response leaves only expiring temporary state.
    transfer.session = await api<ChunkedUploadSession>("/api/uploads", {
      method: "POST",
      signal,
      body: JSON.stringify({
        profileId: item.profileId,
        organization: item.organization,
        size: item.file.size,
        name: item.file.name,
      }),
    });
  }
  const upload = transfer.session;
  const count = Math.ceil(item.file.size / upload.partSize);
  const loaded = Array.from({ length: count }, (_, index) =>
    transfer.done.has(index)
      ? Math.min(upload.partSize, item.file.size - index * upload.partSize)
      : 0,
  );
  const progress = () => {
    item.progress = Math.floor(
      (loaded.reduce((a, b) => a + b, 0) / item.file.size) * 100,
    );
  };
  progress();
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (!failure && next < count) {
      const index = next++;
      if (transfer.done.has(index)) continue;
      const part = item.file.slice(
        index * upload.partSize,
        (index + 1) * upload.partSize,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          signal.throwIfAborted();
          await send(
            "PUT",
            `/api/uploads/${upload.id}/parts/${index}`,
            part,
            signal,
            (bytes) => {
              loaded[index] = bytes;
              progress();
            },
            undefined,
            upload.uploadKey,
          );
          transfer.done.add(index);
          loaded[index] = part.size;
          progress();
          break;
        } catch (error) {
          loaded[index] = 0;
          progress();
          if (signal.aborted || !retryable(error) || attempt === 2) {
            failure = error;
            break;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1)),
          );
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(count, settings.chunkedUpload.concurrency) },
      () => worker(),
    ),
  );
  if (failure) {
    item.resumable = !signal.aborted && retryable(failure);
    throw failure;
  }
  signal.throwIfAborted();
  item.status = "processing";
  try {
    return await api<UploadResult>(`/api/uploads/${upload.id}/complete`, {
      method: "POST",
      signal,
      headers: { "X-Upload-Key": upload.uploadKey },
    });
  } catch (error) {
    // Retrying the same completion is safe: the server keeps its result.
    item.resumable = !signal.aborted && retryable(error);
    throw error;
  }
}
let pumping = false;
async function pump() {
  if (pumping || !uploads.some((item) => item.status === "queued")) return;
  pumping = true;
  try {
    const settings = await queryClient.fetchQuery({
      queryKey: ["client-settings"],
      queryFn: () => api<ClientSettings>("/api/client-settings"),
    });
    while (active < settings.uploadConcurrency) {
      const item = uploads.find((item) => item.status === "queued");
      if (!item) return;
      active++;
      item.status = "uploading";
      item.resumable = false;
      const transfer = transfers.get(item.id) ?? { done: new Set<number>() };
      transfer.controller = new AbortController();
      transfers.set(item.id, transfer);
      void run(item, transfer, transfer.controller.signal, settings)
        .then(async (result) => {
          if (item.replaceId) {
            const signal = transfer.controller!.signal;
            signal.throwIfAborted();
            item.status = "processing";
            const deadline = Date.now() + 300_000;
            for (;;) {
              signal.throwIfAborted();
              if (Date.now() > deadline)
                throw new ApiError("REPLACEMENT_BUSY", "");
              const candidate = await api<FileView>(`/api/files/${result.id}`, {
                signal,
              });
              if (!candidate.backgroundPending) break;
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            result = await api<UploadResult>(
              `/api/files/${item.replaceId}/replace`,
              {
                signal,
                method: "POST",
                body: JSON.stringify({
                  replacementId: result.id,
                  replacementPath: new URL(result.url, location.origin)
                    .pathname,
                }),
              },
            );
          }
          if (item.status === "cancelled") return;
          item.status = "success";
          item.result = result;
          transfers.delete(item.id);
          void queryClient.invalidateQueries({ queryKey: ["files"] });
          void queryClient.invalidateQueries({ queryKey: ["organization"] });
        })
        .catch((error) => {
          if (item.status === "cancelled") return;
          item.status = "failed";
          item.error = errorValue(error);
        })
        .finally(() => {
          active--;
          if (item.replaceId)
            void queryClient.invalidateQueries({ queryKey: ["files"] });
          void queryClient.invalidateQueries({ queryKey: ["organization"] });
          if (copyPreferences.auto && !item.replaceId) {
            const batch = uploads.filter(
              (upload) => upload.batchId === item.batchId,
            );
            if (
              batch.every((upload) =>
                ["success", "failed", "cancelled"].includes(upload.status),
              )
            ) {
              const results = batch.filter((upload) => upload.result);
              if (results.length)
                void copy(
                  results
                    .map((upload) =>
                      formatLink(upload.result!.url, copyPreferences.format),
                    )
                    .join("\n"),
                );
            }
          }
          pump();
        });
    }
  } catch (error) {
    for (const item of uploads.filter((x) => x.status === "queued")) {
      item.status = "failed";
      item.error = errorValue(error);
    }
  } finally {
    pumping = false;
  }
}
