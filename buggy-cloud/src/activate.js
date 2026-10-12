// Switching a bug on. `?bug=N` selects it; this file decides what that means
// for the browser (seed storage, register a worker). Server-side bugs (4-6)
// need nothing here: the API helpers read the same number.
//
// Seeded storage is planted ONCE per browser profile (a marker records it), so
// a fix that removes the bad value stays fixed after a reload instead of the
// bug re-planting itself.

import { bugById, PREFS_KEY, SETTINGS_KEY } from "./bugs.js";

const SEEDED_MARKER = "buggycloud_seeded";

export function activeBug(search) {
  const raw = new URLSearchParams(search).get("bug");
  if (raw === null || !/^\d{1,2}$/.test(raw)) return null;
  return bugById(Number(raw));
}

export function seedBug(bug, storage) {
  if (!bug || storage.getItem(SEEDED_MARKER) === String(bug.id)) return false;
  switch (bug.slug) {
    case "corrupt-settings":
      storage.setItem(SETTINGS_KEY, "{broken");
      break;
    case "invalid-timezone":
      storage.setItem(PREFS_KEY, JSON.stringify({ timezone: "Mars/Phobos", locale: "en-US", currency: "USD" }));
      break;
    case "invalid-currency":
      storage.setItem(PREFS_KEY, JSON.stringify({ timezone: "UTC", locale: "en-US", currency: "US" }));
      break;
    default:
      return false;
  }
  storage.setItem(SEEDED_MARKER, String(bug.id));
  return true;
}

/**
 * Puts the demo back to a clean slate so a scenario can be run again: removes everything Buggy Cloud
 * ever stored (settings, preferences, the "already seeded" marker) and unregisters its service
 * workers. Only this app's own keys; nothing else in storage is touched.
 */
export async function resetScenario(storage, nav = navigator) {
  for (const key of [SETTINGS_KEY, PREFS_KEY, SEEDED_MARKER, "buggycloud_sw_seeded"]) storage.removeItem(key);
  let unregistered = 0;
  try {
    for (const registration of (await nav.serviceWorker?.getRegistrations?.()) ?? []) if (await registration.unregister()) unregistered++;
  } catch {
    /* no service worker support: nothing to remove */
  }
  return { unregistered };
}

export function wantsReset(search) {
  return new URLSearchParams(search).get("reset") === "1";
}

// Bug 7: a worker is registered once and keeps "serving" a chunk manifest from
// an older deploy for as long as it stays registered.
export async function ensureStaleWorker(bug, storage, nav = navigator) {
  if (bug?.slug !== "stale-service-worker" || !nav.serviceWorker) return false;
  if (storage.getItem(SEEDED_MARKER) !== String(bug.id)) {
    await nav.serviceWorker.register("/sw.js", { scope: "/" });
    storage.setItem(SEEDED_MARKER, String(bug.id));
  }
  return (await nav.serviceWorker.getRegistrations()).length > 0;
}
