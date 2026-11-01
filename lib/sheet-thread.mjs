// The worker thread of lib/sheet-runtime.mjs. It runs public/js/roll20-worker.js
// and the sheet's own worker code, both unchanged, in a vm context that looks
// like a Web Worker's global scope. Messages are the browser's (see CLAUDE.md),
// sent as JSON so the sheet code only sees objects of its own context.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

const ROLL20_WORKER = new URL('../public/js/roll20-worker.js', import.meta.url);

const listeners = [];
const send = (message) => parentPort.postMessage(JSON.stringify(message));
const log = (level) => (...args) => send({ type: 'log', level, text: args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ') });

// The sheet's Roll20Async helpers create these to dispatch messages to themselves.
class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail ?? null;
  }
}

const scope = {
  console: { log() {}, info() {}, debug() {}, warn: log('warn'), error: log('error') },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  CustomEvent,
  postMessage: send,
  addEventListener(type, listener) {
    if (type === 'message') listeners.push(listener);
  },
  removeEventListener(type, listener) {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  },
  dispatchEvent(event) {
    for (const listener of listeners.slice()) listener.call(scope, event);
    return true;
  },
  importScripts() {
    vm.runInContext(workerData.sheetCode, context, { filename: 'gurps-sheet-worker.js' });
  },
};
scope.self = scope;
const context = vm.createContext(scope);
vm.runInContext(readFileSync(ROLL20_WORKER, 'utf8'), context, { filename: 'roll20-worker.js' });
const deliver = vm.runInContext('(json) => self.dispatchEvent({ data: JSON.parse(json) })', context);

parentPort.on('message', (json) => {
  // Answered once the thread gets to it, i.e. after any long-running sheet code.
  if (json === 'ping') return parentPort.postMessage('pong');
  deliver(json);
});
