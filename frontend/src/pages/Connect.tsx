import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useChannels, useConnectIg, useDisconnectIg, useIgOauthStatus } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { cn } from '@/lib/utils';

/**
 * /connect — the source hub. Platforms sit on an orbit around Atlavue (atlas + view), the same
 * cartographic language as the empty/error states: hairline ring, one blue accent, stroke glyphs,
 * both themes. Pick a source → its connect panel opens below. Telegram routes to the collector-agent
 * guide; Instagram to the real OAuth flow; the rest are dashed «скоро» placeholders that show the
 * roadmap without pretending to work.
 */

const INGEST_URL = `${window.location.origin}/api/collector/ingest`;

type ServiceId = 'telegram' | 'instagram' | 'threads' | 'youtube' | 'tiktok' | 'x' | 'vk' | 'facebook';
type ServiceKind = 'telegram' | 'instagram' | 'soon';

interface Service {
  id: ServiceId;
  name: string;
  kind: ServiceKind;
  /** «скоро» blurb for roadmap placeholders. */
  soon?: string;
}

// Order = clockwise from the top (12 o'clock). Telegram leads (the core source), Instagram next.
const SERVICES: Service[] = [
  { id: 'telegram', name: 'Telegram', kind: 'telegram' },
  { id: 'instagram', name: 'Instagram', kind: 'instagram' },
  { id: 'threads', name: 'Threads', kind: 'soon', soon: 'Threads-метрики отдаёт тот же токен Instagram — ближайший кандидат после IG.' },
  { id: 'youtube', name: 'YouTube', kind: 'soon', soon: 'Аналитика каналов и видео через YouTube Data API + вход Google.' },
  { id: 'tiktok', name: 'TikTok', kind: 'soon', soon: 'Статистика аккаунта через TikTok for Developers (нужна проверка приложения).' },
  { id: 'x', name: 'X', kind: 'soon', soon: 'Метрики профиля и постов через X API (платный доступ).' },
  { id: 'vk', name: 'VK', kind: 'soon', soon: 'Сообщества и статистика через VK API — актуально для RU-аудитории.' },
  { id: 'facebook', name: 'Facebook', kind: 'soon', soon: 'Страницы и Insights через Meta Graph API — та же бизнес-верификация, что и Instagram.' },
];

// Stroke-only line glyphs (nav-icon language). Rendered inside a 24-box, currentColor.
const GLYPHS: Record<ServiceId, ReactNode> = {
  telegram: (<><path d="M22 4 2 11l6 2.5L11 20l3-4 5 3z" /><path d="m8 13.5 8-6" /></>),
  instagram: (<><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.3" cy="6.7" r="1" className="fill-current" stroke="none" /></>),
  threads: (<path d="M16 8c-1.5-2-6-2.5-8 0-2.5 3-1 9 3 9 3 0 4-2 4-4s-1.5-3-3.5-3-3 2-1.5 3" />),
  youtube: (<><rect x="2.5" y="6" width="19" height="12" rx="4" /><path d="m10 9.5 5 2.5-5 2.5z" /></>),
  tiktok: (<><path d="M10 8v6.5a3 3 0 1 1-3-3" /><path d="M10 8c.5 2 2 3.5 5 3.5" /></>),
  x: (<path d="M5 5 19 19M19 5 5 19" />),
  vk: (<path d="M3 8c.7 5 3.6 8.5 7.5 8.5H12v-3c1.4 1.7 2.4 3 4 3h2.2c.6 0 .8-.3.6-.9-.4-1.2-2-2.6-2-2.6s1.6-1.9 2-3c.2-.6 0-.9-.6-.9H18c-.6 0-.8.3-1 .8 0 0-.8 2-2 3.2V9c0-.6-.3-.9-.8-.9h-2.7" />),
  facebook: (<path d="M14 8h2.5M14 8c0-2 1-3 3-3M14 8v13M11 12h6" />),
};

function Glyph({ id, className }: { id: ServiceId; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {GLYPHS[id]}
    </svg>
  );
}

const RADIUS = 42; // % of the ring container

export function Connect() {
  const [selected, setSelected] = useState<ServiceId>('telegram');
  const { data: channelsData } = useChannels();
  const igStatus = useIgOauthStatus();

  const igConnected = igStatus.data?.connected ?? false;
  const tgConnected = (channelsData?.channels?.length ?? 0) > 0;
  const stateOf = (s: Service): 'connected' | 'available' | 'soon' => {
    if (s.kind === 'soon') return 'soon';
    if (s.kind === 'instagram') return igConnected ? 'connected' : 'available';
    return tgConnected ? 'connected' : 'available';
  };
  const connectedCount = SERVICES.filter((s) => stateOf(s) === 'connected').length;

  // Arrow keys rotate the selection around the ring (GTA-wheel muscle memory, keyboard-friendly).
  const ringRef = useRef<HTMLDivElement>(null);
  const rotate = useCallback((dir: 1 | -1) => {
    setSelected((cur) => {
      const i = SERVICES.findIndex((s) => s.id === cur);
      return SERVICES[(i + dir + SERVICES.length) % SERVICES.length].id;
    });
  }, []);
  useEffect(() => {
    const el = ringRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); rotate(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); rotate(-1); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [rotate]);

  // Ring radius (px) for the radiate-from-center entrance — feeds --ring-r so each node's start
  // offset (--dx/--dy) points back to the exact hub centre at any container size.
  const [ringR, setRingR] = useState(176);
  useEffect(() => {
    const el = ringRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRingR((el.clientWidth * RADIUS) / 100);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // macOS-dock magnification: the node under the cursor grows most, neighbours a little (a
  // proximity falloff around the ring). Mouse-only + off under prefers-reduced-motion.
  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dots = Array.from(ring.querySelectorAll<HTMLElement>('[data-dot]'));
    const RANGE = 96;
    const BUMP = 0.3;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const scales = dots.map((dot) => {
        const r = dot.getBoundingClientRect();
        const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        const f = Math.max(0, 1 - dist / RANGE);
        return f > 0 ? 1 + BUMP * f * f : 1;
      });
      dots.forEach((dot, i) => {
        dot.style.transform = scales[i] > 1 ? `scale(${scales[i].toFixed(3)})` : '';
      });
    };
    const onLeave = () => dots.forEach((dot) => (dot.style.transform = ''));
    ring.addEventListener('pointermove', onMove);
    ring.addEventListener('pointerleave', onLeave);
    return () => {
      ring.removeEventListener('pointermove', onMove);
      ring.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  const active = SERVICES.find((s) => s.id === selected)!;
  const activeState = stateOf(active);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-2">
        <Link to="/settings" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
          ← Назад к настройкам
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground">
          Источников {SERVICES.length} · подключено {connectedCount}
        </p>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">Соберите свой атлас данных</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Каждая площадка — точка на орбите вокруг Atlavue. Выберите источник, чтобы подключить его.
          Подключённые светятся синим, доступные — в контуре, будущие — пунктиром.
        </p>
      </div>

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
        {/* Orbit */}
        <div className="flex justify-center">
          <div
            ref={ringRef}
            role="radiogroup"
            aria-label="Источники данных"
            tabIndex={0}
            style={{ '--ring-r': `${ringR}px` } as CSSProperties}
            className="relative aspect-square w-[min(420px,86vw)] rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          >
            {/* rings */}
            <div className="absolute inset-0 rounded-full border border-border" aria-hidden="true" />
            <div className="absolute inset-[9%] rounded-full border border-dashed border-border opacity-60" aria-hidden="true" />

            {/* hub */}
            <div className="connect-hub absolute left-1/2 top-1/2 flex aspect-square w-[38%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-border bg-card px-4 text-center" aria-live="polite">
              <span className="font-mono text-2xs uppercase tracking-[0.1em] text-muted-foreground">Источник</span>
              <span className="mt-1 text-base font-medium tracking-tight text-foreground sm:text-lg">{active.name}</span>
              <span className="mt-0.5 text-2xs text-muted-foreground">
                {activeState === 'connected' ? 'Подключён' : activeState === 'available' ? 'Доступно' : 'Скоро'}
              </span>
            </div>

            {/* nodes */}
            {SERVICES.map((s, i) => {
              const theta = (i * Math.PI) / 4;
              const left = 50 + RADIUS * Math.sin(theta);
              const top = 50 - RADIUS * Math.cos(theta);
              const st = stateOf(s);
              const isSel = s.id === selected;
              return (
                <div key={s.id} className="absolute" style={{ left: `${left}%`, top: `${top}%`, transform: 'translate(-50%,-50%)' }}>
                  <div
                    className="connect-orb"
                    style={{
                      '--i': i,
                      '--dx': `calc(var(--ring-r, 176px) * ${(-Math.sin(theta)).toFixed(4)})`,
                      '--dy': `calc(var(--ring-r, 176px) * ${Math.cos(theta).toFixed(4)})`,
                    } as CSSProperties}
                  >
                    <button
                      data-dot
                      type="button"
                      role="radio"
                      aria-checked={isSel}
                      aria-label={`${s.name}${st === 'connected' ? ' — подключён' : st === 'soon' ? ' — скоро' : ' — доступно'}`}
                      onClick={() => setSelected(s.id)}
                      className={cn(
                        'relative flex size-12 items-center justify-center rounded-full border bg-card transition-all duration-100 ease-out will-change-transform sm:size-14',
                        st === 'connected' && 'border-primary/60 text-primary',
                        st === 'available' && 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground',
                        st === 'soon' && 'border-dashed border-border text-muted-foreground opacity-60 hover:opacity-100',
                        isSel && 'border-primary bg-primary/10 text-primary',
                      )}
                    >
                      <Glyph id={s.id} className="size-6" />
                      {st === 'connected' && (
                        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-card bg-verdant" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Panel */}
        <div className="min-w-0">
          {active.kind === 'telegram' && <TelegramPanel connected={tgConnected} channelName={channelName(channelsData)} />}
          {active.kind === 'instagram' && <InstagramPanel />}
          {active.kind === 'soon' && <SoonPanel name={active.name} glyph={active.id} note={active.soon ?? ''} />}
        </div>
      </div>

      {/* legend */}
      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <Legend swatch="connected">Подключён — данные идут</Legend>
        <Legend swatch="available">Доступен — можно подключить</Legend>
        <Legend swatch="soon">Скоро — в дорожной карте</Legend>
      </div>
    </div>
  );
}

function channelName(data: ReturnType<typeof useChannels>['data']): string | null {
  const c = data?.channels?.[0];
  if (!c) return null;
  return String(c.username ? `@${c.username}` : c.title || c.id);
}

function Legend({ swatch, children }: { swatch: 'connected' | 'available' | 'soon'; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          'inline-block size-4 rounded-full border',
          swatch === 'connected' && 'border-primary',
          swatch === 'available' && 'border-border',
          swatch === 'soon' && 'border-dashed border-border opacity-60',
        )}
      />
      {children}
    </span>
  );
}

// ── Panel header shared by every source ──
function PanelHead({ id, name, pill }: { id: ServiceId; name: string; pill: { label: string; tone: 'ok' | 'go' | 'mut' } }) {
  const tone =
    pill.tone === 'ok'
      ? 'border-verdant/45 text-verdant'
      : pill.tone === 'go'
        ? 'border-primary/45 text-primary'
        : 'border-border text-muted-foreground';
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border text-foreground">
        <Glyph id={id} className="size-5" />
      </span>
      <h2 className="flex-1 text-lg font-medium tracking-tight text-foreground">{name}</h2>
      <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-2xs uppercase tracking-wide', tone)}>
        {pill.label}
      </span>
    </div>
  );
}

// ── Instagram: real OAuth ──
function InstagramPanel() {
  const { channelId } = useSelectedChannel();
  const status = useIgOauthStatus();
  const connect = useConnectIg();
  const disconnect = useDisconnectIg();
  const connected = status.data?.connected ?? false;
  const serverReady = status.data?.server_ready ?? false;
  const notReady = status.isSuccess && !serverReady;
  const connectError = connect.error instanceof Error ? connect.error.message : null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="instagram"
        name="Instagram"
        pill={connected ? { label: 'Подключён', tone: 'ok' } : { label: 'Доступно', tone: 'go' }}
      />

      {channelId == null ? (
        <p className="mt-4 text-sm text-muted-foreground">Сначала выберите канал в переключателе источника слева вверху.</p>
      ) : connected ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Подключён бизнес-аккаунт <span className="font-mono text-foreground">@{status.data?.username}</span>. Реальные охваты,
            аудитория и публикации этого канала идут из Instagram.
          </p>
          <button
            type="button"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
            className="btn-pill border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
          >
            {disconnect.isPending ? 'Отключаю…' : 'Отключить'}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Вход через Instagram — один клик. Нужен аккаунт <b className="font-medium text-foreground">Business</b> или{' '}
            <b className="font-medium text-foreground">Creator</b> (не личный). Facebook-страница не требуется.
          </p>
          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending || notReady}
            className="btn-pill bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {connect.isPending ? 'Открываю Instagram…' : 'Войти через Instagram'}
          </button>
          {connectError && <p className="text-xs font-medium text-destructive">{connectError}</p>}
          {notReady && (
            <p className="text-xs text-muted-foreground">
              Подключение Instagram ещё не настроено на сервере{status.data?.env_fallback ? ' — пока показан общий аккаунт' : ''}.
            </p>
          )}
          <div className="grid gap-5 border-t border-border pt-4 sm:grid-cols-2">
            <Mini title="Что нужно">
              <MiniLi>Аккаунт Business или Creator</MiniLi>
              <MiniLi>Вы — администратор аккаунта</MiniLi>
              <MiniLi>Подтвердить доступ в окне Instagram</MiniLi>
            </Mini>
            <Mini title="Что станет доступно">
              <MiniLi ok>Реальные охваты и просмотры</MiniLi>
              <MiniLi ok>Демография и география</MiniLi>
              <MiniLi ok>Reels, Stories и публикации</MiniLi>
            </Mini>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Telegram: collector-agent guide ──
function TelegramPanel({ connected, channelName }: { connected: boolean; channelName: string | null }) {
  const handle = channelName ?? '@ваш_канал';
  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="telegram"
        name="Telegram"
        pill={connected ? { label: 'Подключён', tone: 'ok' } : { label: 'Доступно', tone: 'go' }}
      />
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Каналы считает <span className="font-medium text-foreground">collector-агент</span> у вас на компьютере и шлёт сюда
        только готовые цифры. Telegram-сессию мы не храним. {connected ? `Сейчас подключён ${handle}.` : ''}
      </p>

      <div className="mt-4 flex gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3.5">
        <svg className="mt-0.5 size-5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="M10.7 12.3 19 4M16 7l2 2M14 9l2 2" />
        </svg>
        <p className="text-sm leading-relaxed text-foreground">
          Ключ <Code>pa_…</Code> вставляется в <Code>.env</Code> агента на вашем компьютере —{' '}
          <span className="font-medium">не на сайт</span>. Сайт только генерирует ключ.
        </p>
      </div>

      <div className="mt-5">
        <Step n={1} title="Получите API-ключ канала">
          <Link to="/settings" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">Настройки</Link>{' '}
          → канал <Code>{handle}</Code> → «Создать ключ» → скопируйте <Code>pa_…</Code> (показывается один раз).
        </Step>
        <Step n={2} title="Создайте Telegram-приложение">
          <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">my.telegram.org</a>{' '}
          → API development tools → создайте app → запишите <Code>api_id</Code> и <Code>api_hash</Code>.
        </Step>
        <Step n={3} title="Получите строку сессии (один раз)">
          Установите Telethon и залогиньтесь по номеру и коду — скопируйте напечатанную строку:
          <CodeBlock>{`pip install telethon
python -c "from telethon.sync import TelegramClient as T; \\
from telethon.sessions import StringSession as S; \\
print(T(S(), API_ID, 'API_HASH').start().session.save())"`}</CodeBlock>
        </Step>
        <Step n={4} title="Заполните .env рядом с агентом">
          <CodeBlock>{`PULSE_API_URL=${window.location.origin}
PULSE_API_KEY=pa_…        # ключ из шага 1
TG_API_ID=123456          # из шага 2
TG_API_HASH=…             # из шага 2
TG_SESSION=…              # из шага 3
TG_CHANNEL=${handle}`}</CodeBlock>
          <p className="mt-2 text-xs text-muted-foreground">
            Ingest URL берётся из <Code>PULSE_API_URL</Code>: <Code>{INGEST_URL}</Code>
          </p>
        </Step>
        <Step n={5} title="Запустите агента" last>
          <CodeBlock>{`python collector/pulse_collector.py doctor   # проверка конфига
python collector/pulse_collector.py once     # один прогон
python collector/pulse_collector.py run      # дальше каждые 6 ч`}</CodeBlock>
          <p className="mt-2 text-sm text-muted-foreground">
            Обновите дашборд через минуту — <Code>{handle}</Code> покажет цифры. Упоминания: флаг <Code>--mentions</Code>.
          </p>
        </Step>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Если что-то не так</h3>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li><Code>doctor</Code> пишет «Missing env» → проверьте <Code>.env</Code>.</li>
          <li>401/403 на ingest → ключ не тот или отозван → пересоздайте в Настройках.</li>
          <li>Данных нет → агент должен оставаться запущенным (<Code>run</Code>) или висеть по расписанию.</li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Агента можно запускать через Docker или GitHub Actions — детали в <Code>collector/README.md</Code>.
        </p>
      </div>
    </div>
  );
}

// ── Soon placeholder ──
function SoonPanel({ name, glyph, note }: { name: string; glyph: ServiceId; note: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-5 sm:p-6">
      <PanelHead id={glyph} name={name} pill={{ label: 'Скоро', tone: 'mut' }} />
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{note}</p>
      <button
        type="button"
        disabled
        className="btn-pill mt-5 border border-border px-4 py-2 text-sm font-medium text-muted-foreground opacity-60"
      >
        В дорожной карте
      </button>
    </div>
  );
}

// ── little building blocks ──
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded border border-border bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

function Step({ n, title, children, last }: { n: number; title: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex gap-3 border-t border-border py-4', last && 'border-b')}>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function Mini({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-2xs font-medium tracking-wide text-muted-foreground">{title}</div>
      <ul className="mt-2 space-y-1.5">{children}</ul>
    </div>
  );
}

function MiniLi({ children, ok }: { children: ReactNode; ok?: boolean }) {
  return (
    <li className="flex items-start gap-2 text-sm text-muted-foreground">
      {ok ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 size-3.5 shrink-0 text-verdant" aria-hidden="true">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />
      )}
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
