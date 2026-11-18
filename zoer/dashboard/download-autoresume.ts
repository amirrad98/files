/**
 * Restart a paused download automatically (REQ-020).
 *
 * When a BC Bid "Download all" hits a recoverable browser failure, Zoer parks the run for 30 minutes
 * before one retry of its own. With this option on, the dashboard stops such a run and resumes it
 * within about 30 seconds instead. The plugin worker cannot stop or start a run, so this works only
 * while the Procurement workspace is open in a browser tab.
 */
import { useSyncExternalStore } from 'react';
import { host as bridgeHost } from './bridge';
import { capabilities, capabilitiesReady, subscribeCapabilities } from './capabilities';
import { DOCUMENT_STATS_SQL } from './document-processing';
import { batchPause } from './document-run';

type Host = (method: string, input?: unknown) => Promise<any>;
type Run = { id: string; actionId: string; status: string };
type Batch = { id: string; status: string; input?: string | null; error?: string | null };

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
const DOWNLOADS = new Set(['documents.download', 'documents.download.all', 'documents.download.missing']);
/** The only action Zoer parks for its own retry, and the only one that can be parked again after a resume. */
const PARKED_ACTION = 'documents.download.all';
/** Automatic restarts in a row that saved no file before the option turns itself off. */
export const STALL_LIMIT = 3;
export const CYCLE_MS = 30_000;

const text = (error: unknown) => error instanceof Error ? error.message : String(error);
const activeDownloads = (runs: Run[]) => runs.filter(run => DOWNLOADS.has(run.actionId) && !TERMINAL.has(run.status));

/**
 * A run Zoer parked for its scheduled retry: `documents.download.all`, `retry_scheduled`, and a `paused`
 * batch whose own message names the scheduled recovery. `retry_scheduled` alone is not enough: Zoer
 * uses it too while a plugin upgrade interrupts a download, and then the batch is not `paused`.
 */
export function isParkedDownload(run: Run, batches: Batch[]) {
  if (run.actionId !== PARKED_ACTION || run.status !== 'retry_scheduled') return false;
  const batch = batches.find(item => item.id === run.id);
  // Without the run list, `batchPause` decides from the batch's message alone.
  return !!batch && batch.status === 'paused' && batchPause(batch)?.state === 'retry';
}

/** Always `documents.download.all`: a resume as `documents.download` (50 notices or fewer) would never be parked again. */
export function resumeRequest(batch: Batch) {
  const recordIds = JSON.parse(batch.input || '{}').recordIds;
  if (!Array.isArray(recordIds) || !recordIds.length) throw new Error('The paused download has no saved list of notices.');
  return { actionId: PARKED_ACTION, input: { recordIds, force: false, resumeRunId: batch.id } };
}

/** Kept for the page load: whether the previous restart saved anything. */
export type Guard = { filesAtRestart: number; awaiting: boolean; stalled: number };
export const newGuard = (): Guard => ({ filesAtRestart: 0, awaiting: false, stalled: 0 });

export type CycleOutcome =
  | { kind: 'idle' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'unreadable'; error: string }
  | { kind: 'stalled' }
  | { kind: 'cancel_refused'; error: string }
  | { kind: 'start_refused'; error: string }
  | { kind: 'restarted'; runId: string };

/** One check: stop a parked download and resume it. The run list is read last so it is the newest reading. */
export async function resumeParkedDownload(host: Host, guard: Guard, stillWanted: () => boolean = () => true): Promise<CycleOutcome> {
  let batches: Batch[], files: number, runs: Run[];
  try {
    batches = (await host('catalog.state'))?.batches;
    if (!Array.isArray(batches)) throw new Error('The download list could not be read.');
    files = Number((await host('catalog.query', { statement: DOCUMENT_STATS_SQL, parameters: [] }))?.rows?.[0]?.downloaded);
    if (!Number.isFinite(files)) throw new Error('The number of saved files could not be read.');
    runs = (await host('state', { summary: true }))?.runs;
    if (!Array.isArray(runs)) throw new Error('The run list could not be read.');
  } catch (error) { return { kind: 'unreadable', error: text(error) }; }

  const active = activeDownloads(runs), parked = active.filter(run => isParkedDownload(run, batches));
  if (!parked.length) return { kind: 'idle' };
  if (active.length > 1) return { kind: 'skipped', reason: 'Another download is active, so nothing was restarted.' };
  const run = parked[0]!, batch = batches.find(item => item.id === run.id)!;
  let request: ReturnType<typeof resumeRequest>;
  try { request = resumeRequest(batch); } catch (error) { return { kind: 'skipped', reason: text(error) }; }

  // Judge the previous restart once: the download is parked again, so did it save anything?
  if (guard.awaiting) { guard.stalled = files > guard.filesAtRestart ? 0 : guard.stalled + 1; guard.awaiting = false; }
  if (guard.stalled >= STALL_LIMIT) return { kind: 'stalled' };
  // Turned off, or the workspace closed, while the reads were under way: stop nothing.
  if (!stillWanted()) return { kind: 'idle' };

  try { await host('cancel', { id: run.id }); } catch (error) { return { kind: 'cancel_refused', error: text(error) }; }
  let after: Run[];
  try {
    after = (await host('state', { summary: true }))?.runs;
    if (!Array.isArray(after)) throw new Error('The run list could not be read.');
  } catch (error) { return { kind: 'start_refused', error: text(error) }; }
  // Another browser or person may have restarted it already.
  if (activeDownloads(after).length) return { kind: 'skipped', reason: 'Another download started first, so nothing was restarted.' };
  try {
    const started = await host('action', request);
    guard.filesAtRestart = files; guard.awaiting = true;
    return { kind: 'restarted', runId: String(started?.run?.id ?? started?.runId ?? '') };
  } catch (error) { return { kind: 'start_refused', error: text(error) }; }
}

export type AutoResume = {
  on: boolean;
  /** This tab runs the checks. False while another tab of this browser holds the lock. */
  leader: boolean;
  restarts: number; lastAt: number | null;
  /** The last check's passing remark (a failed read, another download active). */
  note: string;
  /** Why the option turned itself off. */
  stopped: string;
};
const STORAGE_KEY = 'procurement.downloadAutoRestart';
const LOCK_NAME = 'procurement-download-auto-restart';
const OFF: AutoResume = { on: false, leader: false, restarts: 0, lastAt: null, note: '', stopped: '' };

let state: AutoResume = OFF;
let guard = newGuard();
let started = false;
let onChanged: () => void = () => {};
let timer: ReturnType<typeof setInterval> | undefined;
let cycle: Promise<CycleOutcome | undefined> | undefined;
/** Changes whenever the option or the workspace session changes, so a check from before reports nothing. */
let session = 0;
/** The stored choice could not be written (or read): this tab keeps its own choice and does not follow storage. */
let pageOnly = false;
let manual = 0;
let abandon: AbortController | undefined;
let release: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const set = (next: Partial<AutoResume>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };

/** `null` when the browser refuses storage: the choice then lasts for the page only. */
function readStored(): boolean | null {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { pageOnly = true; return null; }
}
function writeStored(on: boolean) {
  try { on ? localStorage.setItem(STORAGE_KEY, '1') : localStorage.removeItem(STORAGE_KEY); pageOnly = false; }
  catch { pageOnly = true; }
}
/** Never on a read-only host, and not before the host has said what it allows. */
const allowed = () => capabilitiesReady() && capabilities().collection;

function lead() {
  const locks = (globalThis.navigator as any)?.locks;
  if (!locks?.request) { set({ leader: true }); return; }
  const mine = abandon = new AbortController();
  // Held for as long as the option is on here, so one tab of this browser runs the checks.
  void locks.request(LOCK_NAME, { signal: mine.signal }, () => new Promise<void>(resolve => {
    if (mine.signal.aborted) { resolve(); return; }
    release = resolve; set({ leader: true });
  })).catch(() => {
    // Our own abort (turned off while waiting) ends here. Any other refusal, such as a sandboxed frame
    // that has the API but may not use it, means no tab can share a lock: this tab checks by itself.
    if (!mine.signal.aborted && abandon === mine) set({ leader: true });
  });
}
function follow() {
  abandon?.abort(); abandon = undefined;
  release?.(); release = undefined;
}
function apply(on: boolean, stopped = '') {
  if (on === state.on) { if (stopped) set({ stopped }); return; }
  follow();
  guard = newGuard(); session++;
  set({ ...OFF, on, stopped });
  if (on) lead();
}
/** The user's choice. Turning it on again starts the count of fruitless restarts from zero. */
export function setAutoResume(on: boolean) {
  if (on && !allowed()) return;
  writeStored(on); apply(on);
}
function turnOff(reason: string) { writeStored(false); apply(false, reason); }

const STALLED = `Automatic restart turned itself off: ${STALL_LIMIT} restarts in a row saved no new file. BC Bid's browser check needs a person. Complete it in the download browser, then turn this on again.`;
async function runCycle(): Promise<CycleOutcome> {
  const mine = session, current = () => started && session === mine;
  const outcome = await resumeParkedDownload(bridgeHost, guard, current);
  if (outcome.kind === 'restarted' && started) onChanged();
  // Turned off, or the workspace closed and reopened, while the check was in flight: nothing is reported here.
  if (!current()) return outcome;
  if (outcome.kind === 'restarted') set({ restarts: state.restarts + 1, lastAt: Date.now(), note: '' });
  else if (outcome.kind === 'stalled') turnOff(STALLED);
  else if (outcome.kind === 'start_refused') { turnOff(`Automatic restart turned itself off: the paused download was stopped but could not be started again (${outcome.error}). Use Retry in History to resume it.`); onChanged(); }
  else if (outcome.kind === 'cancel_refused') set({ note: `The paused download could not be stopped (${outcome.error}). Trying again.` });
  else if (outcome.kind === 'unreadable') set({ note: `The download could not be checked (${outcome.error}). Trying again.` });
  else set({ note: outcome.kind === 'skipped' ? outcome.reason : '' });
  return outcome;
}
/** Follow the stored choice: another tab of this browser may have changed it, or the option turned itself off there. */
function sync() {
  if (!started || pageOnly) return;
  const stored = readStored();
  if (stored !== null && (stored && allowed()) !== state.on) apply(stored && allowed());
}
function tick() {
  if (!started) return;
  sync();
  if (!state.on || !state.leader || !allowed() || cycle || manual) return;
  cycle = runCycle().catch(() => undefined).finally(() => { cycle = undefined; });
}
const storageChanged = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) sync(); };

/**
 * Started with the workspace, so it runs on every Procurement page. The interval is not tied to tab
 * visibility: a hidden tab still checks, as often as the browser lets a background tab run.
 */
export function startAutoResume(changed: () => void = () => {}) {
  stopAutoResume();
  started = true; onChanged = changed; session++;
  // A stored choice takes effect once the host has said that it allows collection, not before.
  sync(); unsubscribe = subscribeCapabilities(sync);
  timer = setInterval(tick, CYCLE_MS);
  if (typeof window !== 'undefined') window.addEventListener('storage', storageChanged);
  return stopAutoResume;
}
function stopAutoResume() {
  if (!started) return;
  started = false; session++; pageOnly = false; clearInterval(timer); timer = undefined;
  unsubscribe?.(); unsubscribe = undefined;
  if (typeof window !== 'undefined') window.removeEventListener('storage', storageChanged);
  follow(); guard = newGuard(); set(OFF);
}

export function useAutoResume() { return useSyncExternalStore(subscribe, () => state); }

/**
 * Run a manual download control (start, stop, retry) apart from the automatic check: wait for a check
 * in flight, and let none begin until the control has finished.
 */
export async function withManualDownloadControl<T>(control: (awaited?: CycleOutcome) => Promise<T>): Promise<T> {
  manual++;
  try { return await control(await cycle); }
  finally { manual--; }
}

/**
 * Stop a download by hand. If the check that was in flight has just restarted it, the id the user
 * clicked belongs to the run that check stopped, so the run it started is stopped as well.
 */
export function stopDownloadRun(id: string) {
  return withManualDownloadControl(async awaited => {
    await bridgeHost('cancel', { id });
    if (awaited?.kind !== 'restarted') return;
    if (awaited.runId) { if (awaited.runId !== id) await bridgeHost('cancel', { id: awaited.runId }); return; }
    // The host did not name the new run: stop whichever "Download all" run is active now.
    const runs: Run[] = (await bridgeHost('state', { summary: true }))?.runs ?? [];
    for (const run of activeDownloads(runs)) if (run.actionId === PARKED_ACTION) await bridgeHost('cancel', { id: run.id });
  });
}
