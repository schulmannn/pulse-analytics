-- 036_mention_notify_schedule.sql
-- Расписание доставки упоминаний (доводка 035 по прод-фидбеку): пользователь выбирает дни недели
-- и час отправки. Времена — МСК (Europe/Moscow), как весь календарный канон проекта.
--
-- send_days — ISO-дни недели (1=Пн … 7=Вс); ПУСТОЙ массив = каждый день (дефолт).
-- send_hour — час МСК; подписка шлётся ПЕРВЫМ прогоном (почасовой operational-свип или хвост
-- дневного ingest'а) после наступления send_hour в разрешённый день; runJobOnce-ключ по МСК-дате
-- гарантирует не больше одной отправки в сутки. Дефолт 10:00 МСК — чтобы ночной тик не будил.
ALTER TABLE mention_notify_subscriptions
  ADD COLUMN IF NOT EXISTS send_days smallint[] NOT NULL DEFAULT '{}';
ALTER TABLE mention_notify_subscriptions
  ADD COLUMN IF NOT EXISTS send_hour smallint NOT NULL DEFAULT 10;

-- Именованный CHECK — идемпотентно через каталог (ADD CONSTRAINT IF NOT EXISTS только в PG16).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mention_notify_subscriptions_send_hour_chk'
       AND conrelid = 'mention_notify_subscriptions'::regclass
  ) THEN
    ALTER TABLE mention_notify_subscriptions
      ADD CONSTRAINT mention_notify_subscriptions_send_hour_chk
      CHECK (send_hour BETWEEN 0 AND 23);
  END IF;
END$$;
