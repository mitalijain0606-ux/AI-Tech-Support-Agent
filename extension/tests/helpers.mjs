import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Bundles a TypeScript entry point from src/ the same way the real build
// does, so tests exercise the actual source rather than a copy.
export async function bundle(entry, { format = "esm", define = {} } = {}) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    format,
    target: "es2022",
    define: { __OPERON_BACKEND_URL__: JSON.stringify("http://backend.test"), ...define },
  });
  return result.outputFiles[0].text;
}

export async function importBundle(entry) {
  const dir = mkdtempSync(path.join(tmpdir(), "operon-test-"));
  const file = path.join(dir, "module.mjs");
  writeFileSync(file, await bundle(entry));
  return import(file);
}

// A minimal stand-in for the chrome.* APIs background.ts uses at load time
// and in the code paths under test.
export function createFakeChrome({ initialStorage = {}, tabs = [], contentScriptReachable = false } = {}) {
  const storage = { ...initialStorage };
  const listeners = { connect: [], debuggerEvent: [], tabUpdated: new Set() };
  const chrome = {
    runtime: {
      lastError: undefined,
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
    },
    storage: {
      session: {
        get: async (key) => (key in storage ? { [key]: structuredClone(storage[key]) } : {}),
        set: async (items) => Object.assign(storage, structuredClone(items)),
      },
    },
    debugger: {
      onEvent: { addListener: (fn) => listeners.debuggerEvent.push(fn) },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
    },
    tabs: {
      query: async () => tabs,
      reload: () => {},
      onUpdated: {
        addListener: (fn) => listeners.tabUpdated.add(fn),
        removeListener: (fn) => listeners.tabUpdated.delete(fn),
      },
      sendMessage: (_tabId, _message, callback) => {
        if (contentScriptReachable) {
          chrome.runtime.lastError = undefined;
          callback({});
        } else {
          chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
          callback(undefined);
          chrome.runtime.lastError = undefined;
        }
      },
    },
    cookies: { getAll: async () => [] },
  };
  return { chrome, storage, listeners };
}

// Connects a fake popup port and returns helpers to send commands and read
// every state the background broadcast.
export function connectPopup(listeners) {
  const received = [];
  let onMessage;
  const port = {
    postMessage: (message) => received.push(structuredClone(message)),
    onDisconnect: { addListener: () => {} },
    onMessage: { addListener: (fn) => (onMessage = fn) },
  };
  for (const fn of listeners.connect) fn(port);
  return { received, send: (command) => onMessage(command) };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
