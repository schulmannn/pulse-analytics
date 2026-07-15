-- Ретеншн терминальных строк jobs (см. server/repos/jobsRepo.js → pruneTerminalJobs).
-- jobs — append-only ledger идемпотентности (одна строка на kind+idempotency_key), поэтому без
-- прунинга он растёт безгранично; ночной bounded-DELETE режет только status IN ('succeeded','failed')
-- с updated_at старше горизонта, батчами ORDER BY (updated_at, id) LIMIT n.
--
-- Существующий jobs_claimable_idx(kind, status, locked_until) ведёт по kind и предикату ретеншна
-- (status+updated_at без kind) не помогает → каждый батч иначе делает seq scan + top-N sort по всё
-- растущему ledger'у. Частичный композитный индекс по (updated_at, id) ТОЛЬКО для терминальных строк
-- превращает батч в дешёвый forward index range scan и держит план стабильным по мере роста таблицы.
-- Частичный (WHERE status IN (...)) — компактный: живые queued/running в индекс не попадают.
--
-- Forward-only, идемпотентно (IF NOT EXISTS). Обычный (не CONCURRENTLY) CREATE INDEX: раннер миграций
-- оборачивает файл в один BEGIN/COMMIT, а CONCURRENTLY в транзакции недопустим; на одной web-реплике
-- (ADR-002) с умеренным jobs это короткий безопасный build.
CREATE INDEX IF NOT EXISTS jobs_terminal_prune_idx
  ON jobs (updated_at, id)
  WHERE status IN ('succeeded', 'failed');
