// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-020: with the option on, the dashboard stops a download Zoer parked for its 30-minute retry
// and resumes it within about 30 seconds. Every test answers the one bridge function here.
const bridge = vi.hoisted(() => ({ host: vi.fn(async (_method: string, _input?: any): Promise<any> => ({})) }));
vi.mock('../zoer/dashboard/bridge', () => ({
  host: (method: string, input?: unknown) => bridge.host(method, input),
  subscribeHost: () => () => {}, guardHost: () => {}, bindNativeHost: () => () => {},
}));
const workspace = vi.hoisted(() => ({ model: undefined as any, refresh: vi.fn(async () => {}), reload: vi.fn(async () => {}) }));
vi.mock('../zoer/dashboard/backend', async original => ({
  ...await original<typeof import('../zoer/dashboard/backend')>(),
  useWorkspace: () => ({ model: workspace.model }), refresh: () => workspace.refresh(), refreshAfterChange: () => workspace.reload(),
}));
vi.mock('../zoer/dashboard/document-scope', async original => ({
  ...await original<typeof import('../zoer/dashboard/document-scope')>(),
  readDocumentCandidates: async () => [{ id: 'opportunity:1', data: { status: 'Open', closingDate: '2099-01-01', attachments: [{}, {}], detailsCaptured: true } }],
}));
// The page test starts a download from a stand-in picker; the statistics strip and the notice view have their own tests.
vi.mock('../zoer/dashboard/RecordPicker', () => ({
  RecordPicker: ({ setSelection, actions }: any) => <div><button type="button" onClick={() => setSelection(new Set(['opportunity:1']))}>Pick one</button>{actions}</div>,
}));
vi.mock('../zoer/dashboard/procurement/NoticeView', () => ({ NoticeView: () => null }));
vi.mock('../zoer/dashboard/DocumentInventory', async original => ({
  ...await original<typeof import('../zoer/dashboard/DocumentInventory')>(), DocumentStats: () => null,
}));

import { BatchHistory } from '../zoer/dashboard/BatchHistory';
import { Documents } from '../zoer/dashboard/Documents';
import { DocumentFiles } from '../zoer/dashboard/DocumentInventory';
import { DOCUMENT_STATS_SQL } from '../zoer/dashboard/document-processing';
import { BulkDocuments } from '../zoer/dashboard/BulkDocuments';
import { loadCapabilities, resetCapabilities } from '../zoer/dashboard/capabilities';
import * as autoResume from '../zoer/dashboard/download-autoresume';
import { CYCLE_MS, STALL_LIMIT, isParkedDownload, newGuard, resumeParkedDownload, resumeRequest } from '../zoer/dashboard/download-autoresume';
const SECURITY = () => Promise.reject(new DOMException('Access to the Locks API is denied in this context.', 'SecurityError'));
import { buildModel } from '../zoer/dashboard/model';

const RECOVERY = 'Download stopped. Automatic browser recovery is scheduled for 2099-11-18T08:18:40.419Z. Saved files are retained.';
const ALL = 'documents.download.all';
const KEY = 'procurement.downloadAutoRestart';
const ids = (count: number) => Array.from({ length: count }, (_, index) => `opportunity:${index + 1}`);
const batch = (id = 'run-1', status = 'paused', error: string | null = RECOVERY, count = 3) =>
  ({ id, kind: 'download', status, error, input: JSON.stringify({ recordIds: ids(count), force: false, deferExtraction: true, checkpointGeneration: id }), completed: 1, failed: 0, total: count, updated_at: '2026-11-18T10:04:53Z' });
const run = (id = 'run-1', status = 'retry_scheduled', actionId = ALL) => ({ id, actionId, status, createdAt: '2026-11-18T09:33:30Z' });
const FULL = { version: 1, surface: 'zoer', collection: true, writes: true, ai: true };
const READ_ONLY = { ...FULL, collection: false, writes: false };

/** A host for one check. `runs` holds the successive answers to `state` (the last one repeats). */
function fakeHost(options: { batches?: any[]; files?: any; runs: any[][]; fail?: Record<string, string>; failStateRead?: number }) {
  const calls: [string, any][] = []; let stateReads = 0;
  const host = async (method: string, input?: any) => {
    calls.push([method, input]);
    if (method === 'state' && ++stateReads === options.failStateRead) throw new Error('state read failed');
    if (options.fail?.[method]) throw new Error(options.fail[method]);
    if (method === 'catalog.state') return { batches: options.batches ?? [batch()] };
    if (method === 'catalog.query') return { rows: 'files' in options ? [{ downloaded: options.files }] : [{ downloaded: 10 }] };
    if (method === 'state') return { runs: options.runs[Math.min(stateReads, options.runs.length) - 1] };
    if (method === 'action') return { run: { id: 'new-run' } };
    return { run: {} };
  };
  return { host, calls, methods: () => calls.map(([method]) => method) };
}
const PARKED = { runs: [[run()], []] };

describe('one check', () => {
  it('AC-060: with no parked download nothing is stopped or started', async () => {
    const cases: [string, Parameters<typeof fakeHost>[0]][] = [
      ['no download run', { runs: [[]] }],
      ['an ended run', { runs: [[run('run-1', 'cancelled')]] }],
      ['transferring', { runs: [[run('run-1', 'running')]], batches: [batch('run-1', 'running', null)] }],
      ['queued', { runs: [[run('run-1', 'pending')]] }],
      ['waiting for approval', { runs: [[run('run-1', 'waiting_for_approval')]] }],
      ['waiting for an update', { runs: [[run('run-1', 'waiting_for_event')]], batches: [batch('run-1', 'paused', 'Paused for Zoer update')] }],
      ['plugin-upgrade wait: retry_scheduled with a stopped batch', { runs: [[run()]], batches: [batch('run-1', 'stopped', 'Stopped for a plugin upgrade.')] }],
      ['retry_scheduled with a running batch', { runs: [[run()]], batches: [batch('run-1', 'running', null)] }],
      ['retry_scheduled with no batch', { runs: [[run()]], batches: [] }],
      ['retry_scheduled, paused without the recovery message', { runs: [[run()]], batches: [batch('run-1', 'paused', null)] }],
      ['retry_scheduled, paused for an update', { runs: [[run()]], batches: [batch('run-1', 'paused', 'Paused for Zoer update')] }],
      ['Keep documents current, parked-looking', { runs: [[run('run-1', 'retry_scheduled', 'documents.download.missing')]] }],
      ['selected notices, parked-looking', { runs: [[run('run-1', 'retry_scheduled', 'documents.download')]] }],
    ];
    for (const [name, options] of cases) {
      const fake = fakeHost(options);
      expect(await resumeParkedDownload(fake.host, newGuard()), name).toEqual({ kind: 'idle' });
      expect(fake.methods(), name).toEqual(['catalog.state', 'catalog.query', 'state']);
    }
    expect(isParkedDownload(run(), [batch()])).toBe(true);
  });
  it('AC-061: a parked download is stopped, the run list read again, and documents.download.all resumed for any size', async () => {
    for (const count of [3, 50, 60]) {
      const fake = fakeHost({ ...PARKED, batches: [batch('other', 'succeeded', null), batch('run-1', 'paused', RECOVERY, count)] });
      expect(await resumeParkedDownload(fake.host, newGuard())).toEqual({ kind: 'restarted', runId: 'new-run' });
      expect(fake.methods()).toEqual(['catalog.state', 'catalog.query', 'state', 'cancel', 'state', 'action']);
      expect(fake.calls[3]![1]).toEqual({ id: 'run-1' });
      expect(fake.calls[5]![1]).toEqual({ actionId: ALL, input: { recordIds: ids(count), force: false, resumeRunId: 'run-1' } });
    }
    // Internal checkpoint fields of the stored input are not sent back.
    expect(resumeRequest(batch())).toEqual({ actionId: ALL, input: { recordIds: ids(3), force: false, resumeRunId: 'run-1' } });
  });
  it('AC-062: another active download run, in either order, means nothing is stopped or started', async () => {
    const others = [run('run-2', 'running'), run('run-2', 'pending', 'documents.download.missing'), run('run-2', 'retry_scheduled', 'documents.download')];
    for (const other of others) for (const runs of [[run(), other], [other, run()]]) {
      const fake = fakeHost({ runs: [runs], batches: [batch(), batch('run-2', 'running', null)] });
      expect((await resumeParkedDownload(fake.host, newGuard())).kind).toBe('skipped');
      expect(fake.methods()).toEqual(['catalog.state', 'catalog.query', 'state']);
    }
    // Two parked downloads are also two active runs.
    const two = fakeHost({ runs: [[run(), run('run-2')]], batches: [batch(), batch('run-2')] });
    expect((await resumeParkedDownload(two.host, newGuard())).kind).toBe('skipped');
    expect(two.methods()).not.toContain('cancel');
  });
  it('AC-062: a download that another browser started after the stop is not doubled', async () => {
    const fake = fakeHost({ runs: [[run()], [run('run-1', 'cancelled'), run('run-9', 'pending')]] });
    expect((await resumeParkedDownload(fake.host, newGuard())).kind).toBe('skipped');
    expect(fake.methods()).toEqual(['catalog.state', 'catalog.query', 'state', 'cancel', 'state']);
  });
  it('AC-063: a failed read is a no-op, and an unreadable count is neither progress nor a stall', async () => {
    for (const method of ['catalog.state', 'catalog.query', 'state']) {
      const fake = fakeHost({ ...PARKED, fail: { [method]: `${method} failed` } }), guard = { filesAtRestart: 10, awaiting: true, stalled: 2 };
      expect(await resumeParkedDownload(fake.host, guard), method).toEqual({ kind: 'unreadable', error: `${method} failed` });
      expect(fake.methods()).not.toContain('cancel'); expect(fake.methods()).not.toContain('action');
      expect(guard).toEqual({ filesAtRestart: 10, awaiting: true, stalled: 2 });
    }
    // An empty catalog reports no number at all (SQL NULL), which is zero files, not an unreadable count.
    expect((await resumeParkedDownload(fakeHost({ ...PARKED, files: null }).host, newGuard())).kind).toBe('restarted');
    for (const files of ['many', undefined, {}]) {
      const fake = fakeHost({ ...PARKED, files }), guard = { filesAtRestart: 10, awaiting: true, stalled: 0 };
      expect((await resumeParkedDownload(fake.host, guard)).kind).toBe('unreadable');
      expect(fake.methods()).toEqual(['catalog.state', 'catalog.query']);
      expect(guard.awaiting).toBe(true);
    }
  });
  it('AC-063: a refused stop starts nothing; a failed re-read or a refused start is reported as start_refused', async () => {
    const refused = fakeHost({ ...PARKED, fail: { cancel: 'Workspace run not found' } });
    expect(await resumeParkedDownload(refused.host, newGuard())).toEqual({ kind: 'cancel_refused', error: 'Workspace run not found' });
    expect(refused.methods()).toEqual(['catalog.state', 'catalog.query', 'state', 'cancel']);
    const reread = fakeHost({ ...PARKED, failStateRead: 2 });
    expect(await resumeParkedDownload(reread.host, newGuard())).toEqual({ kind: 'start_refused', error: 'state read failed' });
    expect(reread.methods()).toEqual(['catalog.state', 'catalog.query', 'state', 'cancel', 'state']);
    const start = fakeHost({ ...PARKED, fail: { action: 'Plugin action plan is stale' } }), guard = newGuard();
    expect(await resumeParkedDownload(start.host, guard)).toEqual({ kind: 'start_refused', error: 'Plugin action plan is stale' });
    expect(guard.awaiting).toBe(false);
    // A paused batch without its list of notices cannot be resumed, so it is not stopped either.
    const empty = fakeHost({ ...PARKED, batches: [{ ...batch(), input: '{}' }] });
    expect((await resumeParkedDownload(empty.host, newGuard())).kind).toBe('skipped');
    expect(empty.methods()).not.toContain('cancel');
  });
  it('AC-065.1: a check that is no longer wanted when its reads return stops nothing', async () => {
    const fake = fakeHost(PARKED);
    expect(await resumeParkedDownload(fake.host, newGuard(), () => false)).toEqual({ kind: 'idle' });
    expect(fake.methods()).toEqual(['catalog.state', 'catalog.query', 'state']);
  });
  it('AC-064: after three restarts in a row without a new saved file nothing more is stopped or started', async () => {
    const guard = newGuard();
    const check = (files: number, extra: object = {}) => { const fake = fakeHost({ ...PARKED, files, ...extra }); return resumeParkedDownload(fake.host, guard).then(outcome => ({ kind: outcome.kind, methods: fake.methods() })); };
    expect(STALL_LIMIT).toBe(3);
    expect((await check(10)).kind).toBe('restarted');          // restart 1
    expect((await check(10)).kind).toBe('restarted');          // 1 saved nothing; restart 2
    // A check that cannot stop the run judges the previous restart once, not on every check.
    expect((await check(10, { fail: { cancel: 'busy' } })).kind).toBe('cancel_refused');
    expect(guard.stalled).toBe(2);
    expect((await check(10, { fail: { cancel: 'busy' } })).kind).toBe('cancel_refused');
    expect(guard.stalled).toBe(2);
    expect((await check(10)).kind).toBe('restarted');          // restart 3
    const fourth = await check(10);                             // 3 saved nothing
    expect(fourth).toEqual({ kind: 'stalled', methods: ['catalog.state', 'catalog.query', 'state'] });
    expect((await check(99)).kind).toBe('stalled');             // stays stalled until the option is turned on again
  });
  it('AC-064: a restart that saved a file resets the count', async () => {
    const guard = newGuard();
    const kinds: string[] = [];
    for (const files of [10, 10, 10, 11, 11, 11, 11]) kinds.push((await resumeParkedDownload(fakeHost({ ...PARKED, files }).host, guard)).kind);
    // 10: restart; 10: stalled 1; 10: stalled 2; 11: progress, reset; 11: 1; 11: 2; 11: 3 -> stalled
    expect(kinds).toEqual(['restarted', 'restarted', 'restarted', 'restarted', 'restarted', 'restarted', 'stalled']);
  });
});

describe('watcher', () => {
  type Tab = { auto: typeof autoResume; stop: () => void; changed: ReturnType<typeof vi.fn>; ready: (value?: object) => Promise<unknown> };
  const tabs: Tab[] = [];
  /** A browser tab: its own copy of the module, sharing storage, Web Locks and the host. */
  async function openTab(capabilities: object | null = FULL): Promise<Tab> {
    vi.resetModules();
    const caps = await import('../zoer/dashboard/capabilities');
    const auto = await import('../zoer/dashboard/download-autoresume');
    const changed = vi.fn();
    const ready = (value: object = FULL) => caps.loadCapabilities(async () => value);
    if (capabilities) await ready(capabilities);
    const tab = { auto, stop: auto.startAutoResume(changed), changed, ready };
    tabs.push(tab); return tab;
  }
  const count = (method: string) => bridge.host.mock.calls.filter(([name]) => name === method).length;
  const pass = (ms = CYCLE_MS) => vi.advanceTimersByTimeAsync(ms);
  /** Answers for one parked download that is stopped and resumed on every check. */
  function parkedHost(extra: (method: string) => any = () => undefined) {
    let cancelled = false;
    bridge.host.mockImplementation(async (method: string) => {
      const special = extra(method); if (special !== undefined) return special;
      if (method === 'catalog.state') return { batches: [batch()] };
      if (method === 'catalog.query') return { rows: [{ downloaded: 10 }] };
      if (method === 'state') { const runs = cancelled ? [] : [run()]; cancelled = false; return { runs }; }
      if (method === 'cancel') { cancelled = true; return { run: {} }; }
      return { run: { id: 'new-run' } };
    });
  }
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); bridge.host.mockReset(); bridge.host.mockImplementation(async (method: string) => method === 'state' ? { runs: [] } : method === 'catalog.state' ? { batches: [] } : { rows: [{ downloaded: 0 }] }); });
  afterEach(() => { for (const tab of tabs.splice(0)) tab.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('AC-065.1: off by default; on, it checks every 30 seconds, also in a hidden tab, and stops when turned off', async () => {
    const tab = await openTab();
    expect(tab.auto.useAutoResume).toBeTypeOf('function');
    await pass(3 * CYCLE_MS);
    expect(bridge.host).not.toHaveBeenCalled();
    tab.auto.setAutoResume(true);
    await pass(CYCLE_MS - 1);
    expect(count('state')).toBe(0);
    await pass(1);
    expect(count('state')).toBe(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await pass(2 * CYCLE_MS);
    expect(count('state')).toBe(3);
    tab.auto.setAutoResume(false);
    await pass(3 * CYCLE_MS);
    expect(count('state')).toBe(3);
  });
  it('AC-065.1: two checks never overlap, and closing the workspace ends them', async () => {
    const tab = await openTab();
    let answer = (_value: any) => {};
    bridge.host.mockImplementation(async (method: string) => method === 'catalog.state' ? new Promise(resolve => { answer = resolve; }) : method === 'state' ? { runs: [] } : { rows: [{ downloaded: 0 }] });
    tab.auto.setAutoResume(true);
    await pass(4 * CYCLE_MS);
    expect(count('catalog.state')).toBe(1);
    answer({ batches: [] });
    await pass(CYCLE_MS);
    expect(count('catalog.state')).toBe(2);
    answer({ batches: [] });
    tab.stop();
    await pass(4 * CYCLE_MS);
    expect(count('catalog.state')).toBe(2);
  });
  it('AC-061 and AC-066: a restart is counted, timed, and reloads the lists', async () => {
    const tab = await openTab();
    parkedHost();
    tab.auto.setAutoResume(true);
    vi.setSystemTime(new Date('2026-11-18T10:05:00Z'));
    await pass();
    expect(bridge.host.mock.calls.map(([method]) => method)).toEqual(['catalog.state', 'catalog.query', 'state', 'cancel', 'state', 'action']);
    expect(bridge.host.mock.calls[5]![1]).toEqual({ actionId: ALL, input: { recordIds: ids(3), force: false, resumeRunId: 'run-1' } });
    expect(tab.changed).toHaveBeenCalledTimes(1);
    expect(tab.auto.useAutoResume).toBeDefined();
  });
  it('AC-065.3: the choice is stored per browser, a new tab picks it up, and storage that refuses keeps it for the page', async () => {
    const first = await openTab();
    first.auto.setAutoResume(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    first.stop();
    await openTab();
    await pass();
    expect(count('state')).toBe(1);
    for (const tab of tabs.splice(0)) tab.stop();
    localStorage.clear(); bridge.host.mockClear();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const refused = await openTab();
    refused.auto.setAutoResume(true);
    await pass(2 * CYCLE_MS);
    expect(count('state')).toBe(2);
  });
  it('AC-063 and AC-065.3: a refused start turns the option off, stores that, and is not repeated', async () => {
    const tab = await openTab();
    parkedHost(method => { if (method === 'action') throw new Error('Plugin action plan is stale'); return undefined; });
    tab.auto.setAutoResume(true);
    await pass();
    expect(count('action')).toBe(1);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(tab.changed).toHaveBeenCalledTimes(1);
    await pass(3 * CYCLE_MS);
    expect(count('action')).toBe(1); expect(count('cancel')).toBe(1);
  });
  it('AC-063: a refused stop or a failed read leaves the option on and the next check tries again', async () => {
    const tab = await openTab();
    let refuse = true;
    parkedHost(method => { if (method === 'cancel' && refuse) throw new Error('busy'); return undefined; });
    tab.auto.setAutoResume(true);
    await pass(2 * CYCLE_MS);
    expect(count('cancel')).toBe(2); expect(count('action')).toBe(0);
    expect(localStorage.getItem(KEY)).toBe('1');
    refuse = false;
    await pass();
    expect(count('action')).toBe(1);
  });
  it('AC-064 and AC-065.3: the guard turns the option off after three fruitless restarts; turning it on again starts from zero', async () => {
    const tab = await openTab();
    parkedHost();
    tab.auto.setAutoResume(true);
    await pass(3 * CYCLE_MS);
    expect(count('action')).toBe(3);
    await pass();
    expect(count('action')).toBe(3); expect(count('cancel')).toBe(3);
    expect(localStorage.getItem(KEY)).toBeNull();
    await pass(3 * CYCLE_MS);
    expect(count('cancel')).toBe(3);
    tab.auto.setAutoResume(true);
    await pass(3 * CYCLE_MS);
    expect(count('action')).toBe(6);
  });
  it('AC-065.3: another tab follows a stored change, by its event and before each check', async () => {
    const a = await openTab(), b = await openTab();
    a.auto.setAutoResume(true);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    await pass();
    expect(count('state')).toBe(2);       // no Web Locks here: both tabs check
    localStorage.removeItem(KEY);          // turned off elsewhere, no event delivered
    await pass(2 * CYCLE_MS);
    expect(count('state')).toBe(2);
    expect(b.changed).not.toHaveBeenCalled();
  });
  it('AC-065.4: with Web Locks one tab checks, and another takes over when it closes', async () => {
    const queue: { run: () => void; signal?: AbortSignal }[] = []; let held = false;
    const grant = () => { const next = queue.shift(); if (!next) return; if (next.signal?.aborted) { grant(); return; } next.run(); };
    vi.stubGlobal('navigator', { ...navigator, locks: { request: (_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      queue.push({ signal: options.signal, run: () => { held = true; void callback().then(() => { held = false; resolve(); grant(); }); } });
      if (!held) grant();
    }) } });
    const a = await openTab(), b = await openTab();
    a.auto.setAutoResume(true); b.auto.setAutoResume(true);
    await pass(2 * CYCLE_MS);
    expect(count('state')).toBe(2);       // one check per interval, not two
    a.stop();
    await pass(2 * CYCLE_MS);
    expect(count('state')).toBe(4);       // the second tab took over
    b.auto.setAutoResume(false);
    await pass(2 * CYCLE_MS);
    expect(count('state')).toBe(4);
  });
  it('AC-065.4: where Web Locks exist but are refused (a sandboxed frame) the tab checks by itself, also without storage', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: { request: SECURITY } });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const tab = await openTab();
    tab.auto.setAutoResume(true);
    await pass(3 * CYCLE_MS);
    expect(count('state')).toBe(3);
  });
  it('AC-065.4: a tab turned off while it waits for the lock never takes over', async () => {
    const queue: { run: () => void; signal?: AbortSignal }[] = []; let held = false;
    const grant = () => { const next = queue.shift(); if (!next) return; if (next.signal?.aborted) { grant(); return; } next.run(); };
    vi.stubGlobal('navigator', { ...navigator, locks: { request: (_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      queue.push({ signal: options.signal, run: () => { held = true; void callback().then(() => { held = false; resolve(); grant(); }); } });
      if (!held) grant();
    }) } });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });   // each tab keeps its own choice
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const a = await openTab(), b = await openTab();
    a.auto.setAutoResume(true); b.auto.setAutoResume(true);
    b.auto.setAutoResume(false);          // gives up its place in the queue
    await pass();
    expect(count('state')).toBe(1);
    a.stop();
    await pass(3 * CYCLE_MS);
    expect(count('state')).toBe(1);
  });
  it('AC-065.3: storage that reads but refuses to write keeps the choice for the page', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const tab = await openTab();
    tab.auto.setAutoResume(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    await pass(3 * CYCLE_MS);
    expect(count('state')).toBe(3);
  });
  it('AC-065.5: a read-only host cannot turn it on, and nothing runs before the host has answered', async () => {
    const readOnly = await openTab(READ_ONLY);
    readOnly.auto.setAutoResume(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, '1');       // turned on earlier in this browser, on a full host
    await pass(2 * CYCLE_MS);
    expect(bridge.host).not.toHaveBeenCalled();
    readOnly.stop(); tabs.splice(0);
    const waiting = await openTab(null);
    await pass(2 * CYCLE_MS);
    expect(bridge.host).not.toHaveBeenCalled();
    await waiting.ready();
    await pass();
    expect(count('state')).toBe(1);
  });
  it('AC-065.6: a manual control waits for a check in flight, and no check starts during it', async () => {
    const tab = await openTab();
    let answer = (_value: any) => {};
    bridge.host.mockImplementation(async (method: string) => method === 'catalog.state' ? new Promise(resolve => { answer = resolve; }) : method === 'state' ? { runs: [] } : { rows: [{ downloaded: 0 }] });
    tab.auto.setAutoResume(true);
    await pass();
    expect(count('catalog.state')).toBe(1);
    let finish = () => {}; const control = vi.fn(() => new Promise<string>(resolve => { finish = () => resolve('stopped'); }));
    const manual = tab.auto.withManualDownloadControl(control);
    await pass(100);
    expect(control).not.toHaveBeenCalled();           // the check is still in flight
    answer({ batches: [] });
    await pass(100);
    expect(control).toHaveBeenCalledTimes(1);
    await pass(3 * CYCLE_MS);
    expect(count('catalog.state')).toBe(1);            // no check while the control runs
    finish();
    await expect(manual).resolves.toBe('stopped');
    await pass();
    expect(count('catalog.state')).toBe(2);
    // A control that fails releases the hold too.
    answer({ batches: [] });
    await expect(tab.auto.withManualDownloadControl(async () => { throw new Error('refused'); })).rejects.toThrow('refused');
    await pass();
    expect(count('catalog.state')).toBe(3);
  });
  it('AC-065.2: the workspace itself starts the checks, on any page, and ends them when it closes', async () => {
    vi.resetModules();
    const caps = await import('../zoer/dashboard/capabilities');
    const backend = await vi.importActual<typeof import('../zoer/dashboard/backend')>('../zoer/dashboard/backend');
    await caps.loadCapabilities(async () => FULL);
    localStorage.setItem(KEY, '1');
    const checks = () => bridge.host.mock.calls.filter(([method, input]) => method === 'catalog.query' && input?.statement === DOCUMENT_STATS_SQL).length;
    const close = backend.startWorkspace();
    try {
      await pass(2 * CYCLE_MS);
      expect(checks()).toBe(2);
    } finally {
      // The test runner's stand-in query client has no `cancelQueries`, which the workspace calls last when it closes.
      try { close(); } catch { /* after the checks were stopped */ }
    }
    await pass(3 * CYCLE_MS);
    expect(checks()).toBe(2);
  });
});

describe('interface', () => {
  const view = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
  const modelWith = (...runs: any[]) => buildModel({ runs, artifacts: [] }, []);
  let stop = () => {};
  const open = async (capabilities: object = FULL) => { resetCapabilities(); await loadCapabilities(async () => capabilities); stop = autoResume.startAutoResume(); };
  beforeEach(() => { localStorage.clear(); bridge.host.mockReset(); bridge.host.mockImplementation(async () => ({})); workspace.model = undefined; });
  afterEach(() => { cleanup(); stop(); resetCapabilities(); vi.useRealTimers(); });

  it('AC-066: the checkbox turns the option on and off and says where it works', async () => {
    await open();
    view(<BulkDocuments running={false} onStarted={async () => {}} />);
    const box = await screen.findByRole('checkbox', { name: 'Restart automatically when paused' });
    expect(box).not.toBeChecked();
    expect(box.closest('p')).toHaveTextContent('Works while this workspace is open in a browser tab.');
    expect(screen.queryByText(/Automatic restart is on/)).toBeNull();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(screen.getByText('Automatic restart is on. No automatic restart yet.')).toBeInTheDocument();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.queryByText(/Automatic restart is on/)).toBeNull();
  });
  it('AC-065.5: a read-only host shows no checkbox', async () => {
    await open(READ_ONLY);
    view(<BulkDocuments running={false} onStarted={async () => {}} />);
    await screen.findByRole('button', { name: 'Download all' });
    expect(screen.queryByRole('checkbox', { name: 'Restart automatically when paused' })).toBeNull();
  });
  it('AC-066: while on, a parked download says this workspace restarts it; while off, when Zoer retries', async () => {
    await open();
    workspace.model = modelWith({ ...run(), error: RECOVERY });
    const paused = batch();
    view(<><BulkDocuments running={false} onStarted={async () => {}} /><BatchHistory title="Download history" kind="download" links={false} batches={[paused]} onChanged={async () => {}} onError={() => {}} /></>);
    expect(await screen.findByText(/The download is paused and nothing is transferring\. Zoer retries automatically at/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is downloading\. Zoer retries automatically at/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Restart automatically when paused' }));
    expect(screen.getByText('The download is paused and nothing is transferring. This workspace restarts it automatically within about 30 seconds.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is downloading. This workspace restarts it automatically within about 30 seconds; Stop ends the wait and keeps what is saved.')).toBeInTheDocument();
    expect(screen.queryByText(/Zoer retries automatically/)).toBeNull();
  });
  it('AC-066: the status line counts restarts with the time of the last, and shows why the option turned itself off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    let cancelled = false, refuseStart = false;
    bridge.host.mockImplementation(async (method: string) => {
      if (method === 'catalog.state') return { batches: [batch()], prompts: [] };
      if (method === 'catalog.query') return { rows: [{ downloaded: 10 }] };
      if (method === 'state') { const runs = cancelled ? [] : [run()]; cancelled = false; return { runs }; }
      if (method === 'cancel') { cancelled = true; return { run: {} }; }
      if (method === 'action' && refuseStart) throw new Error('Plugin action plan is stale');
      return { run: { id: 'new-run' } };
    });
    view(<BulkDocuments running={false} onStarted={async () => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Restart automatically when paused' }));
    vi.setSystemTime(new Date('2026-11-18T10:05:00Z'));
    await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
    const time = new Date(Date.now()).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(screen.getByText(`Automatic restart is on. 1 automatic restart, the last at ${time}.`)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
    expect(screen.getByText(/Automatic restart is on\. 2 automatic restarts, the last at /)).toBeInTheDocument();
    refuseStart = true;
    await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
    expect(screen.getByRole('checkbox', { name: 'Restart automatically when paused' })).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Automatic restart turned itself off: the paused download was stopped but could not be started again (Plugin action plan is stale). Use Retry in History to resume it.');
  });
  it('AC-064 and AC-066: after three fruitless restarts the reason names the browser check; a passing remark shows while on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    let cancelled = false, failRead = true;
    bridge.host.mockImplementation(async (method: string) => {
      if (method === 'catalog.state') { if (failRead) throw new Error('Zoer workspace request timed out.'); return { batches: [batch()], prompts: [] }; }
      if (method === 'catalog.query') return { rows: [{ downloaded: 10 }] };
      if (method === 'state') { const runs = cancelled ? [] : [run()]; cancelled = false; return { runs }; }
      if (method === 'cancel') { cancelled = true; return { run: {} }; }
      return { run: { id: 'new-run' } };
    });
    view(<BulkDocuments running={false} onStarted={async () => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Restart automatically when paused' }));
    await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
    expect(screen.getByText('Automatic restart is on. No automatic restart yet. The download could not be checked (Zoer workspace request timed out.). Trying again.')).toBeInTheDocument();
    failRead = false;
    await act(() => vi.advanceTimersByTimeAsync(4 * CYCLE_MS));
    expect(screen.getByRole('alert')).toHaveTextContent("Automatic restart turned itself off: 3 restarts in a row saved no new file. BC Bid's browser check needs a person. Complete it in the download browser, then turn this on again.");
    expect(screen.getByRole('checkbox', { name: 'Restart automatically when paused' })).not.toBeChecked();
  });
  it('AC-066: a tab that does not hold the lock says another tab is handling it', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: { request: () => new Promise(() => {}) } });
    try {
      await open();
      view(<BulkDocuments running={false} onStarted={async () => {}} />);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Restart automatically when paused' }));
      expect(screen.getByText('Automatic restart is on. Another tab of this browser is handling it.')).toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });
  /** A parked download whose check hangs on its saved-file count until `release` is called, then restarts it. */
  function hangingCheck() {
    let release = () => {}; const active = new Set(['run-1']);
    bridge.host.mockImplementation(async (method: string, input?: any) => {
      if (method === 'catalog.state') return { batches: [batch()], prompts: [] };
      if (method === 'catalog.query') return input?.statement === DOCUMENT_STATS_SQL ? new Promise(resolve => { release = () => resolve({ rows: [{ downloaded: 10 }] }); }) : { rows: [] };
      if (method === 'state') return { runs: [...active].map(id => run(id, id === 'run-1' ? 'retry_scheduled' : 'pending')) };
      if (method === 'cancel') { active.delete(input.id); return { run: {} }; }
      if (method === 'action') { active.add('new-run'); return { run: { id: 'new-run' } }; }
      return {};
    });
    return { release: () => release(), active };
  }
  const cancels = () => bridge.host.mock.calls.filter(([method]) => method === 'cancel').map(([, input]) => input.id);
  it('AC-065.6: Stop download pressed while a check restarts the download also stops the run that check started', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    const check = hangingCheck();
    workspace.model = modelWith({ ...run(), error: RECOVERY });
    view(<BulkDocuments running={false} onStarted={async () => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Restart automatically when paused' }));
    await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Stop download' }));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(cancels()).toEqual([]);                    // waiting for the check in flight
    check.release();
    await waitFor(() => expect(cancels()).toEqual(['run-1', 'run-1', 'new-run']));
    expect([...check.active]).toEqual([]);
    expect(await screen.findByText(/Download stopped\. Saved files are kept/)).toBeInTheDocument();
  });
  it('AC-065.6: the same for Stop in History', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    const check = hangingCheck();
    workspace.model = modelWith({ ...run(), error: RECOVERY });
    view(<><BulkDocuments running={false} onStarted={async () => {}} /><BatchHistory title="Download history" kind="download" links={false} batches={[batch()]} onChanged={async () => {}} onError={() => {}} /></>);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Restart automatically when paused' }));
    await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(cancels()).toEqual([]);
    check.release();
    await waitFor(() => expect(cancels()).toEqual(['run-1', 'run-1', 'new-run']));
    expect([...check.active]).toEqual([]);
  });
  it('AC-065.6: a Stop with no check in flight, or after a check that restarted nothing, stops only the run clicked', async () => {
    await open();
    workspace.model = modelWith(run('run-1', 'running'));
    view(<BulkDocuments running onStarted={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop download' }));
    await waitFor(() => expect(cancels()).toEqual(['run-1']));
    expect(bridge.host.mock.calls.filter(([method]) => method === 'action')).toEqual([]);
  });
  it('AC-065.6: Download all, History Retry, Download selected and a per-file retry each wait for a check in flight', async () => {
    const actions = () => bridge.host.mock.calls.filter(([method]) => method === 'action').map(([, input]) => input.actionId);
    const FILE = { id: 'doc-1', record_id: 'opportunity:1', name: 'Missing.pdf', status: 'failed', bytes: 0, chars: null, error: 'Download did not start.', title: 'Notice' };
    const controls: [string, React.ReactNode, () => Promise<HTMLElement>, string][] = [
      ['Download all', <BulkDocuments running={false} onStarted={async () => {}} />, () => screen.findByRole('button', { name: 'Download all' }), 'documents.download.all'],
      ['History Retry', <BatchHistory title="Download history" kind="download" links={false} batches={[batch('old', 'failed', 'The saved browser closed.')]} onChanged={async () => {}} onError={() => {}} />, () => screen.findByRole('button', { name: 'Retry' }), 'documents.download'],
      ['Download selected', <Documents />, async () => { fireEvent.click(await screen.findByRole('button', { name: 'Pick one' })); return screen.getByRole('button', { name: 'Download selected' }); }, 'documents.download'],
      ['per-file retry', <DocumentFiles onDetails={() => {}} downloadRunning={false} processingRunning={false} fileTransferControls />, async () => Array.from((await screen.findByText('Missing.pdf')).closest('article')!.querySelectorAll('button')).find(item => item.textContent === 'Retry')!, 'documents.download'],
    ];
    for (const [name, node, find, actionId] of controls) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await open();
      // Nothing is parked; the check simply has not come back yet.
      let release = () => {};
      bridge.host.mockReset();
      bridge.host.mockImplementation(async (method: string, input?: any) => {
        if (method === 'catalog.state') return { batches: [], prompts: [], fileTransferControls: true };
        if (method === 'catalog.query') return input?.statement === DOCUMENT_STATS_SQL ? new Promise(resolve => { release = () => resolve({ rows: [{ downloaded: 10 }] }); }) : { rows: String(input?.statement).includes('FROM documents d JOIN records r') ? [FILE] : [] };
        if (method === 'state') return { runs: [] };
        return { run: { id: 'started' } };
      });
      workspace.model = modelWith();
      autoResume.setAutoResume(true);
      const shown = view(node);
      const button = await find();
      await act(() => vi.advanceTimersByTimeAsync(CYCLE_MS));
      await waitFor(() => expect(button, name).toBeEnabled());
      fireEvent.click(button);
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(actions(), name).toEqual([]);            // held back by the check in flight
      release();
      await waitFor(() => expect(actions(), name).toEqual([actionId]));
      shown.unmount(); stop(); resetCapabilities(); vi.useRealTimers(); localStorage.clear();
    }
  });
  it('AC-065.5: the checkbox cannot be used before the host has answered', async () => {
    resetCapabilities(); stop = autoResume.startAutoResume();
    view(<BulkDocuments running={false} onStarted={async () => {}} />);
    const box = await screen.findByRole('checkbox', { name: 'Restart automatically when paused' });
    expect(box).toBeDisabled();
    await act(async () => { await loadCapabilities(async () => FULL); });
    expect(box).toBeEnabled();
    expect(box).toHaveAccessibleDescription('Works while this workspace is open in a browser tab.');
  });
  it('AC-066: in a frame that refuses Web Locks and storage the status line is this tab\'s own', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: { request: SECURITY } });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const put = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    try {
      await open();
      view(<BulkDocuments running={false} onStarted={async () => {}} />);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Restart automatically when paused' }));
      expect(await screen.findByText('Automatic restart is on. No automatic restart yet.')).toBeInTheDocument();
      expect(screen.queryByText(/Another tab of this browser/)).toBeNull();
    } finally { vi.unstubAllGlobals(); get.mockRestore(); put.mockRestore(); }
  });
});

it('AC-067: the README describes the option, its limits and what it never restarts', () => {
  const readme = readFileSync(join(process.cwd(), 'zoer/README.md'), 'utf8');
  for (const text of [
    '**Restart automatically when paused**', 'off until you turn it on', 'About every 30 seconds',
    'needs the Procurement workspace open in a browser tab', 'A browser may delay or suspend a background tab',
    'a closed tab or a sleeping computer restarts nothing', "Zoer's own retry after 30 minutes still applies then",
    'turns itself off after 3 restarts in a row that saved no new file', 'the count is catalog-wide',
    'never restarts a download that ended "Waiting for you", "Failed" or "Stopped"', 'an update pause', 'a start waiting for approval',
    '"Keep documents current" and selected-notice downloads',
    'if the workspace closes between the stop and the start, the download stays stopped until Retry in History',
    'can be followed by one automatic restart', 'two browsers with the option on can both start a resume in the same instant',
    'the automatic start waits for it',
  ]) expect(readme, text).toContain(text);
});
