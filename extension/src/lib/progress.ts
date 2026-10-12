// Turns the backend's live progress events (GET /api/sessions/{id}/events)
// into the short lines the popup shows while a step is running.

const STAGE_TEXT: Record<string, Record<string, string>> = {
  investigate: { started: "Gathering and searching the evidence", finished: "Evidence and knowledge search done" },
  classify: { started: "Classifying the problem", finished: "Problem classified" },
  diagnose: { started: "Asking the model for a diagnosis", finished: "Diagnosis ready" },
  plan: { started: "Planning the next step", finished: "Next step planned" },
  verify: { started: "Checking whether the fix worked", finished: "Verification done" },
};

// One backend event -> one short line, or null when it adds nothing.
export function describeProgress(event: Record<string, any>): string | null {
  if (event.type === "stage") {
    const base = STAGE_TEXT[event.stage]?.[event.status];
    if (!base) return null;
    const detail = event.retrieval ?? event.category ?? event.outcome ?? event.engine;
    return detail ? `${base} (${detail})` : base;
  }
  if (event.type === "activity" && event.entry?.summary) return String(event.entry.summary).slice(0, 140);
  return null;
}

