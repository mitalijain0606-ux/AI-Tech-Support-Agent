import { useEffect, useRef, useState } from "react";
import type { ExtensionState, PopupCommand, ViewPhase } from "../lib/types";
import { AlertIcon, ArrowIcon, BeakerIcon, ChatIcon, CheckIcon, EscalateIcon, KeyIcon, LogoMark, SearchIcon, ShieldIcon, SparkIcon, WrenchIcon } from "./icons";

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
  const base = "inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold rounded-xl px-3.5 py-2.5 transition-all duration-150 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  const variants =
    variant === "primary" ? "op-gradient-btn text-white"
    : variant === "quiet" ? "text-slate-500 hover:text-slate-900"
    : "bg-white text-slate-800 ring-1 ring-slate-900/10 shadow-sm hover:bg-slate-50 hover:ring-slate-900/20";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants} ${full ? "flex-1" : ""}`}>
      {children}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-block rounded-md bg-brand-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#4f46e5] ring-1 ring-inset ring-[#6d5efc]/15">{children}</span>;
}

function Section({ title, icon, tone = "default", children }: { title: string; icon?: React.ReactNode; tone?: "default" | "brand"; children: React.ReactNode }) {
  return (
    <div className={`op-card op-in rounded-2xl bg-white p-3.5 ring-1 ${tone === "brand" ? "ring-[#6d5efc]/25" : "ring-slate-900/[.06]"}`}>
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon && <span className="grid h-5 w-5 place-items-center rounded-md bg-brand-soft text-brand">{icon}</span>}
        <p className="text-[10.5px] font-bold uppercase tracking-[.08em] text-slate-500">{title}</p>
      </div>
      {children}
    </div>
  );
}

function Fact({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-[11.5px] leading-snug text-slate-600">
      <CheckIcon className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" />
      <span>{children}</span>
    </li>
  );
}

// The stages of one investigation, for the busy-state stepper.
const STEPS: { phase: ViewPhase; label: string }[] = [
  { phase: "collecting", label: "Collect" },
  { phase: "investigating", label: "Diagnose" },
  { phase: "checking_policy", label: "Policy" },
  { phase: "executing", label: "Fix" },
  { phase: "verifying", label: "Verify" },
];

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
    state.phase === "resolved" ? "bg-emerald-400/15 text-emerald-200 ring-emerald-300/30"
    : state.phase === "escalated" || state.phase === "awaiting_approval" ? "bg-amber-400/15 text-amber-200 ring-amber-300/30"
    : state.phase === "error" ? "bg-rose-500/15 text-rose-200 ring-rose-300/30"
    : busy ? "bg-[#8b5cf6]/25 text-violet-100 ring-violet-300/30"
    : "bg-white/10 text-slate-200 ring-white/15";
  const phaseDot =
    state.phase === "resolved" ? "bg-emerald-300"
    : state.phase === "escalated" || state.phase === "awaiting_approval" ? "bg-amber-300"
    : state.phase === "error" ? "bg-rose-300"
    : busy ? "bg-violet-200"
    : "bg-slate-300";
  const stepIndex = STEPS.findIndex((s) => s.phase === state.phase);
  const confidence = Math.round((session?.confidence ?? 0) * 100);

  return (
    <div className="w-[380px] bg-canvas font-sans text-slate-900">
      <div className="op-hero relative overflow-hidden px-4 pb-3 pt-3.5 text-white">
        <header className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,.15)] ring-1 ring-white/15 backdrop-blur">
              <LogoMark className="h-6 w-6" />
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-semibold tracking-[-.01em]">Operon</p>
              <p className="text-[10.5px] font-medium text-violet-200/80">AI technical support</p>
            </div>
          </div>
          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-semibold ring-1 backdrop-blur ${phaseTone}`} aria-live="polite">
            <span className={`h-1.5 w-1.5 rounded-full ${phaseDot} ${busy ? "op-pulse" : ""}`} aria-hidden />
            {PHASE_LABEL[state.phase]}
          </span>
        </header>

        <div className="relative z-10 mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px] font-medium text-slate-200">
          <span className="flex items-center gap-1.5 rounded-full bg-white/[.07] px-2 py-0.5 ring-1 ring-white/10" title={__OPERON_BACKEND_URL__}>
            <span className={`h-1.5 w-1.5 rounded-full ${backend === "online" ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : backend === "offline" ? "bg-rose-400" : "bg-slate-400"}`} />
            {backend === "online" ? "Backend connected" : backend === "offline" ? "Backend unreachable" : "Checking backend…"}
          </span>
          <span className="flex items-center gap-1 rounded-full bg-white/[.07] px-2 py-0.5 ring-1 ring-white/10">
            <KeyIcon className="h-3 w-3 opacity-80" />
            {state.tokenSet ? "Access token saved" : "No access token"}
          </span>
          {targetHost && (
            <span className="flex min-w-0 max-w-full items-center gap-1 truncate rounded-full bg-white/[.07] px-2 py-0.5 ring-1 ring-white/10" title={state.targetOrigin ?? undefined}>
              {state.targetOrigin ? "Investigating" : "Site"}: <span className="truncate font-semibold text-white">{targetHost}</span>
            </span>
          )}
        </div>
      </div>

      <main className="min-h-[220px] px-4 py-4">
        {(state.phase === "idle" || state.phase === "seeded") && (
          <div className="op-in flex flex-col gap-3">
            <div>
              <h1 className="text-[17px] font-semibold tracking-[-.015em] text-slate-900">What's going wrong?</h1>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                Describe what's wrong on this page. Operon collects diagnostic evidence from this tab, explains the cause and proposes a fix — nothing changes without your approval.
              </p>
            </div>
            {state.phase === "seeded" && (
              <p className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800 ring-1 ring-amber-200/70">
                <BeakerIcon className="h-4 w-4 shrink-0" />
                Demo bug seeded on this tab.
              </p>
            )}
            <div className="op-card rounded-2xl bg-white p-1 ring-1 ring-slate-900/[.08] transition focus-within:ring-2 focus-within:ring-brand/60">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                aria-label="Describe the problem"
                placeholder="e.g. The dashboard shows an error instead of my projects"
                className="block w-full resize-none rounded-xl bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-slate-900 placeholder-slate-400 outline-none"
              />
              <div className="flex items-center justify-between gap-2 px-1 pb-1">
                <Button variant="quiet" onClick={() => send({ type: "SEED_BUG" })}>
                  <BeakerIcon className="h-3.5 w-3.5" />
                  Seed demo bug
                </Button>
                <Button variant="primary" disabled={!message.trim()} onClick={() => send({ type: "ASK_OPERON", message: message.trim() })}>
                  <SparkIcon className="h-3.5 w-3.5" />
                  Ask Operon
                </Button>
              </div>
            </div>
            <ul className="grid grid-cols-3 gap-2" aria-label="How Operon works">
              {[
                { icon: <SearchIcon className="h-3.5 w-3.5" />, title: "Evidence", text: "Reads this tab, redacted" },
                { icon: <ShieldIcon className="h-3.5 w-3.5" />, title: "Your call", text: "Fixes need approval" },
                { icon: <CheckIcon className="h-3.5 w-3.5" />, title: "Verified", text: "Checked on the server" },
              ].map((f) => (
                <li key={f.title} className="rounded-xl bg-white/70 p-2 ring-1 ring-slate-900/[.05]">
                  <span className="grid h-6 w-6 place-items-center rounded-lg bg-brand-soft text-brand">{f.icon}</span>
                  <p className="mt-1.5 text-[11px] font-semibold text-slate-800">{f.title}</p>
                  <p className="text-[10px] leading-snug text-slate-500">{f.text}</p>
                </li>
              ))}
            </ul>
            <details className="group rounded-xl bg-white/70 px-3 py-2 text-[11.5px] text-slate-500 ring-1 ring-slate-900/[.05]">
              <summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
                <ArrowIcon className="op-chevron h-3 w-3 transition-transform" />
                Backend access {state.tokenSet ? "· token saved" : "· no token"}
              </summary>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={state.tokenSet ? "Replace the saved token" : "Paste your access token"}
                  aria-label="Backend access token"
                  className="min-w-0 flex-1 rounded-lg bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-800 outline-none ring-1 ring-slate-900/10 focus:ring-2 focus:ring-brand/60"
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
          <div className="op-in flex min-h-[188px] flex-col items-center justify-center gap-3 text-center">
            <div className="relative grid h-16 w-16 place-items-center">
              <span className="op-halo absolute -inset-4 rounded-full" aria-hidden />
              <span className="op-ring-grad absolute inset-0 animate-spin rounded-full [animation-duration:1.4s]" aria-hidden />
              <span className="grid h-11 w-11 place-items-center rounded-full bg-white shadow-md ring-1 ring-slate-900/5">
                <LogoMark className="op-float h-7 w-7 [&_circle:nth-of-type(2)]:fill-[#6d5efc] [&_ellipse]:stroke-[#6d5efc]" />
              </span>
            </div>
            <p className="text-[13.5px] font-semibold text-slate-900">{BUSY_TEXT[state.phase] ?? PHASE_LABEL[state.phase]}…</p>
            {state.phase === "collecting" && (
              <p className="-mt-1.5 max-w-[280px] text-[11.5px] text-slate-500">Watching this tab for a few seconds — if you can, reproduce the issue now.</p>
            )}
            {stepIndex >= 0 && (
              <ol className="flex w-full max-w-[330px] items-center" aria-hidden>
                {STEPS.map((s, i) => (
                  <li key={s.phase} className="flex flex-1 flex-col items-center gap-1">
                    <span className="flex w-full items-center">
                      <span className={`h-px flex-1 ${i === 0 ? "opacity-0" : i <= stepIndex ? "bg-brand" : "bg-slate-200"}`} />
                      <span className={`grid h-4 w-4 place-items-center rounded-full text-[8px] font-bold ${i < stepIndex ? "bg-brand text-white" : i === stepIndex ? "bg-white text-brand ring-2 ring-brand" : "bg-white text-slate-400 ring-1 ring-slate-300"}`}>
                        {i < stepIndex ? "✓" : i + 1}
                      </span>
                      <span className={`h-px flex-1 ${i === STEPS.length - 1 ? "opacity-0" : i < stepIndex ? "bg-brand" : "bg-slate-200"}`} />
                    </span>
                    <span className={`text-[9.5px] font-semibold ${i === stepIndex ? "text-brand" : "text-slate-400"}`}>{s.label}</span>
                  </li>
                ))}
              </ol>
            )}
            {state.progress && state.progress.length > 0 && (
              <ol aria-label="Live progress" className="w-full max-w-[340px] space-y-1 rounded-xl bg-ink p-2.5 text-left shadow-inner ring-1 ring-white/5">
                {state.progress.map((line, n) => (
                  <li key={line.id} className="flex items-center gap-1.5 truncate font-mono text-[10.5px] leading-snug text-slate-300">
                    <span className={n === state.progress!.length - 1 ? "op-pulse text-cyan" : "text-emerald-400"} aria-hidden>{n === state.progress!.length - 1 ? "›" : "✓"}</span>
                    <span className="truncate">{line.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {state.phase === "needs_more_evidence" && (
          <div className="flex flex-col gap-3">
            <Section icon={<SearchIcon className="h-3 w-3" />} title={evidenceRequest?.purpose === "retry" ? "That didn't fix it — looking again" : "Operon needs more information"}>
              <p className="text-[12.5px] leading-relaxed text-slate-700">{state.message}</p>
              {evidenceRequest && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] font-semibold text-slate-500">Will collect</span>
                  {evidenceRequest.collectors.map((c) => <Chip key={c}>{c}</Chip>)}
                </div>
              )}
              {currentHypothesis && <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11.5px] text-slate-500">Working hypothesis ({currentHypothesis.status}): {currentHypothesis.description}</p>}
            </Section>
            {evidenceRequest?.question && (
              <Section icon={<ChatIcon className="h-3 w-3" />} title="Question" tone="brand">
                <p className="text-[12.5px] font-medium text-slate-900">{evidenceRequest.question}</p>
                {answered ? (
                  <p className="mt-1.5 text-[11.5px] text-slate-500">Thanks — your answer will be used in the next step.</p>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    <textarea
                      aria-label="Your answer"
                      className="h-14 w-full resize-none rounded-lg bg-white p-2 text-[12px] outline-none ring-1 ring-slate-900/10 focus:ring-2 focus:ring-brand/60"
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
                  </div>
                )}
              </Section>
            )}
            {evidenceRequest?.requires_user_action && (
              <p className="rounded-xl bg-violet-50 px-3 py-2 text-[11.5px] text-violet-900 ring-1 ring-violet-200/60">Reproduce the problem in the investigated tab, then continue — Operon will watch for a few seconds.</p>
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
              <Section icon={<SearchIcon className="h-3 w-3" />} title="What's wrong">
                <p className="text-[13.5px] font-semibold leading-snug tracking-[-.01em] text-slate-900">{state.diagnosis?.root_cause ?? pending.diagnosis}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{state.diagnosis?.reasoning ?? pending.expected_effect}</p>
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="text-[10.5px] font-semibold text-slate-500">Confidence {confidence}%</span>
                  <span className="op-meter h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                    <span className="block h-full rounded-full" style={{ width: `${confidence}%` }} />
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] font-semibold text-slate-500">Evidence</span>
                  {pending.evidence_ids.map((id) => <Chip key={id}>{id}</Chip>)}
                </div>
                {state.diagnosis && state.diagnosis.knowledge_refs.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] font-semibold text-slate-500">Knowledge</span>
                    {state.diagnosis.knowledge_refs.map((id) => <Chip key={id}>{id}</Chip>)}
                  </div>
                )}
              </Section>
              <Section icon={<WrenchIcon className="h-3 w-3" />} title="Proposed fix" tone="brand">
                <p className="text-[13px] font-semibold text-slate-900">{action.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-slate-600">{action.body}</p>
                <p className="mt-2 overflow-x-auto whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 font-mono text-[10.5px] text-violet-200">
                  {pending.action_id} {Object.keys(pending.parameters).length > 0 && JSON.stringify(pending.parameters)}
                </p>
                <ul className="mt-2.5 space-y-1">
                  <Fact>{action.changes ? "Changes data this site stored in your browser." : "Does not change any data."}</Fact>
                  <Fact>Runs only on {state.targetOrigin ? hostOf(state.targetOrigin) : "the investigated tab"}, only if you approve.</Fact>
                  {pending.verification && <Fact>Afterwards Operon {VERIFY[pending.verification.strategy] ?? pending.verification.strategy.replace(/_/g, " ")}.</Fact>}
                  {pending.attempt > 1 && <Fact>Attempt {pending.attempt} — previous attempt: {pending.retry_reason}</Fact>}
                </ul>
                {state.policy && (
                  <p className="mt-2.5 flex items-start gap-1.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                    <ShieldIcon className="mt-px h-3.5 w-3.5 shrink-0 text-brand" />
                    <span>Policy: {state.policy.reason}</span>
                  </p>
                )}
              </Section>
              <div className="sticky bottom-0 -mx-4 flex gap-2 bg-gradient-to-t from-canvas via-canvas to-canvas/0 px-4 pb-1 pt-3">
                <Button variant="secondary" full onClick={() => send({ type: "DENY" })}>Deny</Button>
                <Button variant="primary" full onClick={() => send({ type: "APPROVE" })}>Approve</Button>
              </div>
            </div>
          );
        })()}

        {(state.phase === "resolved" || state.phase === "escalated" || state.phase === "error") && (() => {
          const declined = state.phase === "resolved" && session?.resolution_state === "declined_by_user";
          const tone = state.phase === "error" ? "bad" : state.phase === "escalated" ? "warn" : declined ? "" : "ok";
          return (
            <div className="op-in flex min-h-[170px] flex-col items-center justify-center gap-2.5 text-center">
              <div className="relative grid h-16 w-16 place-items-center">
                <span className={`absolute -inset-5 rounded-full ${tone ? `op-halo-${tone}` : "op-halo"}`} aria-hidden />
                <span className={`relative grid h-14 w-14 place-items-center rounded-2xl shadow-lg ring-1 ${
                  tone === "ok" ? "bg-gradient-to-br from-emerald-400 to-teal-500 text-white ring-emerald-500/30 shadow-emerald-500/30"
                  : tone === "warn" ? "bg-gradient-to-br from-amber-300 to-orange-500 text-white ring-amber-500/30 shadow-amber-500/30"
                  : tone === "bad" ? "bg-gradient-to-br from-rose-400 to-red-600 text-white ring-rose-500/30 shadow-rose-500/30"
                  : "bg-white text-slate-500 ring-slate-900/10"}`}>
                  {state.phase === "resolved" && !declined && <CheckIcon className="h-8 w-8" />}
                  {declined && <ShieldIcon className="h-7 w-7" />}
                  {state.phase === "escalated" && <EscalateIcon className="h-8 w-8" />}
                  {state.phase === "error" && <AlertIcon className="h-8 w-8" />}
                </span>
              </div>
              <p className="mt-1 text-[15px] font-semibold tracking-[-.01em]">
                {state.phase === "resolved"
                  ? declined ? "Fix declined — nothing was changed" : "Fixed and verified"
                  : state.phase === "escalated"
                    ? session?.resolution_state === "expired_idle" ? "Expired — nothing was changed" : "Handed to the support team"
                    : "Something went wrong"}
              </p>
              <p className="max-w-[320px] whitespace-pre-line text-[12px] leading-relaxed text-slate-600">{state.message || state.diagnosis?.reasoning || "Done."}</p>
              <div className="mt-1">
                <Button variant="secondary" onClick={() => send({ type: "RESET" })}>Reset</Button>
              </div>
            </div>
          );
        })()}

        {(state.phase === "awaiting_approval" || state.phase === "resolved" || state.phase === "escalated") &&
          (session?.additional_issues?.length ?? 0) > 0 && (
          <div className="op-in mt-3 rounded-2xl bg-amber-50/70 p-3 ring-1 ring-amber-200/70" data-testid="other-issues">
            <p className="text-[11px] font-semibold text-amber-900">Other problems to report separately</p>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-amber-900/80">
              {session!.additional_issues!.slice(0, 5).map((i, n) => <li key={n}>{i.text}</li>)}
            </ul>
            <p className="mt-1 text-[10px] text-amber-800/70">Operon handles one problem at a time. Ask again for each of these.</p>
          </div>
        )}

        {(state.phase === "resolved" || state.phase === "escalated") && recentActivity.length > 0 && (
          <details className="mt-3 rounded-2xl bg-white p-3 ring-1 ring-slate-900/[.06]">
            <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              <ArrowIcon className="op-chevron h-3 w-3 transition-transform" />
              What Operon did
            </summary>
            <ol className="relative mt-2.5 space-y-2 border-l border-slate-200 pl-3">
              {recentActivity.map((a) => (
                <li key={a.seq} className="relative text-[10.5px] leading-snug text-slate-600">
                  <span className="absolute -left-[16.5px] top-[3px] h-2 w-2 rounded-full bg-white ring-2 ring-brand" aria-hidden />
                  <span className="block font-mono text-[9.5px] uppercase tracking-wide text-slate-400">{a.kind.replace(/_/g, " ")}</span>
                  <span className="line-clamp-2">{a.summary}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </main>

      {session && (
        <footer className="flex items-center justify-between border-t border-slate-900/[.06] bg-white/60 px-4 py-2 font-mono text-[10px] text-slate-400">
          <span>session {session.session_id.slice(0, 8)} · {session.phase}</span>
          <span className="flex items-center gap-1 font-sans font-medium"><ShieldIcon className="h-3 w-3" />Evidence redacted</span>
        </footer>
      )}
    </div>
  );
}
