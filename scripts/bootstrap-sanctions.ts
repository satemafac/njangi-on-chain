// Runs the SAME refresh the weekly cron calls, against DATABASE_URL.
//
// The cron endpoint is the normal path (docs/sanctions-program.md), but it
// needs CRON_SECRET. This is the equivalent for an operator who has database
// access instead — e.g. bootstrapping a freshly-migrated database, where the
// list is empty and every fail-closed screen therefore refuses.
//
// Idempotent: a content-hash match short-circuits without writes.
import { refreshSanctionsList } from '../src/lib/sanctions';

(async () => {
  const result = await refreshSanctionsList();
  console.log('[bootstrap-sanctions]', JSON.stringify(result));
  process.exit(0);
})().catch((err) => {
  console.error('[bootstrap-sanctions] failed:', err?.message ?? err);
  process.exit(1);
});
