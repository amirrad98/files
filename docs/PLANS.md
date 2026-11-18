# Plan: separate attachment download from text post-processing

Source of requirements: the user's request of 2026-11-16 ("stop OCR and other post-processing during
download, keep download and post-processing separate and asynchronous under Documents so
post-processing can run later, update the plugin and deploy it to
`https://zoer.k8s.overtheedgepaper.ca/#/plugins/bc-bid-monitor`"). There is no `docs/SPEC.md`; the
request is the specification.

Two repositories change:

- **Host**: `ahzs645/zoer`, checkout `../zoer-ote-attachment-transfer`, branch
  `feat/deferred-document-extraction` (from `fec3f15f`). Paths below starting with `backend/` are in
  that checkout.
- **Plugin**: this repository, branch `feat/native-database-setup`.

Revision 6 (2026-11-18: M4 added; later the same day M7; revision 5 was 2026-11-16): corrected after Plan Guardian findings PG-001 to PG-011 (see STATUS.md).

## Contract between host and plugin

| Item | Value |
|---|---|
| Pending marker | A saved file waiting for text has `documents.status='downloaded'`, `text IS NULL` and `error='Text extraction pending.'` |
| Deferral switch | Input `deferExtraction` (boolean) on `documents.download`, `documents.download.all`, `documents.download.missing`. When the input omits it, the host uses the `default` the plugin manifest declares for that property on the action being run; with no declared default it is `false`. The plugin manifest declares `"default": true` on all three actions, so manual, scheduled, resumed and automatically recovered runs all defer without any caller passing the flag. |
| Post-processing action | `documents.extract.pending`, host handler `documents.extract.pending.v1`, input `{ limit?: 1..3000 }` (notices per run, default 500), output `{ selected, files, completed, failed, remaining }` (`selected` notices chosen, `files` pending files in them at start, `completed`/`failed` notices, `remaining` pending files in the whole catalog afterwards) |
| Extraction batch | A `batches` row of kind `download` whose `input` JSON has `extractOnly: true`. A pending run additionally has `pendingOnly: true` and its `recordIds`. Existing per-file **Re-extract** runs (`documents.extract`) have `extractOnly: true` without `pendingOnly`. |
| Dispatcher lock | The host's workflow dispatcher gives text extraction of saved files (`documents.extract.pending.v1`, `documents.extract.v1`: host actions requiring only `artifact-store`) the single lock `action:<plugin>:documents.extract`. It therefore overlaps downloads and scrapes, while two extractions of one plugin run one after the other. |
| Version archive | The write-once document version archive (`archiveDocumentVersion`) never stores a pending file. A deferred file's version is archived when its text extraction finishes (with the extracted text, or with the extraction error when it fails). |
| Capability flag | `GET …/workspace/catalog` returns `deferredExtraction: true` |

## Requirements

| ID | Requirement | Mandatory |
|---|---|---:|
| REQ-001 | A deferring download saves the original file without running text extraction, marks it pending and reports the file task as succeeded. | yes |
| REQ-002 | A deferring download that is cancelled, or whose later file fails, keeps every file already transferred. | yes |
| REQ-003 | A download that does not defer extracts text inline exactly as before. | yes |
| REQ-004 | `documents.extract.pending` extracts text only for pending files, needs no browser, clears the pending marker, and leaves a file saved with a warning when its extraction fails. | yes |
| REQ-005 | `documents.extract.pending` is bounded by `limit`, reports how many files remain, and succeeds with zero work when nothing is pending. | yes |
| REQ-006 | `documents.download.missing` accepts `deferExtraction` and applies the same deferral switch; an invalid value is rejected. | yes |
| REQ-007 | The host advertises `deferredExtraction: true` in the catalog overview. | yes |
| REQ-008 | Every download run of this plugin defers extraction: manual, scheduled ("Keep documents current" and scheduled "Download all"), resumed (`resumeRunId`) and automatically recovered runs. An explicit `deferExtraction: false` extracts inline. | yes |
| REQ-009 | Documents has a separate **Processing** tab showing how many files wait for text, a control that starts `documents.extract.pending`, the running extraction's progress, and the history of extraction runs. | yes |
| REQ-010 | Download progress and Download history show download batches only; extraction batches (pending runs and per-file Re-extract runs) appear only under Processing. | yes |
| REQ-011 | Download and text extraction are asynchronous: an extraction run and a download run execute at the same time on the host in either start order, and the plugin never disables one because the other is running. | yes |
| REQ-012 | Files waiting for text are shown as "Text pending", never as "No text" or as a warning, wherever the plugin counts or lists files without text. | yes |
| REQ-013 | The plugin manifest declares the deferral default and the new action, the version is 0.41.0 (at its release; 0.41.1 since REQ-018 / AC-048, on the user's 2026-11-18 deployment request), and the README describes the behaviour. | yes |
| REQ-014 | The host build with REQ-001–007, 015, 016 and plugin 0.41.0 are active on the OTE deployment, and the live catalog reports `deferredExtraction: true`. | yes |
| REQ-015 | Host consumers of document text never treat a pending file as unreadable: an AI review that includes documents (`records.review*`), the evidence pipeline's document stage (`procurement.pipeline*`) and evidence analysis (`records.evidence*`, handlers `procurement.evidence.v1` / `.cli.v1`) first extract that notice's pending files, and the retained version of a deferred file carries its extracted text. | yes |
| REQ-016 | An extraction run that is cancelled or fails keeps the text already extracted and leaves the rest pending; **Retry** on a pending run starts `documents.extract.pending` again, **Retry** on a Re-extract run repeats `documents.extract` for its notices, and **Stop** cancels a running extraction. | yes |
| REQ-017 | A download that Zoer has parked for a scheduled automatic retry is shown as waiting to retry, can be stopped from the Download section and from History, and after its run has ended a new download can start and the batch can be retried. | yes |
| REQ-018 | The M4 fix is released as plugin version 0.41.1, is active on the OTE deployment, and is sent as a pull request. | yes |
| REQ-020 | When the user turns it on, the plugin itself detects a download that has paused for the host's automatic retry, stops it and starts it again within about 30 seconds, without waiting 30 minutes and without the user doing it by hand. Bounds: it runs while the Procurement workspace is open in a browser tab, and it turns itself off after 3 restarts in a row that saved no file. | yes |

Failure and edge cases covered by the criteria: cancellation mid-batch (AC-002, AC-021), a later
file failing (AC-002b), extraction error (AC-005, AC-023), nothing pending (AC-007), invalid input
(AC-007, AC-008), a host without the capability (AC-013), a file replaced while its text is being
extracted (AC-006), concurrent runs (AC-020a/b).

Not applicable to this change: authentication and authorization (unchanged host action approval and
`workspace:catalog` checks are reused), database migrations (no schema change), Persian/RTL, OCR model
versioning, training jobs.

### Plugin surfaces that read document text

Changed (REQ-012):

- `DocumentInventory.tsx`: statistics tile, Files filters and chip; a pending row shows the
  "Text pending" chip and no warning line (the stored marker is not rendered as a warning).
- `review-workspace/home-data.ts` (`noText` file count), `review-workspace/queue.ts`
  (`acquireParts().noText`), `procurement/Sources.tsx` (`noText` per source): exclude pending files.
- `review-workspace/opportunity-queries.ts` (`EVIDENCE_COUNTS_SQL`, `evidenceScopeOf`, shown by
  `OpportunityColumns.tsx`): a notice whose downloaded files have no usable text and at least one is
  pending reads "Saved; text pending"; otherwise the usable-count line gains
  " · N text pending" when N > 0. "Saved; no usable text extracted" is used only when nothing is
  pending.
- `review-workspace/PipelineWorkbench.tsx` (`readScope` and the preflight's excluded list): a pending
  file is listed as "<name>: Text pending; extracted when this stage runs", never as
  "Saved; no usable text extracted".
- `procurement/ai.ts` (`documentCounts`, `documentSummary`, new `textState`, `noTextMessage`,
  `askScopeText`): `DocumentCounts` gains `pending`; `savedWithoutText` excludes pending files; the
  summary appends "; N text pending" when N > 0.
- `procurement/NoticeView.tsx`: the per-file detail (line 267) reads "· Text pending" for a pending
  file; the text preview (line 322) reads "Text pending. Documents → Processing extracts this
  file's text; an AI review of this notice extracts it first."; the Ask-AI card (lines 338/360)
  counts pending files apart from text-less ones and says "N saved file(s) waiting for text are
  extracted first."
- `review-workspace/selection.ts` and `OpportunityColumns.tsx` (batch preflight): the preflight reads
  each notice's pending file count; the Evidence scope line appends
  " · N file(s) text pending, extracted when the run starts" when N > 0, and the estimated-calls
  note says the estimate excludes them.
- `OpportunityColumns.tsx` line 38 ("x of y files readable") appends " · N text pending";
  `procurement/Status.tsx` line 139 describes Download history as "Attachment downloads".

Intentionally unchanged, with the reason:

- `procurement/NoticeView.tsx` line 164 (`item.status === 'unreadable'`): reads frozen extraction
  versions written by the pipeline, which REQ-015 keeps free of pending files.
- `procurement/ai.ts` `coverageText` (lines 136–156) and `procurement/EvidencePanel.tsx`: render
  the coverage object a host review or evidence run produced; REQ-015 (AC-022, AC-033) makes those
  runs extract pending files first, so that coverage has no pending file.
- `review-workspace/Home.tsx` line 145 ("Files readable by AI" of all files): the ratio is correct
  as stated (a pending file is not yet readable); the pending count itself is on Documents.
- `review-workspace/today-data.ts`, `procurement/lifecycle.ts`,
  `procurement/browser-source-overview.ts`, `procurement/source-errors.ts`: their "unreadable" refers
  to dates, robots.txt or connector state, not document text.
- `NoticeFiles.tsx`, `procurement/Status.tsx` and the other download call sites: they start
  downloads without a flag and rely on the manifest default (REQ-008).

## Milestones

### M1 — Host: save first, extract later

Depends on: nothing. Scope: REQ-001–REQ-008 (host half), REQ-011 (host half), REQ-015, REQ-016
(host half).

Deliverables: `backend/src/plugins/plugin-document-pending.ts` (marker),
`backend/src/plugins/plugin-document-extraction.ts` (deferral switch, pending handler,
`extractPendingText` helper), changes in `backend/src/plugins/plugin-research.ts`,
`plugin-download-missing.ts`, `plugin-catalog.ts`, `plugin-document-versions.ts`,
`backend/src/procurement/pipeline.ts`, `backend/src/procurement-evidence.ts`,
`backend/src/workflows/workflow-dispatcher.ts` (lock rule), handler registration, tests in `backend/src/__tests__/plugin-deferred-extraction.test.ts`, CHANGELOG entry.

Acceptance criteria (each verified by a test of the same AC number in
`plugin-deferred-extraction.test.ts` unless noted):

- AC-001 (REQ-001): a download with `deferExtraction: true` never calls the extractor; the row has
  `status='downloaded'`, saved content, `text IS NULL`, `error='Text extraction pending.'`; its task is
  `succeeded` with phase `Saved; text extraction pending`.
- AC-002 (REQ-002): aborting during the second file of a deferring batch leaves the first file saved
  and pending.
- AC-002b (REQ-002): when the second file's download throws, the first file stays saved and pending
  and the second is recorded as failed.
- AC-003 (REQ-003): the existing download tests in `plugin-research-coverage.test.ts` pass unchanged,
  and a download with no flag and no manifest default calls the extractor and stores its text.
- AC-004 (REQ-004): the pending handler runs with no browser resource, calls the extractor only for
  pending files (not for files that already have text), stores the text and clears the marker.
- AC-005 (REQ-004): when the extractor throws, the file stays `downloaded` with its content, the
  marker is replaced by the error text, and the result still reports the remaining count.
- AC-006 (REQ-004): text extracted from bytes that were replaced during extraction is not written
  (the update is conditional on the file's SHA-256).
- AC-007 (REQ-005): with `limit: 1` and two notices pending, one notice is processed and
  `remaining` counts the other's files; with nothing pending the result is
  `{selected:0, files:0, completed:0, failed:0, remaining:0}` and no batch row is written;
  `limit: 0`, `limit: 3001` and a non-integer are rejected.
- AC-008 (REQ-006): `documents.download.missing` with `deferExtraction: true` saves files pending
  without calling the extractor; `deferExtraction: "yes"` is rejected.
- AC-009 (REQ-007): `PluginCatalog.overview().deferredExtraction === true`.
- AC-010 (REQ-004): the handler is registered as `documents.extract.pending.v1` and requires only
  `artifact-store`.
- AC-019 (REQ-008): with an action whose input schema declares
  `deferExtraction: { default: true }`, a download with no flag in its input defers, for both
  `documents.download.v1` (including a run resumed with `resumeRunId`) and
  `documents.download.missing.v1` (the scheduled form `{}`, including the files saved after its
  in-run automatic browser restart); explicit `deferExtraction: false` extracts inline, tested for
  both handlers. Deferral is decided once per run from the input and the action, so a retried
  attempt of the same run (automatic BC Bid recovery) decides identically.
- AC-020a (REQ-011): while a deferring download is blocked inside its transfer, a
  `documents.extract.pending` run started afterwards completes and stores text; the download then
  finishes and its new file is pending.
- AC-020b (REQ-011): while an extraction run is blocked inside its extractor, a download started
  afterwards completes and saves its file; the extraction then finishes and stores its text.
- AC-038 (REQ-011; `backend/src/__tests__/workflow-dispatcher.test.ts`, tests "text extraction of
  saved files runs while a download is running, but not beside another extraction" and "a download
  starts while text extraction is running; a second extraction and a re-extract wait for it"):
  through the real `WorkflowDispatcher` with the manifest shapes of the download and extraction
  actions, in both start orders the second step reaches `succeeded` while the first is still
  `running`; a second pending run and a Re-extract run stay `pending` until the running extraction
  ends. (AC-020a/b prove the handlers themselves tolerate overlap; AC-038 proves the host schedules
  it.)
- AC-039 (REQ-004, REQ-005; `plugin-deferred-extraction.test.ts`): a pending run does not overwrite
  text another reader stored for the same file meanwhile; pending counts and runs cover only notices
  that still exist; a pending file whose saved original is missing becomes a failed extraction for
  readers of the notice; a resumed `documents.download.v1` batch keeps the deferral its first run
  decided (`documents.download.missing.v1` decides again from its input or the manifest default on
  every run, as the contract states).
- AC-021 (REQ-016): aborting a pending run during its second file keeps the first file's text,
  leaves the second pending, and a later pending run extracts only the second.
- AC-022 (REQ-015): an AI review with `includeDocuments` of a notice that has a pending file calls
  the extractor for it first, passes its text to the model, and reports it neither as `unreadable`
  nor in `extractionWarnings`.
- AC-023 (REQ-015): driving `runProcurementPipeline` (stage `extract`, injected catalog, model and
  extractor dependencies) on a notice with a pending file: the extractor is called for that file
  before the bundle is prepared, the model call receives the file's text, and the bundle coverage
  does not list the file as missing; when the injected extractor throws, the run still completes,
  the file is reported as "Downloaded, but no usable text was extracted", and its marker is replaced
  by the error text. The triage stage (notice only) does not call the extractor.
- AC-033 (REQ-015): driving `runProcurementEvidence` (injected catalog, plugin lookup, extractor and
  model) on a notice with a pending file: the extractor is called for it, its text is among the
  sources sent to the model, and the saved coverage does not list it under `unreadable`.
- AC-034 (REQ-015): after a deferring download the version archive has no entry for the file; after
  `documents.extract.pending`, `retainedDocumentVersion(id, sha256)` returns the extracted text and
  an `error` that is not the pending marker; when extraction fails the retained version carries the
  extraction error and empty text.
- AC-028 (REQ-001): a deferring forced re-download (`force: true`) of a file that already has text
  saves the new bytes, clears the old text and marks the file pending.
- AC-029 (REQ-016): running the pending handler again after an interrupted run (the path a
  maintenance pause or restart takes) processes only the files still pending and does not call the
  extractor for files the interrupted run finished.

Validation commands (in `../zoer-ote-attachment-transfer/backend`):

```sh
bun test --isolate src/__tests__/plugin-deferred-extraction.test.ts src/__tests__/plugin-research-coverage.test.ts src/__tests__/plugin-download-missing.test.ts src/__tests__/plugin-catalog.test.ts src/__tests__/bcbid-batch-recovery.test.ts src/__tests__/procurement-pipeline.test.ts src/__tests__/procurement-evidence-request.test.ts src/__tests__/procurement-evidence-storage.test.ts src/__tests__/workflow-dispatcher.test.ts
bun run typecheck
```

### M2 — Plugin: Processing tab and pending state

Depends on: the contract above (not on M1's code). Scope: REQ-008 (manifest half), REQ-009,
REQ-010, REQ-011 (plugin half), REQ-012, REQ-013, REQ-016 (plugin half).

Deliverables: `zoer/dashboard/document-processing.ts` (pure helpers and SQL),
`zoer/dashboard/DocumentProcessing.tsx` (Processing tab), changes in `Documents.tsx`,
`DocumentInventory.tsx`, `BatchProgress.tsx`, `BatchHistory.tsx`,
`review-workspace/home-data.ts`, `review-workspace/queue.ts`, `procurement/Sources.tsx`,
`review-workspace/opportunity-queries.ts`, `review-workspace/PipelineWorkbench.tsx`,
`review-workspace/selection.ts`, `review-workspace/OpportunityColumns.tsx`, `procurement/ai.ts`,
`procurement/NoticeView.tsx`, `procurement/NoText.tsx`, `procurement/Status.tsx`, `review-workspace/nav.ts`, `zoer/manifest.json`, `zoer/README.md`; tests in
`tests/zoer-document-processing.test.tsx` (vitest, jsdom) and
`zoer/dashboard/document-processing.test.ts` (bun:sqlite with the host's catalog reader) and
additions to `zoer/dashboard/review-workspace/opportunity-queries.test.ts`. Component tests resolve
`@tanstack/react-query` and `@zoer/plugin-ui/database` (supplied by the host at build time) to the
stand-ins `tests/fixtures/react-query.tsx` and `tests/fixtures/plugin-ui-database.tsx` through
`vitest.config.ts`, as `@zoer/plugin-ui/controls` already is.

Acceptance criteria:

- AC-011 (REQ-008, REQ-013; `tests/zoer-document-processing.test.tsx`): the manifest's
  `documents.download`, `documents.download.all` and `documents.download.missing` input schemas each
  declare `deferExtraction` as a boolean with `default: true`.
- AC-012 (REQ-009, REQ-010; same file): `splitDocumentBatches` puts batches whose input has
  `extractOnly: true` under `processing` and all other download batches under `downloads`, ignores
  review batches, and treats unparsable input as a download.
- AC-013 (REQ-009; same file): `SECTION_VIEWS.documents` in `review-workspace/nav.ts` lists
  Download, Processing, Files, History in that order; the Processing tab renders the pending count,
  starts `documents.extract.pending` through the host when its button is pressed and shows the
  running extraction batch's progress; when the catalog state lacks `deferredExtraction` the tab
  shows "This Zoer host extracts text during download." and no start button.
- AC-014 (REQ-011; same file): with a download batch running, the Processing start button is
  enabled; with an extraction batch running, the `running` value given to the download controls is
  false; in the Files list a running download disables only **Retry** and a running extraction
  disables only **Re-extract**.
- AC-015 (REQ-012; `zoer/dashboard/document-processing.test.ts`, real SQLite through the host's
  `validateCatalogSelect`/`runCatalogSelect`): `DOCUMENT_STATS_SQL` counts pending files separately
  and excludes them from "No text"; the Files filters `pending`, `unreadable` and `warnings` are
  pairwise disjoint for a pending file; `NO_TEXT_SQL` (used by Home, the Acquire queue and Sources)
  excludes a pending file; `fileState` returns `Text pending` for a pending row;
  `EVIDENCE_COUNTS_SQL` returns the notice's pending count.
- AC-016 (REQ-013; `tests/zoer-document-processing.test.tsx`): the manifest declares the
  `documents.extract.pending` action with handler `documents.extract.pending.v1`, capability
  `artifact-store` only, the `limit` input and the five-field output schema; version is `0.41.0` (at its release; superseded by AC-048: `0.41.1`, which this
  criterion's test now asserts);
  the README states (a) downloads save files without extracting text, (b) Documents → Processing
  extracts text later and can run during a download, (c) files show "Text pending" until then,
  (d) an AI review, evidence analysis or pipeline run extracts a notice's pending files first, so
  its preflight estimate is a lower bound.
- AC-024 (REQ-016; `tests/zoer-document-processing.test.tsx`): `processingRetry` returns
  `documents.extract.pending` with empty input for a batch whose input has `pendingOnly: true`, and
  `documents.extract` with the batch's `recordIds` otherwise; Processing history shows **Stop** for
  a running extraction batch and it calls the host's `cancel` with the batch id.
- AC-025 (REQ-012; `tests/zoer-document-processing.test.tsx`): source scan — `home-data.ts`,
  `queue.ts` and `procurement/Sources.tsx` build their no-text conditions from `NO_TEXT_SQL`, and no
  file under `zoer/dashboard` other than `document-processing.ts` contains the literal
  `coalesce(length(d.text),0)=0` or `coalesce(length(text),0)=0`.

- AC-030 (REQ-012; `tests/zoer-document-processing.test.tsx`): the Files list renders a pending
  row with the "Text pending" chip and no element of class `research-file-warning`, and renders the
  warning for a row with any other error.
- AC-031 (REQ-012; `zoer/dashboard/review-workspace/opportunity-queries.test.ts`):
  `evidenceScopeOf` returns detail "Saved; text pending" for `{downloaded:2, usable:0, pending:1}`,
  "1 of 3 downloaded files with usable text · 2 text pending" for
  `{downloaded:3, usable:1, pending:2}`, and "Saved; no usable text extracted" for
  `{downloaded:1, usable:0, pending:0}`.
- AC-032 (REQ-012; `tests/zoer-document-processing.test.tsx`): `workbenchExclusions` lists a pending
  file as "<name>: Text pending; extracted when this stage runs", a text-less non-pending file as
  "<name>: Saved; no usable text extracted", and a failed file as "<name>: download failed".
- AC-035 (REQ-012; `tests/zoer-document-processing.test.tsx`): `documentCounts` returns
  `{downloaded:3, usable:1, pending:1, savedWithoutText:1}` for one readable, one pending and one
  text-less file, and `documentSummary` of it ends "; 1 contains usable text; 1 text pending";
  `textState` returns `pending`, `none` and `readable` for the three; `noTextMessage` starts
  "Text pending." for the pending file and "Saved; no usable text extracted." for the text-less one;
  `askScopeText({readable:1, textless:1, pending:2})` contains "2 saved files waiting for text are
  extracted first." and "1 saved file has no usable text and is not read."
- AC-036 (REQ-012; `tests/zoer-document-processing.test.tsx` and
  `zoer/dashboard/document-processing.test.ts`): `PREFLIGHT_PENDING_SQL` returns each notice's
  pending file count from a real SQLite fixture; `preflightScopeText` for a summary with
  `pendingDocs: 3` ends " · 3 files text pending, extracted when the run starts" and has no such
  suffix for `pendingDocs: 0`.
- AC-037 (REQ-012; `tests/zoer-document-processing.test.tsx`): the notice view's text preview for a
  saved file without text is the `NoText` component (`procurement/NoText.tsx`, rendered by
  `NoticeView.tsx`'s `TextPreview`, asserted by a source check); rendering it for a pending file
  shows "Text pending." and not "no usable text", and for a text-less file shows
  "Saved; no usable text extracted.".

Validation commands (repository root):

```sh
export ZOER_UI_ROOT="$PWD/../zoer-ote-attachment-transfer" ZOER_SOURCE_ROOT="$PWD/../zoer-ote-attachment-transfer"
npm run zoer:typecheck
npm run zoer:test
npm run zoer:test:catalog
npm run zoer:build
```

The two variables point the plugin's host-contract tests and build at the M1 checkout instead of
the default sibling `../zoer`, which is on a different commit.

### M3 — Deployment to OTE

Depends on: M1 and M2 complete. Scope: REQ-014.

Acceptance criteria (manual procedure; the deployment cannot be exercised by repository tests):

- AC-017: `GET https://zoer.k8s.overtheedgepaper.ca/api/health` reports the M1 host commit
  (the endpoint returns `build.commit`; confirmed 2026-11-16, currently `4f7eb40a…`).
- AC-018: `GET …/api/extensions/bc-bid-monitor` reports version `0.41.0`, status `active`.
- AC-026: `GET …/api/extensions/bc-bid-monitor/workspace/catalog` reports
  `deferredExtraction: true`.
- AC-027: the Documents page at the URL in the request shows the Processing tab, and the plugin's
  `documents.extract.pending` action is accepted by the host (its action plan resolves).

Procedure: record the previous backend image and plugin package, back up the catalog, roll out the
backend with the maintenance drain, stage and activate the plugin package, then run the four checks.
Rollback is the recorded previous image and previous package. The M3 readiness gate also settles
whether the changed input schemas or the new action require plugin or schedule re-approval on the
host, and whether `zoer/host-source.json` moves to the M1 commit. The backend rollout is a production
change on a shared cluster and needs the user's explicit go-ahead at the M3 readiness gate.

### M4 — Plugin: stop a download that waits for its automatic retry

Source: user report 2026-11-18 ("I can't stop or force to start a new session for downloading
again"), observed on OTE: run `workflow_run_eb879f69…` (`documents.download.all`) was
`retry_scheduled` with "Download stopped. Automatic browser recovery is scheduled for
2026-11-18T08:18:40.419Z", its batch was `paused` at 203/492, the Download section showed a
disabled "Download running…" button and no page offered Stop.

Depends on: M2. Scope: REQ-017. Plugin dashboard only; no host change and no manifest change.
Release, deployment and the pull request are M5.

Cause: the host writes batch status `paused` both for an update pause and for the 30-minute BC Bid
browser-recovery wait (`plugin-research.ts`, `BcBidRecoveryScheduled`), and its batch reconciliation
(`routes/plugin-catalog.ts`) only corrects `running` batches. The dashboard treated every `paused`
batch as an update pause (no Stop, no Retry) while `documentDownloadActive` blocked new downloads
for the non-terminal run. The host already cancels such a run at once (`cancelRun` settles a
non-running step and sets the run `cancelled`).

Acceptance criteria:

- AC-040: `batchPause` (`document-run.ts`) returns no pause for a batch that is not `paused`;
  `retry` with the retry time for an active run that is `retry_scheduled` or whose message names a
  scheduled retry (the run's `resumable.nextStepAt` wins over both messages); `update` for another
  active run; `ended` when the run list holds the batch's run in a terminal status, or lacks it
  while holding a run created after the batch was last written. Without a loaded run list it
  decides from the batch message alone and never returns `ended`. `activeDocumentDownload` returns
  the non-terminal download run with `waiting` true only for `retry_scheduled`. `retryTimeText` is
  empty for an unknown, unreadable or past time. The model exposes every returned run as
  `workflowRuns`.
- AC-041: in Download history a batch waiting for its retry reads "Waiting to retry", states
  "Nothing is downloading" ("Nothing is running" for a batch that downloads nothing) and, while it
  is still ahead, when Zoer retries; it offers Stop and no Retry; Stop calls `cancel` with the
  batch id and reloads the run state.
- AC-042: in Download history a `paused` batch whose run has ended reads "Stopped", does not show
  the outdated scheduled-recovery message, and offers Retry, which resumes the batch
  (`resumeRunId`). An update pause still reads "Paused for update" with neither Stop nor Retry. A
  `running` batch still offers Stop and a failed batch Retry.
- AC-043: the Download section shows "Stop download" when the dashboard's run list holds an active
  download run, or the batch list holds a download batch that is `running` or `paused` and not
  ended by AC-040; clicking it calls `cancel` with that id, reloads the batch list and the run
  state and reports that the download stopped. While a new download is blocked and the run waits
  for its retry the start button reads "Download paused…"; a status line gives the retry time;
  while it transfers the button reads "Download running…". A refused stop shows the host's error
  and leaves "Stop download" usable.
- AC-044: once the run has ended, "Download all" is enabled and "Stop download" is not shown.
- AC-045: `zoer/README.md` describes the paused state, "Waiting to retry" and where to stop it.
- AC-046 (audit 7, PG-M4-01): the dashboard's run list is polled less often than the batch list. A
  `paused` batch whose run is missing from a run list that is not newer than the batch (empty, only
  runs created at or before the batch's `updated_at`, unreadable times) is never `ended`: with the
  recovery message it reads "Waiting to retry" with Stop and no Retry, and an update-paused
  download, extraction or review batch reads "Paused for update" without Retry.
  `activeDownloadBatch` gives the Download section the `running` or not-ended `paused` download
  batch, so "Stop download" and the paused status line show before the run list knows the run.
- AC-047 (audit 7, PG-M4-01): a download started from the dashboard reloads the run list at once:
  History Retry, Download selected and a per-file download retry call `refreshAfterChange`, which
  waits for a refresh already in flight and then reads the state again; Stop in History and
  "Stop download" use it too.

Edge cases covered by the criteria: run list not yet loaded; run list older than the batch (AC-046);
run older than the returned history (ended once any later run exists, because the host always
returns active runs); stop refused by the host; update pause unchanged; retry time already passed.
Known limit: a `paused` batch whose run has left the returned history keeps its paused reading
until the workspace has any run created after the batch's last write. Not covered by repository
tests: the live host's cancel of a `retry_scheduled` run (host behaviour, read in
`durable-workflows.ts` `cancelRun`); the live occurrence ended by itself at 08:18:44Z before a
stop could be tried. Stop controls ignore a second activation while one is in flight (`pending`
ref, `busy`); this has no criterion of its own.

Validation commands (repository root): `npm run zoer:typecheck`, `npm run zoer:test`,
`npm run zoer:test:catalog`, `npm run zoer:build`.

### M5 — Release 0.41.1, deployment to OTE and pull request

Source: user request 2026-11-18, after M4: "commit it and deploy it here
"https://zoer.k8s.overtheedgepaper.ca/" and send a pr". Depends on: M4 complete and committed.
Scope: REQ-018.

What ships: the plugin package built from the M4 commit of `feat/native-database-setup`. Compared
with the live 0.41.0 package (built from `ddb1e37`) it carries the M4 dashboard change and the
upstream commits `61dd5fb` (catalog reads one at a time; bounded Home and Status document checks;
nine dashboard files including `bridge.ts`) and `72fb23b` (a test-only time-rule guard), which
arrived with merge `35f65fa`. Worker sources (`zoer/src`) and the manifest apart from its version
are unchanged since the live package. The package bundles its own UI, built against the same host
checkout as the live package (`../zoer-ote-attachment-transfer`, `1a84ff7a`); the live host reports
a newer commit, which the deployment record notes.

Acceptance criteria:

- AC-048: `zoer/manifest.json` reports version `0.41.1` and differs from the 0.41.0 manifest in
  nothing else (`git diff` of the file is the version line). The host refuses a candidate whose
  version equals the installed one, so the user's deployment request changes the version named by
  the previously approved AC-016 (REQ-013); AC-016's test asserts 0.41.1 and keeps every other
  assertion.
- AC-049 (deployment, manual; cannot be exercised by repository tests):
  1. the package is staged on OTE and its upgrade plan is from 0.41.0 to 0.41.1 with no blockers
     and no added permissions, network hosts or capabilities;
  2. the upgrade is applied only when
     `GET …/api/extensions/bc-bid-monitor/workspace/state?summary=1` lists no run outside
     `succeeded`, `failed`, `cancelled`, `outcome_unknown`. As first planned no run was to be
     cancelled to make room; the user then decided otherwise for the blocking award history run
     (2026-11-18: "if it's not progressing you can stop it and deploy the new version", and, told
     that it was progressing and that a scheduled download was due, "Stop and deploy"). Any run
     stopped for the upgrade is named in the deployment record with what it had saved;
  3. afterwards `GET https://zoer.k8s.overtheedgepaper.ca/api/extensions/bc-bid-monitor` reports
     version `0.41.1`, status `active`, enabled, and the schedules are as before;
  4. the live Documents page shows the Download section, and Home and Status load without an error
     (they carry `61dd5fb`);
  5. the deployment record in STATUS.md names the package digest, the plugin commit, the live host
     commit and the retained 0.41.0 package record.
  Rollback: the host's package rollback to the retained 0.41.0 record (`dist/procurement-0.41.0.zip`
  is also kept locally).
- AC-050 (pull request): a pull request from `feat/native-database-setup` to `main` of
  `amirrad98/files` (the repository and direction of the 0.41.0 pull request, number 1) is open and
  contains the M4 commit and the deployment record.

Order: commit M4 with version 0.41.1, build and pack from the clean commit, stage, read the plan,
upgrade when idle, enable, run the checks, record them, commit the record, push, open the pull
request.

### M7 — Plugin: restart a paused download automatically

Source: user, 2026-11-18, after M5: "The plugin works but I have to run it manually, it's not
automatically, detect and run after a pause", and, told that the host already retries once after
30 minutes and that every pause is BC Bid's browser check: "I don't want it to be 30 minutes after
pause, I want that automation plug in to check and if the download has paused stop it and then
start it again". Depends on: M4 (Stop of a parked run, `batchPause`, `refreshAfterChange`).
Scope: REQ-020. Plugin dashboard only; no host, worker or manifest change. Tests:
`tests/zoer-download-autoresume.test.tsx`.

Where it can run. The plugin worker can only save, capture, read and list (it cannot stop or start
a run), schedules fire at whole hours at the least, and `documents.download.all` is a host action.
The one place inside the plugin that can stop and start a run is the dashboard, so the automation
runs while the Procurement workspace is open in a browser tab. Restarts with no tab open need a
host change; that is an open item for the user's decision (STATUS.md), not a closed question.

Observed on OTE before this milestone (2026-11-18, 10:05Z to 15:34Z): the parked download was
stopped and resumed 31 times from outside the plugin; each resume saved about 3 to 5 files before
BC Bid asked for its browser check again ("Manual browser verification required"). That is also the
only live evidence that cancel-then-resume works on the host; repository tests do not cover it.

Bounds the user did not state and must be told when M7 is reported: it runs only while the
workspace is open; it is off until turned on; it turns itself off after 3 restarts in a row that
saved no file.

Identifiers: M6, REQ-019 and AC-051 to AC-054 belong to work another session has in this checkout
(repeating failed catalog reads); this milestone starts at AC-060 to stay clear of it.

Definitions.

- A *parked download* is a run with action `documents.download.all` and status `retry_scheduled`
  whose batch (the catalog batch whose id is the run id) has status `paused` and is classified
  `retry` by `batchPause` from its scheduled-recovery message. Nothing else is ever stopped: not a
  `documents.download` or `documents.download.missing` run in any status, and not a
  `retry_scheduled` run whose batch is not `paused` (the host uses that status too while a plugin
  upgrade interrupts a download).
- A *cycle* is one pass of `resumeParkedDownload` (`download-autoresume.ts`). It reads, in this
  order, the batch list (`catalog.state`), the catalog-wide number of saved files (`downloaded` of
  `DOCUMENT_STATS_SQL`) and last the run list (`state`), so that the run list is the newest reading
  when it acts.
- The *resume request* is action `documents.download.all`, whatever the number of notices, with
  input `{ recordIds: <the batch's>, force: false, resumeRunId: <the batch id> }`. (`researchRetry`
  is not used: it picks `documents.download` for 50 notices or fewer, which the host never parks.)

Acceptance criteria:

- AC-060 (nothing to do): with no parked download the cycle calls neither `cancel` nor `action`
  and reports `idle`. This covers: no active download run; a transferring, queued,
  approval-waiting or update-waiting `documents.download.all` run; a `retry_scheduled`
  `documents.download.all` run whose batch is `running`, `stopped`, missing from the batch list, or
  `paused` without the scheduled-recovery message;
  and a `retry_scheduled` `documents.download.missing` or `documents.download` run.
- AC-061 (restart): with exactly one parked download and no other active download run (of any of
  the three download actions) the cycle calls `cancel` with the parked run's id, reads the run
  list again, and, if no download run is active then, calls `action` with the resume request. It
  reports `restarted` with the new run's id. The request is `documents.download.all` both for a
  batch of 50 notices or fewer and for a larger one.
- AC-062 (other download runs): if another download run is active beside the parked one, in either
  order in the run list, the cycle stops and starts nothing and reports `skipped`. If, after its
  own `cancel`, the second run-list reading shows an active download run (another browser or
  person restarted it first), it starts nothing and reports `skipped`.
- AC-063 (failures):
  1. A failed read of the batch list, the saved-file count or the run list makes the cycle a
     no-op: neither `cancel` nor `action`, outcome `unreadable` with the error. An unreadable
     count is never counted as progress or as lack of it. The watcher stays on.
  2. A refused `cancel` starts nothing; outcome `cancel_refused` with the error. The watcher stays
     on and the next cycle tries again.
  3. A failed second run-list reading after the cancel starts nothing; outcome `start_refused`.
  4. A refused `action` after the cancel: outcome `start_refused` with the error. For 3 and 4 the
     watcher turns itself off, so a refused start is never repeated in a loop, and its message says
     the download is stopped and that Retry in History resumes it.
- AC-064 (no-progress guard): the watcher keeps, in memory for the page load, the saved-file count
  at its last restart and the number of restarts in a row that were followed by a parked download
  with no higher count. When that number reaches 3 the cycle stops and starts nothing (the
  download stays parked, so the host's own retry still applies), reports `stalled`, and the
  watcher turns itself off with a message that BC Bid's browser check needs a person. A restart
  after which the count rose resets the number. Turning the option on again starts from zero. The
  count is catalog-wide: a file saved by any download counts as progress, and notices that advance
  without a saved file do not.
- AC-065 (watcher):
  1. Off by default. Turned on, it runs a cycle every 30 seconds; a cycle is not skipped because
     the tab is hidden; two cycles never overlap; it stops when turned off and when the workspace
     closes.
  2. It is started by the workspace (`startWorkspace`), so it runs on every Procurement page, not
     only on Documents.
  3. The choice is kept per browser in `localStorage`; a browser that refuses storage keeps it for
     the page only. Turning itself off (AC-063, AC-064) writes the stored choice off, and other
     tabs of that browser follow a stored change (`storage` event) and re-read the stored choice
     before each cycle.
  4. Where the browser has Web Locks and allows them (a sandboxed frame has the interface but is
     refused; such a tab checks by itself), one tab holds the lock for as long as its option is on and
     only that tab runs cycles; another tab whose option is on takes over when the holder closes or,
     in a browser that refuses storage, when the holder turns its own option off.
  5. On a read-only host (`collection` false) it cannot be turned on and never runs; no cycle
     runs before the host has answered what it allows.
  6. A cycle and a manual download control in the same tab do not interleave: Download all,
     Stop download, History Stop and Retry, Download selected and a per-file retry wait for a
     cycle in flight, and no cycle starts while one of them is in flight. A download the user
     stops by hand is therefore not restarted: it is no longer parked. If the awaited cycle has
     just restarted the download, a Stop also stops the run that cycle started.
- AC-066 (interface): the Download section shows a checkbox "Restart automatically when paused"
  with a sentence saying it works while this workspace is open in a browser tab. While on, a
  status line gives the number of automatic restarts and the time of the last one, or says that
  another tab of this browser is handling it; after it turned itself off, the reason. While it is
  on and a download is parked, the Download section's paused line and the History line say that
  this workspace restarts it within about 30 seconds, not when Zoer retries. After a restart the
  run list and the batch list reload.
- AC-067: `zoer/README.md` describes the option; that it needs the workspace open in a tab, that a
  browser may delay or suspend a background tab, and that a closed tab or a sleeping computer
  restarts nothing (the host's 30-minute retry still applies then); the 3-restart guard and that
  its count is catalog-wide; and what is never restarted: a download that ended "Waiting for you",
  "Failed" or "Stopped", an update pause, a start waiting for approval, and "Keep documents
  current" or selected-notice downloads; and the known limits below.

Known limits, stated in the README: if the workspace closes between the cancel and the start, the
download stays stopped until Retry in History; a manual Stop from another tab, browser or person in
the instant between the cycle's run-list reading and its cancel can be followed by one automatic
restart; two browsers with the option on can both start a resume in the same instant; the second waits
behind the first, and while two download runs are active nothing is restarted automatically; if the action is configured to need approval, the automatic start
waits for it. Nothing changes on OTE until a release the user asks for.

Validation commands (repository root, `ZOER_UI_ROOT` / `ZOER_SOURCE_ROOT` =
`../zoer-ote-attachment-transfer`): `npm run zoer:typecheck`, `npm run zoer:test`,
`npm run zoer:test:catalog`, `npm run zoer:build`. Release and deployment are not part of M7.
