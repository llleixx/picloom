import { computed, ref, watch } from "vue";
export type Appearance = "auto" | "light" | "dark";
const read = (): Appearance => {
  try {
    const value = localStorage.getItem("theme");
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
};
const mode = ref<Appearance>(read());
const media = matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(media.matches);
media.addEventListener("change", (e) => {
  systemDark.value = e.matches;
});
window.addEventListener("storage", (e) => {
  if (e.key === "theme" || e.key === null) mode.value = read();
});
export const appearance = computed(() => mode.value);
export const darkMode = computed(
  () => mode.value === "dark" || (mode.value === "auto" && systemDark.value),
);
export function setAppearance(value: Appearance) {
  if (!["auto", "light", "dark"].includes(value)) return;
  mode.value = value;
  try {
    localStorage.setItem("theme", value);
  } catch {
    /* Use the in-memory preference. */
  }
}
watch(
  darkMode,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
    document.documentElement.style.colorScheme = value ? "dark" : "light";
  },
  { immediate: true },
);
