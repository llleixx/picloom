import { injectDialogRootContext } from "reka-ui";

export function useMenuDialogFocus() {
  const dialog = injectDialogRootContext();
  return () => {
    // A selected menu item is removed when its menu closes. Return to the
    // persistent menu trigger instead when the dialog subsequently closes.
    const menu = dialog.triggerElement.value?.closest('[role="menu"]');
    const triggerId = menu?.getAttribute("aria-labelledby");
    const trigger = triggerId ? document.getElementById(triggerId) : null;
    if (trigger) dialog.triggerElement.value = trigger;
  };
}
