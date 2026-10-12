// The extension's side of the Operon SDK protocol (sdk/operon-sdk.js in the
// repository root): ask the page which app-specific actions it offers, and ask
// it to run one. Runs in the content script, talking to the page over
// window.postMessage.
//
// The page is untrusted. What it announces is intersected with a closed list
// here, parameters are validated here before anything is sent, and an answer
// from the page can only ever say "done" or "failed" — it can't make Operon do
// anything. The backend independently decides whether an action may be
// proposed, and the user approves it, before this code is ever asked to invoke.

export const APP_ACTIONS = ["reset_user_preference"] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
export const RESETTABLE_PREFERENCES = ["timezone", "locale", "currency", "date_format"];

const PROTOCOL = 1;
// Discovery is a cheap question: a page without the SDK never answers, so keep the wait short.
// Invoking runs the app's own handler (which may repaint or call its API), so it gets longer than the
// SDK's own handler timeout (10 s) — the SDK then always answers, even if the handler hangs.
export const DISCOVER_TIMEOUT_MS = 1500;
export const INVOKE_TIMEOUT_MS = 15_000;

interface MessageTarget {
  postMessage(message: unknown, origin: string): void;
  addEventListener(type: "message", listener: (event: { source: unknown; data: any }) => void): void;
  removeEventListener(type: "message", listener: (event: { source: unknown; data: any }) => void): void;
  location: { origin: string };
}

let counter = 0;

function ask(win: MessageTarget, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any> | null> {
  const id = `op_${Date.now().toString(36)}_${counter++}`;
  return new Promise((resolve) => {
    const finish = (value: Record<string, any> | null) => {
      clearTimeout(timer);
      win.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: { source: unknown; data: any }) => {
      const msg = event.data;
      if (event.source !== win || !msg || msg.operon !== PROTOCOL || msg.from !== "app" || msg.id !== id) return;
      finish(msg);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    win.addEventListener("message", onMessage);
    win.postMessage({ operon: PROTOCOL, from: "extension", id, ...body }, win.location.origin);
  });
}

/** The closed-list actions this page's SDK says it offers (empty without an SDK). */
export async function discoverAppActions(win: MessageTarget, timeoutMs = DISCOVER_TIMEOUT_MS): Promise<AppAction[]> {
  const reply = await ask(win, { type: "discover" }, timeoutMs);
  if (!reply || reply.type !== "capabilities" || !Array.isArray(reply.actions)) return [];
  return APP_ACTIONS.filter((a) => reply.actions.includes(a));
}

/** Asks the page's SDK to run one action. Validates the parameters first. */
export async function invokeAppAction(
  win: MessageTarget,
  action: string,
  params: Record<string, unknown>,
  timeoutMs = INVOKE_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  if (!(APP_ACTIONS as readonly string[]).includes(action)) return { ok: false, detail: `'${action}' is not an app action` };
  if (action === "reset_user_preference") {
    const preference = params?.preference;
    if (typeof preference !== "string" || !RESETTABLE_PREFERENCES.includes(preference)) {
      return { ok: false, detail: "reset_user_preference needs a known preference name" };
    }
    params = { preference };
  }
  const reply = await ask(win, { type: "invoke", action, params }, timeoutMs);
  if (!reply || reply.type !== "result") return { ok: false, detail: "the page did not answer (is the Operon SDK installed?)" };
  return { ok: reply.ok === true, detail: String(reply.detail ?? "").slice(0, 200) };
}
