import { useEffect, useRef, useState } from "react";
import type { ExtensionState, PopupCommand, ViewPhase } from "../lib/types";
import { AlertIcon, BeakerIcon, CheckIcon, EscalateIcon } from "./icons";

declare const __OPERON_BACKEND_URL__: string;

// Shown in the header. These exact words are also what the end-to-end suites wait for.
const PHASE_LABEL: Record<ViewPhase, string> = {
  idle: "Idle",
  seeded: "Seeded",
  collecting: "Collecting evidence",
  investigating: "Investigating",
  checking_policy: "Checking policy",
  needs_more_evidence: "Needs more evidence",
  awaiting_approval: "Awaiting approval",
  executing: "Applying fix",
  verifying: "Verifying",
  resolved: "Resolved",
  escalated: "Escalated",
  error: "Error",
};
const BUSY_TEXT: Partial<Record<ViewPhase, string>> = {
  collecting: "Collecting diagnostic information from this tab",
  investigating: "Investigating the problem",
  checking_policy: "Checking the fix against Operon's safety policy",
  executing: "Applying the approved fix",
  verifying: "Checking whether the fix worked",
};
const BUSY_PHASES = new Set<ViewPhase>(["collecting", "investigating", "checking_policy", "executing", "verifying"]);

function describeAction(actionId: string, params: Record<string, unknown>): { title: string; body: string; changes: boolean } {
  switch (actionId) {
    case "clear_storage_key":
      return { title: "Remove one corrupted saved value", body: `Deletes the value "${String(params.key)}" this site stored in your browser. Nothing else is touched.`, changes: true };
    case "reset_user_preference":
      return { title: `Reset the ${String(params.preference)} preference`, body: `Asks the site to set its ${String(params.preference)} preference back to the default.`, changes: true };
    case "unregister_service_worker":
      return { title: "Remove an outdated service worker", body: `Unregisters the service worker for "${String(params.scope)}", so the site loads its current version.`, changes: true };
    case "reload":
      return { title: "Reload the page", body: "Reloads the investigated tab once.", changes: false };
    case "inspect_page":
      return { title: "Inspect the page", body: "Reads the page without changing anything.", changes: false };
    default:
      return { title: actionId, body: "", changes: true };
  }
}
const VERIFY: Record<string, string> = {
  storage_recheck: "re-reads that value and confirms it is gone or valid",
  reobserve_cited: "watches the page again for the same errors",
  sw_recheck: "checks the service worker is no longer registered",
};

function Button({ children, onClick, variant = "secondary", disabled = false, full = false }: {
  children: React.ReactNode; onClick: () => void; variant?: "primary" | "secondary" | "quiet"; disabled?: boolean; full?: boolean;
}) {
  const base = "text-[12.5px] font-semibold rounded-lg px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]";
  const variants =
    variant === "primary" ? "bg-[#1d4ed8] text-white hover:bg-[#1e40af]"
    : variant === "quiet" ? "text-[#475569] hover:text-[#0f172a]"
    : "bg-white text-[#0f172a] border border-[#cfd7e3] hover:bg-[#f0f3f9]";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants} ${full ? "flex-1" : ""}`}>
      {children}
    </button>
  );
}

function Spinner() {
  return <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[#1d4ed8] border-r-transparent motion-reduce:animate-none" aria-hidden />;
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-block rounded-md bg-[#f0f3f9] px-1.5 py-0.5 font-mono text-[10px] text-[#475569]">{children}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#e3e8f0] bg-[#fbfcfe] p-3">
      <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-[#64748b]">{title}</p>
      {children}
    </div>
  );
}

function hostOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

export function App() {
  const [state, setState] = useState<ExtensionState>({ phase: "idle" });
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [answer, setAnswer] = useState("");
  const [backend, setBackend] = useState<"checking" | "online" | "offline">("checking");
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: "popup" });
    portRef.current = port;
    port.onMessage.addListener((next: ExtensionState) => setState(next));
    port.postMessage({ type: "GET_STATE" } satisfies PopupCommand);
    return () => port.disconnect();
  }, []);

  // Connection status: an honest ping of the backend this build talks to (no credentials sent).
  useEffect(() => {
    let alive = true;
    const ping = () =>
      fetch(`${__OPERON_BACKEND_URL__}/health`, { cache: "no-store", credentials: "omit" })
        .then((r) => alive && setBackend(r.ok ? "online" : "offline"))
        .catch(() => alive && setBackend("offline"));
    ping();
    const timer = setInterval(ping, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // The site in the active tab (visible only for sites this build may access).
  useEffect(() => {
    chrome.tabs?.query?.({ active: true, currentWindow: true }, (tabs) => setActiveHost(hostOf(tabs?.[0]?.url)));
  }, [state.phase]);

  function send(command: PopupCommand) {
    portRef.current?.postMessage(command);
  }

  const busy = BUSY_PHASES.has(state.phase);
  const session = state.session;
  const pending = session?.pending_action ?? null;
  const currentHypothesis = session?.hypotheses.find((h) => h.hypothesis_id === session.current_hypothesis_id);
  const evidenceRequest = session?.evidence_request ?? null;
  const answered = evidenceRequest?.question
    ? Boolean(session?.diagnostic_steps?.find((st) => st.request_id === evidenceRequest.request_id)?.answer)
    : false;
  const recentActivity = (session?.activity ?? []).slice(-8);
  const targetHost = hostOf(state.targetOrigin) ?? activeHost;
  const phaseTone =
    state.phase === "resolved" ? "bg-[#e7f6ef] text-[#047857]"
    : state.phase === "escalated" || state.phase === "awaiting_approval" ? "bg-[#fdf3e2] text-[#b45309]"
    : state.phase === "error" ? "bg-[#fdecec] text-[#b91c1c]"
    : busy ? "bg-[#e8efff] text-[#1d4ed8]"
    : "bg-[#f0f3f9] text-[#475569]";

  return (
    <div className="w-[380px] bg-white text-[#0f172a]">
      <header className="flex items-center justify-between bg-[#0b1f4b] px-4 py-3 text-white">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-[#60a5fa] to-[#2563eb] text-[13px] font-extrabold">O</span>
          <div className="leading-tight">
            <p className="text-[13.5px] font-semibold">Operon</p>
            <p className="text-[10.5px] text-[#a5b4d8]">AI technical support</p>
          </div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${phaseTone}`} aria-live="polite">
          {PHASE_LABEL[state.phase]}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#e3e8f0] bg-[#f5f7fb] px-4 py-2 text-[11px] text-[#475569]">
        <span className="flex items-center gap-1.5" title={__OPERON_BACKEND_URL__}>
          <span className={`h-2 w-2 rounded-full ${backend === "online" ? "bg-[#047857]" : backend === "offline" ? "bg-[#b91c1c]" : "bg-[#94a3b8]"}`} />
          {backend === "online" ? "Backend connected" : backend === "offline" ? "Backend unreachable" : "Checking backend…"}
        </span>
        <span>{state.tokenSet ? "Access token saved" : "No access token"}</span>
        {targetHost && (
          <span className="truncate" title={state.targetOrigin ?? undefined}>
            {state.targetOrigin ? "Investigating" : "Site"}: <span className="font-medium text-[#0f172a]">{targetHost}</span>
          </span>
        )}
      </div>

      <main className="min-h-[220px] px-4 py-4">
        {(state.phase === "idle" || state.phase === "seeded") && (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] leading-relaxed text-[#475569]">
              Describe what's wrong on this page. Operon collects diagnostic evidence from this tab, explains the cause and proposes a fix — nothing changes without your approval.
            </p>
            {state.phase === "seeded" && <p className="rounded-md bg-[#fdf3e2] px-2.5 py-1.5 text-[12px] text-[#b45309]">Demo bug seeded on this tab.</p>}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              aria-label="Describe the problem"
              placeholder="e.g. The dashboard shows an error instead of my projects"
              className="resize-none rounded-lg border border-[#cfd7e3] bg-white p-2.5 text-[13px] text-[#0f172a] placeholder-[#94a3b8] outline-none focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#e8efff]"
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => send({ type: "SEED_BUG" })}>
                <span className="flex items-center gap-1.5">
                  <BeakerIcon className="h-3.5 w-3.5" />
                  Seed demo bug
                </span>
              </Button>
              <Button variant="primary" full disabled={!message.trim()} onClick={() => send({ type: "ASK_OPERON", message: message.trim() })}>
                Ask Operon
              </Button>
            </div>
            <details className="text-[11.5px] text-[#64748b]">
              <summary className="cursor-pointer select-none">Backend access {state.tokenSet ? "· token saved" : "· no token"}</summary>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={state.tokenSet ? "Replace the saved token" : "Paste your access token"}
                  aria-label="Backend access token"
                  className="min-w-0 flex-1 rounded-md border border-[#cfd7e3] bg-white px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[#1d4ed8]"
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    send({ type: "SET_TOKEN", token: token.trim() });
                    setToken("");
                  }}
                >
                  {token.trim() || !state.tokenSet ? "Save" : "Remove"}
                </Button>
              </div>
            </details>
          </div>
        )}

        {busy && (
          <div className="flex min-h-[188px] flex-col items-center justify-center gap-3 text-center">
            <Spinner />
            <p className="text-[13px] font-semibold text-[#0f172a]">{BUSY_TEXT[state.phase] ?? PHASE_LABEL[state.phase]}…</p>
            {state.phase === "collecting" && (
              <p className="max-w-[280px] text-[11.5px] text-[#64748b]">Watching this tab for a few seconds — if you can, reproduce the issue now.</p>
            )}
            {state.progress && state.progress.length > 0 && (
              <ol aria-label="Live progress" className="w-full max-w-[330px] space-y-0.5 rounded-lg bg-[#f5f7fb] p-2 text-left">
                {state.progress.map((line) => (
                  <li key={line.id} className="truncate font-mono text-[10.5px] leading-snug text-[#475569]">
                    {line.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {state.phase === "needs_more_evidence" && (
          <div className="flex flex-col gap-3">
            <Section title={evidenceRequest?.purpose === "retry" ? "That didn't fix it — looking again" : "Operon needs more information"}>
              <p className="text-[12.5px] leading-relaxed text-[#334155]">{state.message}</p>
              {evidenceRequest && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] font-semibold text-[#64748b]">Will collect</span>
                  {evidenceRequest.collectors.map((c) => <Chip key={c}>{c}</Chip>)}
                </div>
              )}
              {currentHypothesis && <p className="mt-2 text-[11.5px] text-[#64748b]">Working hypothesis ({currentHypothesis.status}): {currentHypothesis.description}</p>}
            </Section>
            {evidenceRequest?.question && (
              <Section title="Question">
                <p className="text-[12.5px] font-medium text-[#0f172a]">{evidenceRequest.question}</p>
                {answered ? (
                  <p className="mt-1.5 text-[11.5px] text-[#64748b]">Thanks — your answer will be used in the next step.</p>
                ) : (
                  <>
                    <textarea
                      aria-label="Your answer"
                      className="mt-2 h-14 w-full resize-none rounded-md border border-[#cfd7e3] p-2 text-[12px]"
                      maxLength={1000}
                      placeholder="Optional — never include passwords or tokens"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                    <Button
                      variant="secondary"
                      onClick={() => {
                        send({ type: "ANSWER", text: answer });
                        setAnswer("");
                      }}
                    >
                      Send answer
                    </Button>
                  </>
                )}
              </Section>
            )}
            {evidenceRequest?.requires_user_action && (
              <p className="text-[11.5px] text-[#64748b]">Reproduce the problem in the investigated tab, then continue — Operon will watch for a few seconds.</p>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => send({ type: "RESET" })}>Reset</Button>
              <Button variant="primary" full onClick={() => send({ type: "INVESTIGATE_AGAIN" })}>Collect evidence</Button>
            </div>
          </div>
        )}

        {state.phase === "awaiting_approval" && pending && (() => {
          const action = describeAction(pending.action_id, pending.parameters);
          return (
            <div className="flex flex-col gap-3">
              <Section title="What's wrong">
                <p className="text-[13px] font-semibold text-[#0f172a]">{state.diagnosis?.root_cause ?? pending.diagnosis}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#475569]">{state.diagnosis?.reasoning ?? pending.expected_effect}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] font-semibold text-[#64748b]">Evidence</span>
                  {pending.evidence_ids.map((id) => <Chip key={id}>{id}</Chip>)}
                </div>
                {state.diagnosis && state.diagnosis.knowledge_refs.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] font-semibold text-[#64748b]">Knowledge</span>
                    {state.diagnosis.knowledge_refs.map((id) => <Chip key={id}>{id}</Chip>)}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-[#64748b]">Confidence {Math.round((session?.confidence ?? 0) * 100)}%</p>
              </Section>
              <Section title="Proposed fix">
                <p className="text-[12.5px] font-semibold text-[#0f172a]">{action.title}</p>
                <p className="mt-0.5 text-[12px] text-[#475569]">{action.body}</p>
                <p className="mt-1.5 font-mono text-[11px] text-[#64748b]">
                  {pending.action_id} {Object.keys(pending.parameters).length > 0 && JSON.stringify(pending.parameters)}
                </p>
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11.5px] text-[#475569]">
                  <li>{action.changes ? "Changes data this site stored in your browser." : "Does not change any data."}</li>
                  <li>Runs only on {state.targetOrigin ? hostOf(state.targetOrigin) : "the investigated tab"}, only if you approve.</li>
                  {pending.verification && <li>Afterwards Operon {VERIFY[pending.verification.strategy] ?? pending.verification.strategy.replace(/_/g, " ")}.</li>}
                  {pending.attempt > 1 && <li>Attempt {pending.attempt} — previous attempt: {pending.retry_reason}</li>}
                </ul>
                {state.policy && <p className="mt-1.5 text-[11px] text-[#64748b]">Policy: {state.policy.reason}</p>}
              </Section>
              <div className="flex gap-2">
                <Button variant="secondary" full onClick={() => send({ type: "DENY" })}>Deny</Button>
                <Button variant="primary" full onClick={() => send({ type: "APPROVE" })}>Approve</Button>
              </div>
            </div>
          );
        })()}

        {(state.phase === "resolved" || state.phase === "escalated" || state.phase === "error") && (
          <div className="flex min-h-[150px] flex-col items-center justify-center gap-3 text-center">
            {state.phase === "resolved" && session?.resolution_state !== "declined_by_user" && <CheckIcon className="h-8 w-8 text-[#047857]" />}
            {state.phase === "escalated" && <EscalateIcon className="h-8 w-8 text-[#b45309]" />}
            {state.phase === "error" && <AlertIcon className="h-8 w-8 text-[#b91c1c]" />}
            <p className="text-[13px] font-semibold">
              {state.phase === "resolved"
                ? session?.resolution_state === "declined_by_user" ? "Fix declined — nothing was changed" : "Fixed and verified"
                : state.phase === "escalated" ? "Handed to the support team" : "Something went wrong"}
            </p>
            <p className="max-w-[310px] whitespace-pre-line text-[12px] leading-relaxed text-[#475569]">{state.message || state.diagnosis?.reasoning || "Done."}</p>
            <Button variant="secondary" onClick={() => send({ type: "RESET" })}>Reset</Button>
          </div>
        )}

        {(state.phase === "resolved" || state.phase === "escalated") && recentActivity.length > 0 && (
          <details className="mt-3 border-t border-[#e3e8f0] pt-2">
            <summary className="cursor-pointer select-none text-[11px] font-semibold text-[#64748b]">What Operon did</summary>
            <ol className="mt-2 space-y-1">
              {recentActivity.map((a) => (
                <li key={a.seq} className="flex gap-2 text-[10.5px] leading-snug text-[#475569]">
                  <span className="w-[92px] shrink-0 font-mono uppercase tracking-wide text-[#94a3b8]">{a.kind.replace(/_/g, " ")}</span>
                  <span className="line-clamp-2">{a.summary}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </main>

      {session && (
        <footer className="border-t border-[#e3e8f0] bg-[#f5f7fb] px-4 py-2 font-mono text-[10px] text-[#64748b]">
          session {session.session_id.slice(0, 8)} · {session.phase}
        </footer>
      )}
    </div>
  );
}
