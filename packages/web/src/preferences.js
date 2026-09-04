import { useSyncExternalStore } from "react";

const COMPOSER_ENTER_NEW_LINE_KEY_PREFIX = "centaeris:composer-enter-new-line:v1:";
const PREFERENCE_CHANGED = "centaeris:input-preference-changed";

function key(userId) {
  return `${COMPOSER_ENTER_NEW_LINE_KEY_PREFIX}${userId}`;
}

export function readEnterStartsNewLine(userId) {
  try {
    return window.localStorage.getItem(key(userId)) === "1";
  } catch {
    return false;
  }
}

export function writeEnterStartsNewLine(userId, enabled) {
  try {
    if (enabled) window.localStorage.setItem(key(userId), "1");
    else window.localStorage.removeItem(key(userId));
  } catch {
    // Browser preferences are optional; the default input behavior remains available.
  }
  window.dispatchEvent(new Event(PREFERENCE_CHANGED));
}

function subscribe(listener) {
  window.addEventListener("storage", listener);
  window.addEventListener(PREFERENCE_CHANGED, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(PREFERENCE_CHANGED, listener);
  };
}

export function useEnterStartsNewLine(userId) {
  return useSyncExternalStore(subscribe, () => readEnterStartsNewLine(userId), () => false);
}
