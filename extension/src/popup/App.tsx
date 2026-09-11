import { useEffect, useRef, useState } from "react";
import type { PopupCommand, SessionState } from "../lib/types";
import { AlertIcon, BeakerIcon, CheckIcon, EscalateIcon } from "./icons";

const PHASE_LABEL: Record<SessionState["phase"], string> = {
  idle: "Idle",
  seeded: "Seeded",
  collecting: "Collecting evidence",
  diagnosing: "Diagnosing",
  awaiting_approval: "Awaiting approval",
  executing: "Applying fix",
  verifying: "Verifying",
  resolved: "Resolved",
  escalated: "Escalated",
  error: "Error",
};

const BUSY_PHASES = new Set(["collecting", "diagnosing", "executing", "verifying"]);

function Button({
  children,
  onClick,
  variant = "secondary",
  disabled = false,
  full = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  full?: boolean;
}) {
  const base =
    "text-[12.5px] font-medium rounded-md px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const variants =
    variant === "primary"
      ? "bg-neutral-950 text-white hover:bg-neutral-800"
      : "bg-white text-neutral-900 border border-neutral-300 hover:border-neutral-950";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants} ${full ? "flex-1" : ""}`}>
      {children}
    </button>
  );
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-neutral-900 animate-pulse"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded border border-neutral-300 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">
      {children}
    </span>
  );
}

function StatusDot({ phase }: { phase: SessionState["phase"] }) {
  const active = BUSY_PHASES.has(phase);
  const settled = phase === "resolved" || phase === "escalated" || phase === "error";
  return (
    <span
      className={`h-1.5 w-1.5 rounded-full ${
        active ? "bg-neutral-950 animate-pulse" : settled ? "bg-neutral-950" : "bg-neutral-300"
      }`}
    />
  );
}

export function App() {
  const [state, setState] = useState<SessionState>({ phase: "idle" });
  const [message, setMessage] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: "popup" });
    portRef.current = port;
    port.onMessage.addListener((next: SessionState) => setState(next));
    port.postMessage({ type: "GET_STATE" } satisfies PopupCommand);
    return () => port.disconnect();
  }, []);

  function send(command: PopupCommand) {
    portRef.current?.postMessage(command);
  }

  const busy = BUSY_PHASES.has(state.phase);

  return (
    <div className="w-[380px] bg-white text-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm bg-neutral-950" />
          <span className="text-[13px] font-semibold tracking-tight">Operon</span>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusDot phase={state.phase} />
          <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-400">
            {PHASE_LABEL[state.phase]}
          </span>
        </div>
      </header>

      <main className="min-h-[220px] px-4 py-4">
        {(state.phase === "idle" || state.phase === "seeded") && (
          <div className="flex flex-col gap-3">
            {state.phase === "seeded" && (
              <p className="text-[12px] text-neutral-500">Demo bug seeded on this tab.</p>
            )}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Describe what's wrong…"
              className="resize-none rounded-md border border-neutral-200 bg-neutral-50 p-2.5 text-[13px] text-neutral-900 placeholder-neutral-400 outline-none focus:border-neutral-950"
            />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => send({ type: "SEED_BUG" })}>
                <span className="flex items-center gap-1.5">
                  <BeakerIcon className="h-3.5 w-3.5" />
                  Seed demo bug
                </span>
              </Button>
              <Button
                variant="primary"
                full
                disabled={!message.trim()}
                onClick={() => send({ type: "ASK_OPERON", message: message.trim() })}
              >
                Ask Operon
              </Button>
            </div>
          </div>
        )}

        {busy && (
          <div className="flex h-[188px] flex-col items-center justify-center gap-3 text-center">
            <Dots />
            <p className="text-[12.5px] text-neutral-500">{PHASE_LABEL[state.phase]}…</p>
            {state.phase === "collecting" && (
              <p className="max-w-[260px] text-[11.5px] text-neutral-400">
                Watching this tab for a few seconds — if you can, reproduce the issue now.
              </p>
            )}
          </div>
        )}

        {state.phase === "awaiting_approval" && state.diagnosis && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-[13px] font-semibold text-neutral-900">{state.diagnosis.root_cause}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-600">{state.diagnosis.reasoning}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-400">Evidence</span>
                {state.diagnosis.evidence_ids.map((id) => (
                  <Pill key={id}>{id}</Pill>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-neutral-400">
                Confidence {Math.round(state.diagnosis.confidence * 100)}%
              </p>
            </div>

            {state.diagnosis.proposed_action && (
              <div className="rounded-md border border-neutral-200 px-3 py-2">
                <span className="font-mono text-[12px] text-neutral-900">
                  {state.diagnosis.proposed_action.action_id}
                </span>
                {Object.entries(state.diagnosis.proposed_action.params).length > 0 && (
                  <span className="ml-1.5 font-mono text-[11px] text-neutral-400">
                    {JSON.stringify(state.diagnosis.proposed_action.params)}
                  </span>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="secondary" full onClick={() => send({ type: "DENY" })}>
                Deny
              </Button>
              <Button variant="primary" full onClick={() => send({ type: "APPROVE" })}>
                Approve
              </Button>
            </div>
          </div>
        )}

        {(state.phase === "resolved" || state.phase === "escalated" || state.phase === "error") && (
          <div className="flex h-[188px] flex-col items-center justify-center gap-3 text-center">
            {state.phase === "resolved" && <CheckIcon className="h-7 w-7 text-neutral-950" />}
            {state.phase === "escalated" && <EscalateIcon className="h-7 w-7 text-neutral-950" />}
            {state.phase === "error" && <AlertIcon className="h-7 w-7 text-neutral-950" />}
            <p className="max-w-[280px] text-[12.5px] text-neutral-600">
              {state.message ?? state.diagnosis?.reasoning ?? "Done."}
            </p>
            <Button variant="secondary" onClick={() => send({ type: "RESET" })}>
              Reset
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
