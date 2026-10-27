import { ref } from "vue";
import { ApiError, decodeError, onUnauthorized, session } from "./api";

export interface PackageUploadState {
  name: string;
  progress: number | null;
  inspecting: boolean;
}

export function usePackageUpload() {
  const state = ref<PackageUploadState | null>(null);

  async function upload<T>(path: string, file: File, body: File | FormData) {
    state.value = { name: file.name, progress: null, inspecting: false };
    try {
      return await new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", path);
        xhr.responseType = "json";
        if (session.value)
          xhr.setRequestHeader("X-CSRF-Token", session.value.csrfToken);
        xhr.upload.onprogress = (event) => {
          if (state.value && event.lengthComputable)
            state.value.progress = Math.floor((event.loaded / event.total) * 100);
        };
        xhr.upload.onload = () => {
          if (state.value) state.value.inspecting = true;
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
          else {
            reject(decodeError(xhr.response, xhr.status));
            if (xhr.status === 401) onUnauthorized();
          }
        };
        xhr.onerror = () => reject(new ApiError("REQUEST_NETWORK", ""));
        xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
        xhr.send(body);
      });
    } finally {
      state.value = null;
    }
  }

  return { state, upload };
}
