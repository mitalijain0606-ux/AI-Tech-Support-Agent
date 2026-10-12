// API helpers. `bug` is sent as ?bug=N so the (stateless) mock server can
// produce the matching failure; requests are otherwise ordinary fetches.

export function createApi({ apiBase = "", reportsBase, bug = null, fetchImpl = null }) {
  const q = bug ? `?bug=${bug.id}` : "";
  async function getJson(url) {
    // Looked up at call time, so a fetch wrapper installed later (the Operon SDK's network capture) sees these requests.
    const res = await (fetchImpl ?? globalThis.fetch)(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || "error"} for ${new URL(url, globalThis.location?.href ?? "http://localhost").pathname}`);
    return res.json();
  }
  return {
    projects: () => getJson(`${apiBase}/api/projects${q}`),
    me: () => getJson(`${apiBase}/api/me${q}`),
    reports: () => getJson(`${reportsBase}/api/reports${q}`),
  };
}
