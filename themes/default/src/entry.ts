import { createApp } from "vue";
import Page from "./Page.vue";
import type { ThemeContext } from "@picloom/theme-sdk";
import "./style.css";
export function mount(container: HTMLElement, context: ThemeContext) {
  const app = createApp(Page, { context });
  app.mount(container);
  return {
    dispose() {
      app.unmount();
    },
  };
}
