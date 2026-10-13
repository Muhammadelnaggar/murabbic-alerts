# مُرَبِّيك — Stage 8: Batch import, bulk reproductive events, atomic prepared-result invalidation

## Exact status

CANDIDATE ONLY. **NOT DEPLOYED**. `main` and Render remain unchanged. Prepared GET is **hard-disabled** in the server. The 12-second real-life latency is **NOT fixed or verified** by this stage.

### Baselines verified

- Stage7 input: `server_stage7_candidate.js`, SHA256 `d51b2e397798f54782be6872337e095e7192f014f7e9b00a8ffb3b1a69197a69`.
- Stage8 output: `server_stage8_candidate.js`, SHA256 `61171e1fdc86337e8b8bf05e6df84b59244a6f102fb48360197e7edeabb0913f`.
- Code change **only** seven `appendToBatchIfEnabled()` calls before existing batch commits; no route/medical validation removed. `stage7_to_stage8.patch` and `build_stage8.py` reproduce this exact result and refuse a different input baseline.

### Newly covered write paths

1. `POST /api/add-animal/import`: mark **each committed chunk**, including final partial chunk; never mark rejected/empty rows.
2. `POST /api/herd-import-v2/save-operational`: mark each committed chunk of animals, including final partial chunk.
3. `POST /api/insemination/bulk-save`: mark each nonempty batch before `commitIfNeeded` commits.
4. `POST /api/pregnancy-diagnosis/bulk-save`: same protection, including embryonic-loss records.
5. `herdImportV2CommitAtomicWriteSetInternalSrv()`: mark V2 **actual atomic seed-event import** in the batch containing animals, historical seed events, and completed job state. Already-completed jobs are not marked again.

The previous 18 covered endpoints/paths remain; this adds four explicit endpoints plus one distinct V2 atomic import mode. This is **not** proof that all mutation paths have been covered.

### Tests

```
python3 build_stage8.py
node --check server_stage8_candidate.js
node --test tests/test-mutation-barrier.cjs test-prepared-read.cjs test-get-integration.cjs test-prepared-publisher.cjs test_stage7_atomic_routes.cjs test_stage8_bulk_atomic.cjs
```

Result: **74 local tests pass; 0 fail**, including byte-for-byte undo restoring Stage7, no extra writes when flag off, rollback when a chunk fails, and multiple-chunk generation sequencing. Test double used for Firestore. **No real Firestore throughput/1000-user tests**.

### Explicit blockers and safety

- Hardcoded `ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false` continues to block prepared GET regardless of settings; `MURABBIK_PREPARED_MUTATION_TRACKING` default is OFF.
- `/api/add-animal/save` and other direct `.set()`/`.add()`/`.update()` operations are not covered by this chunk; some bulk and admin operations still require tracing.
- The same generation metadata doc is incremented once per committed batch, **not per animal**; concentrated write activity can still cause contention. Test before enabling.
- Multiple chunk commits are not a single all-or-nothing import; this change preserves the original behavior, including existing partial-failure response behavior. No claim to fix pre-existing bulk-response errors.
- Historical backfill, time-based invalidation for all sources and BVD/GET side effects remain blockers; do **not** deploy or activate prepared read on Render.
- Restore the entire `.js` using `gzip -dc server_stage8_candidate.js.gz > server_stage8_candidate.js`. Run `sha256sum` and compare to the Stage8 output hash above.

### Continue

Read this README and the Stage7 README and `stage7_to_stage8.patch`. Focus next on the direct single-animal save and other direct writes that cannot atomically invalidate without modifying their write strategy; do not blindly add after-the-fact control writes. Preserve strict tenant isolation. This is a development backup only, NOT a deployable package.