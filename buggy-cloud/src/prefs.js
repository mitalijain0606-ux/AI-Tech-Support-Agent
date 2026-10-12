// Display preferences, applied with the platform's own Intl APIs. An invalid
// timezone / currency makes Intl throw a real RangeError — Buggy Cloud does
// not fake the failure, it just stores a bad value.

export const DEFAULT_PREFS = Object.freeze({ timezone: "UTC", locale: "en-US", currency: "USD" });
export const RESETTABLE = Object.freeze(["timezone", "locale", "currency"]);

export function loadPrefs(storage, key) {
  const raw = storage.getItem(key);
  return raw === null ? { ...DEFAULT_PREFS } : { ...DEFAULT_PREFS, ...JSON.parse(raw) };
}

export function formatDate(iso, prefs) {
  return new Intl.DateTimeFormat(prefs.locale, { timeZone: prefs.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function formatMoney(amount, prefs) {
  return new Intl.NumberFormat(prefs.locale, { style: "currency", currency: prefs.currency }).format(amount);
}

// The app's own handler for the Operon action: validates, resets one
// preference to its default, and nothing else.
export function resetPreference(storage, key, name) {
  if (typeof name !== "string" || !RESETTABLE.includes(name)) throw new Error(`'${String(name).slice(0, 30)}' is not a resettable preference`);
  let current = {};
  try {
    current = JSON.parse(storage.getItem(key) ?? "{}") ?? {};
  } catch {
    current = {};
  }
  storage.setItem(key, JSON.stringify({ ...DEFAULT_PREFS, ...current, [name]: DEFAULT_PREFS[name] }));
  return { detail: `reset ${name} to ${DEFAULT_PREFS[name]}` };
}
