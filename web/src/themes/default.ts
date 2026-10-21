import { createApp } from "vue";
import DefaultPage from "./DefaultPage.vue";
import type { ThemeContext } from "../../../theme-sdk";
export function mount(container: HTMLElement, context: ThemeContext) {
  const app = createApp(DefaultPage, { context });
  app.mount(container);
  return {
    dispose() {
      app.unmount();
    },
  };
}
