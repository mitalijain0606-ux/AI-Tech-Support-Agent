# Buggy Cloud

A small, deliberately broken web app: the second application used to show that
Operon is not a GitHub-only tool. Plain JavaScript modules, no build step.

```bash
npm start            # http://127.0.0.1:4300  (reports API on :4301)
npm test             # unit tests for the app's own logic
```

`?bug=N` switches on one defect. Each is deterministic, and its ground-truth
diagnosis lives next to it in `src/bugs.js`:

| `?bug=` | Defect (what the app really does) | Correct outcome |
|---|---|---|
| 1 | corrupted `buggycloud_settings` JSON in localStorage | `storage_corruption` → `clear_storage_key` |
| 2 | saved timezone `Mars/Phobos` → `Intl` throws `RangeError` | `invalid_preference` → `reset_user_preference` (timezone) |
| 3 | saved currency `US` → `Intl` throws `RangeError` | `invalid_preference` → `reset_user_preference` (currency) |
| 4 | `/api/projects` answers 500 | `network_error`, no action |
| 5 | `/api/me` answers 401 | `auth_failure`, no action |
| 6 | reports API on another origin sends no CORS header | `network_error`, no action |
| 7 | a service worker stays registered and the lazy chunk fails | `service_worker_stale` → `unregister_service_worker` |

Layout: `src/bugs.js` (definitions + expected diagnoses), `src/activate.js`
(how a bug is switched on; seeded storage is planted once so a fix stays
fixed), `src/prefs.js` (Intl formatting + the app's own reset handler),
`src/api.js` (API helpers), `src/mock-data.js`, `src/ui.js` (rendering only),
`src/main.js` (wiring + the Operon SDK registration), `server.mjs` (static
files, mock API, second origin).

End-to-end proof: `cd extension && npm run e2e:buggy` drives the real built
extension and real backend against all seven bugs plus a healthy control
(57 checks), and fails if a diagnosis, an action, an approval gate or a
backend verification differs from the ground truth above.
