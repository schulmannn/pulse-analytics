import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { Card, CardContent } from '@/components/ui/card';

/*  Onboarding How-To for feeding data into a collector channel. The key insight users
    miss: the API key goes into the local agent's .env, NOT into the website. Reachable
    from the collector empty-state (TASK-014) and the Settings key panel. */

const INGEST_URL = `${window.location.origin}/api/collector/ingest`;

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md border bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-t py-5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function Connect() {
  const { channelId } = useSelectedChannel();
  const { data } = useChannels();
  const channel = data?.channels.find((c) => c.id === channelId);
  const handle = channel?.username ? `@${channel.username}` : '@ваш_канал';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to="/settings" className="text-xs text-muted-foreground hover:text-foreground">
          ← Назад к настройкам
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          Подключение данных канала
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Свои каналы (кроме центрального) считает <span className="font-medium text-foreground">collector-агент</span>{' '}
          у тебя на компьютере и шлёт сюда только готовые цифры. Твою Telegram-сессию мы не храним.
        </p>
      </div>

      {/* Key insight — what wasn't obvious. */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex gap-3 p-4">
          <svg className="mt-0.5 h-5 w-5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="7.5" cy="15.5" r="4.5" />
            <path d="M10.7 12.3 19 4M16 7l2 2M14 9l2 2" />
          </svg>
          <p className="text-sm leading-relaxed text-foreground">
            Ключ <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pa_…</code> вставляется
            в <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code> агента у тебя на
            компьютере — <span className="font-medium">не на сайт</span>. Сайт только генерирует ключ.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="px-5 py-1">
          <Step n={1} title="Получи API-ключ канала">
            <Link to="/settings" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">Настройки</Link> → канал{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{handle}</code> → «Создать ключ» →
            скопируй <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pa_…</code> (показывается один раз).
          </Step>

          <Step n={2} title="Создай Telegram-приложение">
            Открой{' '}
            <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
              my.telegram.org
            </a>{' '}
            → API development tools → создай app → запиши{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">api_id</code> и{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">api_hash</code>.
          </Step>

          <Step n={3} title="Получи строку сессии (один раз)">
            Установи Telethon и залогинься по номеру и коду — скопируй напечатанную строку:
            <CodeBlock>{`pip install telethon
python -c "from telethon.sync import TelegramClient as T; \\
from telethon.sessions import StringSession as S; \\
print(T(S(), API_ID, 'API_HASH').start().session.save())"`}</CodeBlock>
          </Step>

          <Step n={4} title="Заполни .env рядом с агентом">
            <CodeBlock>{`PULSE_API_URL=${window.location.origin}
PULSE_API_KEY=pa_…        # ключ из шага 1
TG_API_ID=123456          # из шага 2
TG_API_HASH=…             # из шага 2
TG_SESSION=…              # из шага 3
TG_CHANNEL=${handle}`}</CodeBlock>
            <p className="mt-2 text-xs text-muted-foreground">
              Ingest URL агент берёт из{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">PULSE_API_URL</code>:{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{INGEST_URL}</code>
            </p>
          </Step>

          <Step n={5} title="Запусти агента">
            <CodeBlock>{`python collector/pulse_collector.py doctor   # проверка конфига
python collector/pulse_collector.py once     # один прогон
python collector/pulse_collector.py run      # дальше каждые 6 ч`}</CodeBlock>
            <p className="mt-2">
              Обнови дашборд через минуту — <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{handle}</code>{' '}
              покажет цифры. Упоминания: добавь флаг{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">--mentions</code>{' '}
              (квота Telegram ограничена).
            </p>
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-5">
          <h2 className="text-xs font-bold tracking-wider text-muted-foreground">Если что-то не так</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">doctor</code> пишет «Missing env» →
              проверь <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.env</code>.
            </li>
            <li>401/403 на ingest → ключ не тот или отозван → пересоздай в Настройках.</li>
            <li>
              Данных всё ещё нет → агент должен оставаться запущенным
              (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">run</code>) или висеть по расписанию.
            </li>
          </ul>
          <p className="pt-1 text-xs text-muted-foreground">
            Агента можно запускать и через Docker или GitHub Actions — детали в{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">collector/README.md</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
