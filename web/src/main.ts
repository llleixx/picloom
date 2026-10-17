import { createApp } from "vue";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { queryClient } from "./lib/api";
import { router } from "./router";
import App from "./App.vue";
import "./style.css";
createApp(App).use(VueQueryPlugin, { queryClient }).use(router).mount("#app");
