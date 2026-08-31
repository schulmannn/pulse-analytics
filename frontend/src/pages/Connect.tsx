import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LoaderDots } from '@/components/ui/loader';
import { useConfirm } from '@/components/ConfirmDialogProvider';
import { toast } from 'sonner';
import { z } from 'zod';
import QRCode from 'qrcode';
import { useQueryClient } from '@tanstack/react-query';
import { useChannels, useCollectorStatus, useConnectIg, useCreateKey, useDisconnectIg, useIgOauthStatus, useMsBackfillStatus, useMsStatus, useTgQrStatus, useYmStatus } from '@/api/queries';
import { useCdekStatus, useCreateCdekSource } from '@/api/cdek';
import { RusenderConnectSchema, rusenderKeys, useRusenderStatus } from '@/api/rusender';
import { ApiError, apiSend } from '@/api/client';
import { qk } from '@/api/queryKeys';
import type { Channel } from '@/api/schemas';
import { orbitHealth, type OrbitNetworkHealth } from '@/lib/connectionHealth';
import { fmt } from '@/lib/format';
import { ChannelScope, useSelectedChannel } from '@/lib/channel-context';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Snippet } from '@/components/ui/snippet';

/**
 * /connect — the source hub. Platforms sit on an orbit around Atlavue (atlas + view), the same
 * cartographic language as the empty/error states: hairline ring, one blue accent, stroke glyphs,
 * both themes. Pick a source → its connect panel opens below. Telegram routes to the collector-agent
 * guide; Instagram to the real OAuth flow; the rest are dashed «скоро» placeholders that show the
 * roadmap without pretending to work.
 */

const INGEST_URL = `${window.location.origin}/api/collector/ingest`;
const MutationOkSchema = z.object({ ok: z.boolean() }).passthrough();
const MsConnectSchema = z
  .object({
    ok: z.literal(true),
    channel_id: z.coerce.number(),
    org_name: z.string().nullable().optional(),
  })
  .passthrough();
const MsBackfillStartSchema = z
  .object({ ok: z.literal(true), status: z.literal('running') })
  .passthrough();
const YmConnectSchema = z
  .object({
    ok: z.boolean(),
    choice_required: z.boolean().optional(),
    counters: z
      .array(
        z
          .object({
            id: z.coerce.string(),
            name: z.string().nullable(),
            site: z.string().nullable(),
          })
          .passthrough(),
      )
      .optional(),
    channel_id: z.coerce.number().optional(),
    counter_name: z.string().nullable().optional(),
    site: z.string().nullable().optional(),
  })
  .passthrough();

type ServiceId = 'telegram' | 'instagram' | 'moysklad' | 'metrika' | 'cdek' | 'rusender' | 'threads' | 'youtube' | 'tiktok' | 'x' | 'vk' | 'facebook';
type ServiceKind = 'telegram' | 'instagram' | 'moysklad' | 'metrika' | 'cdek' | 'rusender' | 'soon';

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
  // «МойСклад» — первый не-социальный источник: продажи/заказы по токену API.
  { id: 'moysklad', name: 'МойСклад', kind: 'moysklad' },
  // «Яндекс.Метрика» — веб-аналитика сайта: визиты/посетители/источники по OAuth-токену.
  { id: 'metrika', name: 'Яндекс.Метрика', kind: 'metrika' },
  // «СДЭК Fulfillment» — первый источник БЕЗ API: заказы приезжают выгрузкой Excel вручную.
  { id: 'cdek', name: 'СДЭК', kind: 'cdek' },
  // «Rusender» — email-рассылки: рассылки, открытия/клики и база контактов по API-ключу.
  { id: 'rusender', name: 'Rusender', kind: 'rusender' },
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
  moysklad: (<><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>),
  metrika: (<path d="M5 20v-6M12 20V9M19 20V4" />),
  // Фура: короб уже занят «МойСкладом», два коробка в одной орбите читались бы как один источник.
  cdek: (<><path d="M14 17.5V7a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 3 7v9.5a1 1 0 0 0 1 1h1" /><path d="M14 9h3.2a1 1 0 0 1 .8.4l2.8 3.6a1 1 0 0 1 .2.6v3a1 1 0 0 1-1 1h-1" /><path d="M9 17.5h6" /><circle cx="7" cy="17.5" r="1.9" /><circle cx="17" cy="17.5" r="1.9" /></>),
  // Конверт: единственный источник, чья единица контента — письмо.
  rusender: (<><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.8 7.2 8.2 5.8 8.2-5.8" /></>),
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

const isServiceId = (v: string | null): v is ServiceId => SERVICES.some((s) => s.id === v);

export function Connect() {
  // Deep links preselect a source (?source=telegram) and, for Telegram, the tab (?tab=qr|agent) and a
  // reconnect intent (?action=reconnect). Recognised source ids drive selection; anything else is
  // ignored (Telegram stays the default). Params are read live so an in-app link change re-selects.
  const [searchParams] = useSearchParams();
  const sourceParam = searchParams.get('source');
  const tabParam = searchParams.get('tab');
  const actionParam = searchParams.get('action');
  const tgTab = tabParam === 'agent' ? 'agent' : tabParam === 'qr' ? 'qr' : null;

  const [selected, setSelected] = useState<ServiceId>(() => (isServiceId(sourceParam) ? sourceParam : 'telegram'));
  useEffect(() => {
    if (isServiceId(sourceParam)) setSelected(sourceParam);
  }, [sourceParam]);

  const { data: channelsData } = useChannels();
  const channels = channelsData?.channels ?? [];
  const hasQrChannel = channels.some((channel) => channel.source === 'qr');
  const hasCentralChannel = channels.some((channel) => channel.source === 'central');
  const tgStatus = useTgQrStatus(hasQrChannel || hasCentralChannel);
  const igStatus = useIgOauthStatus();
  // Орбита обязана говорить то же, что панель справа: у каждого не-«скоро» источника свой
  // источник правды. Статусы МС/Метрики берём теми же хуками, что и MoySkladPanel/MetrikaPanel
  // (ключи запросов общие — повторный вызов не даёт лишнего сетевого похода).
  const msChannelId = channels.find((channel) => channel.source === 'ms')?.id ?? null;
  const ymChannels = channels.filter((channel) => channel.source === 'ym');
  const ymChannelId = ymChannels[0]?.id ?? null;
  const msStatus = useMsStatus(msChannelId);
  const ymStatus = useYmStatus(ymChannelId);
  // У СДЭКа нет статуса подключения: источник существует ровно потому, что его завели. Наличие
  // канала — и есть весь признак, отдельный запрос сюда ничего бы не добавил.
  const cdekChannelId = channels.find((channel) => channel.source === 'cdek')?.id ?? null;
  // Rusender — как у Метрики, источник МОЖЕТ быть не один (свой аккаунт = свой канал), поэтому
  // панель держит список каналов и адресует мутации поканально.
  const rusenderChannels = channels.filter((channel) => channel.source === 'rusender');
  const rusenderChannelId = rusenderChannels[0]?.id ?? null;
  const rusenderStatus = useRusenderStatus(rusenderChannelId);

  // IG counts as connected when a per-channel OAuth account is linked OR the global env account is
  // serving data (env_fallback) — both mean real Instagram numbers are flowing.
  const igConnected = (igStatus.data?.connected ?? false) || (igStatus.data?.env_fallback ?? false);
  // Статус источника — на уровне WORKSPACE, не активного канала: useMsStatus/useYmStatus читают
  // текущий канал свитчера, и подключённый на СВОЁМ канале МойСклад показывался «Доступен»
  // (владелец: «пишет, что МойСклад не подключён»). Канал каждой сети источника уже есть в списке
  // каналов (source: 'ms' | 'ym'); Telegram считает только собственные каналы (зеркало
  // channelsForSource), а не любой канал workspace.
  const centralOwner = hasCentralChannel && !!tgStatus.data?.central_owner;
  const managedTelegram = hasQrChannel || centralOwner;
  const independentTelegram = channels.some(
    (channel) =>
      channel.source === 'collector' ||
      channel.source == null ||
      (channel.source === 'central' && !centralOwner),
  );
  // A retained QR channel row is not proof that its deleted session still sends data. While the
  // shared status is loading we preserve the previous row-based state; once loaded, `connected`
  // becomes authoritative. Collector / foreign central channels remain independently connected.
  const managedTelegramConnected = managedTelegram
    ? (tgStatus.data?.connected ?? true)
    : false;
  const tgConnected = independentTelegram || managedTelegramConnected;
  const msConnected = msStatus.isSuccess ? !!msStatus.data?.connected : msChannelId != null;
  // Пилюля источника — про источник целиком, а не про первый счётчик: подключён хотя бы один.
  const ymConnected = ymStatus.isSuccess ? !!ymStatus.data?.connected : ymChannelId != null;
  // Пилюля источника — про источник целиком, а не про первый аккаунт: подключён хотя бы один.
  const rusenderConnected = rusenderStatus.isSuccess
    ? !!rusenderStatus.data?.connected
    : rusenderChannelId != null;
  const networkHealth = orbitHealth({
    telegram: {
      managed: managedTelegram,
      connectionState: managedTelegram ? tgStatus.data?.connection_state : null,
    },
    instagram: {
      connected: igStatus.data?.connected,
      envFallback: igStatus.data?.env_fallback,
      tokenExpiresAt: igStatus.data?.token_expires_at,
    },
    moysklad: msStatus.data,
    metrika: ymStatus.data,
  });
  const stateOf = (s: Service): 'connected' | 'available' | 'soon' => {
    if (s.kind === 'soon') return 'soon';
    if (s.kind === 'instagram') return igConnected ? 'connected' : 'available';
    if (s.kind === 'moysklad') return msConnected ? 'connected' : 'available';
    if (s.kind === 'metrika') return ymConnected ? 'connected' : 'available';
    if (s.kind === 'cdek') return cdekChannelId != null ? 'connected' : 'available';
    if (s.kind === 'rusender') return rusenderConnected ? 'connected' : 'available';
    return tgConnected ? 'connected' : 'available';
  };
  const healthOf = (service: Service): OrbitNetworkHealth => {
    if (service.kind === 'instagram') return networkHealth.instagram;
    if (service.kind === 'moysklad') return networkHealth.moysklad;
    if (service.kind === 'metrika') return networkHealth.metrika;
    if (service.kind === 'telegram') return networkHealth.telegram;
    return { health: 'ok', reason: null };
  };
  const stateLabel = (service: Service, state = stateOf(service)) => {
    if (state === 'soon') return 'скоро';
    if (state === 'available') return 'доступен';
    const reason = healthOf(service).reason;
    return reason ? `подключён · ${reason}` : 'подключён';
  };
  const connectedCount = SERVICES.filter((s) => stateOf(s) === 'connected').length;

  // Native radios provide the expected arrow-key selection contract without a custom group handler.
  const ringRef = useRef<HTMLFieldSetElement>(null);

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
      <div className="mb-3">
        {/* Возврат — круглая иконко-кнопка со стрелкой + тихая подпись (выбор владельца из
            вариантов дизайна): жест «назад» первичен, подпись вторична. */}
        <Link
          to="/settings"
          className="group inline-flex items-center gap-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="inline-flex size-7 items-center justify-center rounded-full border border-border text-foreground/80 transition-colors group-hover:border-muted-foreground group-hover:bg-card group-hover:text-foreground">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5" aria-hidden="true">
              <path d="M19 12H5M11 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Настройки
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Источников {SERVICES.length} · подключено {connectedCount}
        </p>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">Подключение источников</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Выберите площадку — справа появятся статус и шаги подключения.
        </p>
      </div>

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,420px)_1fr]">
        {/* Orbit */}
        <div className="relative flex justify-center">
          <Starfield />
          <fieldset
            ref={ringRef}
            style={{ '--ring-r': `${ringR}px` } as CSSProperties}
            className="relative m-0 aspect-square min-w-0 w-[min(420px,86vw)] rounded-full border-0 p-0"
          >
            <legend className="sr-only">Источники данных</legend>
            {/* rings */}
            <div className="absolute inset-0 rounded-full border border-border" aria-hidden="true" />
            <div className="absolute inset-[9%] rounded-full border border-dashed border-border opacity-60" aria-hidden="true" />

            {/* Хаб-круг с именем выбранного источника убран (владелец: дублировал панель справа —
                имя и статус уже в её шапке). AT-анонс выбора сохранён невизуальным live-регионом. */}
            <span className="sr-only" aria-live="polite">
              {active.name} — {stateLabel(active, activeState)}
            </span>

            {/* nodes */}
            {SERVICES.map((s, i) => {
              // Шаг — от ФАКТИЧЕСКОГО числа узлов, не жёсткие π/4: восьмишаговая сетка с девятым
              // источником (МойСклад) клала Facebook (i=8, 2π) ровно под Telegram (i=0).
              const theta = (i * 2 * Math.PI) / SERVICES.length;
              const left = 50 + RADIUS * Math.sin(theta);
              const top = 50 - RADIUS * Math.cos(theta);
              const st = stateOf(s);
              const health = healthOf(s);
              const isSel = s.id === selected;
              return (
                <label
                  key={s.id}
                  data-mobile-touch-target=""
                  className="absolute block size-12 cursor-pointer sm:size-14"
                  style={{ left: `${left}%`, top: `${top}%`, transform: 'translate(-50%,-50%)' }}
                >
                  <input
                    type="radio"
                    name="connect-source"
                    value={s.id}
                    checked={isSel}
                    onChange={() => setSelected(s.id)}
                    aria-label={`${s.name} — ${stateLabel(s, st)}`}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="connect-orb absolute inset-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-4 peer-focus-visible:ring-offset-background"
                    style={{
                      '--i': i,
                      '--dx': `calc(var(--ring-r, 176px) * ${(-Math.sin(theta)).toFixed(4)})`,
                      '--dy': `calc(var(--ring-r, 176px) * ${Math.cos(theta).toFixed(4)})`,
                    } as CSSProperties}
                  >
                    <span
                      data-dot
                      className={cn(
                        // Enumerated + dur-track: the dock magnification below writes `transform`
                        // on every pointermove, so this transition exists to smooth THAT — `all`
                        // dragged size/layout properties into a per-frame tween for no reason.
                        'relative flex size-12 items-center justify-center rounded-full border bg-card transition-[transform,border-color,background-color,color,opacity] dur-track ease-house will-change-transform sm:size-14',
                        st === 'connected' && 'border-primary/60 text-primary',
                        st === 'available' && 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground',
                        st === 'soon' && 'border-dashed border-border text-muted-foreground opacity-60 hover:opacity-100',
                        isSel && 'border-primary bg-primary/10 text-accent-foreground',
                      )}
                    >
                      <Glyph id={s.id} className="size-6" />
                      {st === 'connected' && (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-card',
                            health.health === 'error'
                              ? 'bg-ember'
                              : health.health === 'warn'
                                ? 'bg-status-warn'
                                : 'bg-verdant',
                          )}
                        />
                      )}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </div>

        {/* Panel */}
        <div className="min-w-0">
          {active.kind === 'telegram' && (
            <TelegramPanel channelName={channelName(channelsData)} queryTab={tgTab} reconnectRequested={actionParam === 'reconnect'} />
          )}
          {active.kind === 'instagram' && <InstagramPanel />}
          {/* Панель источника скоупится на КАНАЛ ЭТОГО источника (когда он есть в workspace):
              статус/учётка/бэкфилл — атрибуты канала источника, а не активного канала свитчера —
              иначе подключённый на своём канале МС показывал «Доступен» + поле токена. */}
          {active.kind === 'moysklad' &&
            (msChannelId != null ? (
              <ChannelScope channelId={msChannelId}>
                <MoySkladPanel />
              </ChannelScope>
            ) : (
              <MoySkladPanel />
            ))}
          {/* Метрика — источник со МНОЖЕСТВОМ счётчиков: у каждого свой канал (сервер заводит его
              в /api/ym/connect и дедупит по counter_id). Приколачивать панель к ПЕРВОМУ ym-каналу
              через ChannelScope нельзя: тогда подключённый счётчик закрывает собой форму, и второй
              добавить нечем — панель сама держит список и адресует мутации поканально. */}
          {active.kind === 'metrika' && <MetrikaPanel channels={ymChannels} />}
          {active.kind === 'cdek' &&
            (cdekChannelId != null ? (
              <ChannelScope channelId={cdekChannelId}>
                <CdekPanel channelId={cdekChannelId} />
              </ChannelScope>
            ) : (
              <CdekPanel channelId={null} />
            ))}
          {/* Rusender — как Метрика, источник со МНОЖЕСТВОМ аккаунтов: у каждого свой канал
              (сервер заводит его в /api/rusender/connect и дедупит по accountId). Панель сама
              держит список и адресует мутации поканально, а не через ChannelScope. */}
          {active.kind === 'rusender' && <RusenderPanel channels={rusenderChannels} />}
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

// ── Starfield behind the compass (dark theme only — a night sky for celestial navigation).
// Sparse faint stars, a slow twinkle on some, two occasional shooting stars, radial-masked to
// glow around the orbit and fade at the edges. Motion is off under prefers-reduced-motion (the
// stars stay, static). Positions are randomised once per mount, so each visit gets a fresh sky.
function Starfield() {
  const stars = useMemo(
    () =>
      Array.from({ length: 42 }, () => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.random() * 1.4 + 0.7,
        op: Math.random() * 0.4 + 0.25,
        tw: Math.random() > 0.55,
        dur: Math.random() * 2.5 + 2.8,
        delay: Math.random() * 4,
      })),
    [],
  );
  const shooting = [
    { top: '8%', left: '16%', dur: '7s', delay: '2.4s' },
    { top: '4%', left: '48%', dur: '11s', delay: '6s' },
  ];
  const mask = 'radial-gradient(circle at 50% 46%, #000 32%, transparent 74%)';
  return (
    <div
      aria-hidden="true"
      className="starfield pointer-events-none absolute inset-0 hidden dark:block"
      style={{ maskImage: mask, WebkitMaskImage: mask } as CSSProperties}
    >
      {stars.map((st, i) => (
        <span
          key={i}
          className={cn('star', st.tw && 'star-tw')}
          style={{
            left: `${st.x}%`,
            top: `${st.y}%`,
            width: `${st.size}px`,
            height: `${st.size}px`,
            opacity: st.tw ? undefined : st.op,
            '--star-dur': `${st.dur}s`,
            '--star-delay': `${st.delay}s`,
          } as CSSProperties}
        />
      ))}
      {shooting.map((sh, i) => (
        <span
          key={`sh-${i}`}
          className="shooting"
          style={{ top: sh.top, left: sh.left, '--sh-dur': sh.dur, '--sh-delay': sh.delay } as CSSProperties}
        />
      ))}
    </div>
  );
}

// ── Panel header shared by every source ──
function PanelHead({ id, name, pill }: { id: ServiceId; name: string; pill: { label: string; tone: 'ok' | 'go' | 'warn' | 'mut' } }) {
  const tone =
    pill.tone === 'ok'
      ? 'border-verdant/45 text-verdant'
      : pill.tone === 'go'
        ? 'border-primary/45 text-primary'
        : pill.tone === 'warn'
          ? 'border-status-warn/45 text-status-warn'
        : 'border-border text-muted-foreground';
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border text-foreground">
        <Glyph id={id} className="size-5" />
      </span>
      <h2 className="flex-1 text-lg font-medium tracking-tight text-foreground">{name}</h2>
      <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-2xs font-medium uppercase tracking-wide', tone)}>
        {pill.label}
      </span>
    </div>
  );
}

// ── МойСклад: история заказов (бэкфилл с прогрессом — слайс 2б) ──
function MsBackfillBlock() {
  const qc = useQueryClient();
  // Канал панели (ChannelScope на /connect) — бэкфилл обязан стартовать на канале ИСТОЧНИКА.
  const { channelId } = useSelectedChannel();
  // kick = «только что нажали»: движок пишет running-строку ПОСЛЕ живой оценки объёма (~секунда),
  // поэтому сразу после POST статус ещё старый — и без принудительного поллинга интервал хука не
  // завёлся бы вовсе (кнопка выглядела мёртвой — прод-фидбек владельца).
  const [kick, setKick] = useState(false);
  // Статус на момент клика: любое ИЗМЕНЕНИЕ статуса (running/error/…) гасит kick и отдаёт рендер
  // настоящей ветке. Таймаут-страховка — на случай, если движок умер до первой записи state.
  const kickBaseRef = useRef<string | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const backfill = useMsBackfillStatus(true, kick);
  const st = backfill.data;

  useEffect(() => {
    const s = st?.status ?? null;
    if (kick && s !== null && s !== kickBaseRef.current) setKick(false);
    // Финиш прогона: витрины склада (средний чек, статусы заказов, когорты) читают ms_orders — обновить.
    if (prevStatusRef.current === 'running' && s === 'done') {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ms-') });
    }
    prevStatusRef.current = s;
  }, [st?.status, kick, qc]);
  useEffect(() => {
    if (!kick) return;
    const t = setTimeout(() => setKick(false), 30_000);
    return () => clearTimeout(t);
  }, [kick]);

  const startBackfill = async () => {
    setStartErr(null);
    kickBaseRef.current = st?.status ?? null;
    setKick(true);
    try {
      await apiSend('POST', '/api/ms/backfill', undefined, MsBackfillStartSchema, { channelId });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Прогон уже идёт (другая вкладка/повторный клик) — не ошибка: поллинг покажет прогресс.
      } else {
        setKick(false);
        setStartErr(err instanceof ApiError ? err.message : 'Не удалось запустить загрузку.');
        return;
      }
    }
    await qc.invalidateQueries({ queryKey: qk.msBackfill.all });
  };
  const monthLabel = (m?: string | null) =>
    m ? new Date(`${m}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }) : null;

  if (backfill.isPending || !st) return null;

  // Мгновенный отклик на клик: bare-состояние «запускаем» до первой записи движка.
  if (kick && st.status !== 'running') {
    return (
      <div className="rounded-xl border border-border bg-background p-3.5">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-foreground">Запускаем загрузку…</span>
          <span className="tabular-nums text-muted-foreground">оцениваем объём заказов</span>
        </div>
        <Progress className="mt-2 h-1.5" />
      </div>
    );
  }

  if (st.status === 'running') {
    const total = st.total && st.total > 0 ? st.total : null;
    const pct = total ? Math.min(100, Math.round((st.fetched / total) * 100)) : null;
    return (
      <div className="rounded-xl border border-border bg-background p-3.5">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-foreground">Загружаем историю заказов…</span>
          <span className="tabular-nums text-muted-foreground">
            {fmt.num(st.fetched)}
            {total ? ` из ~${fmt.num(total)}` : ''}
            {monthLabel(st.cursor_month) ? ` · ${monthLabel(st.cursor_month)}` : ''}
          </span>
        </div>
        {/* Строка загрузки (владелец): определённая при известном итоге, бегущая — при неизвестном. */}
        <Progress className="mt-2 h-1.5" value={pct ?? undefined} />
      </div>
    );
  }

  if (st.status === 'done') {
    // Done-состояние ОБЯЗАНО оставлять путь к повторному прогону (прод-фидбек владельца: после
    // слайса 3 аналитике статусов нужен state_id у старых строк, а кнопки не было — тупик). Повтор безопасен:
    // upsert заказов заменяющий, движок на done стартует заново.
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          История заказов загружена: <span className="font-medium tabular-nums text-foreground">{fmt.num(st.orders_in_db ?? st.fetched)}</span>{' '}
          — свежие заказы доливаются автоматически.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            data-mobile-touch-target=""
            onClick={() => void startBackfill()}
            className="btn-pill inline-flex min-h-11 items-center border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:min-h-0"
          >
            Обновить историю заказов
          </button>
          <span className="text-2xs text-muted-foreground">
            перечитает все заказы и обновит их последние статусы в аналитике
          </span>
        </div>
        {startErr && <p className="text-xs text-ember">{startErr}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-mobile-touch-target=""
        onClick={() => void startBackfill()}
        className="btn-pill inline-flex min-h-11 items-center border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:min-h-0"
      >
        Загрузить историю заказов
      </button>
      <p className="text-2xs text-muted-foreground">
        Разово выгрузим все заказы (у больших складов — со строкой прогресса); это откроет средний чек по истории,
        когорты и повторные покупки.
      </p>
      {(st.orders_in_db ?? 0) > 0 && (
        <p className="text-2xs text-muted-foreground">
          В архиве уже <span className="font-medium tabular-nums text-foreground">{fmt.num(st.orders_in_db ?? 0)}</span>{' '}
          заказов.
        </p>
      )}
      {/* start() при error сознательно начинает С НУЛЯ (resume-с-курсора — только для брошенных
          running); повтор безопасен — upsert заказов заменяющий. Не обещать «продолжит с места». */}
      {st.status === 'error' && (
        <p className="text-xs text-ember">
          Прошлая загрузка прервалась{st.error ? `: ${String(st.error)}` : ''} — запустите ещё раз, прогон начнётся
          заново (уже загруженное безопасно перезапишется).
        </p>
      )}
      {startErr && <p className="text-xs text-ember">{startErr}</p>}
    </div>
  );
}

// ── МойСклад: подключение по токену API ──
function MoySkladPanel() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const status = useMsStatus();
  // Канал панели (ChannelScope на /connect = канал источника). Мутации обязаны слать ЕГО явно:
  // apiSend без opts падает на глобальный стор свитчера — отключение/бэкфилл ушли бы не туда.
  const { channelId } = useSelectedChannel();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [freshOrg, setFreshOrg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Статус живёт на сервере (переживает перезагрузку страницы); freshOrg — мгновенный отклик
  // сразу после подключения, пока инвалидация статуса доезжает.
  const connected = freshOrg != null || (status.data?.connected ?? false);
  const orgName = freshOrg ?? status.data?.org_name ?? 'организация';

  const invalidateMs = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.channels }),
      qc.invalidateQueries({ queryKey: qk.msStatus.all }),
      qc.invalidateQueries({ queryKey: qk.msSummary.all }),
      qc.invalidateQueries({ queryKey: qk.msTopProducts.all }),
    ]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Токен уходит только на НАШ бэкенд (шифруется AES-256-GCM до записи) — в браузере,
      // логах и git он не живёт; в МойСклад ходит сервер.
      const res = await apiSend('POST', '/api/ms/connect', { token: value }, MsConnectSchema, { channelId });
      setFreshOrg(res?.org_name || 'организация');
      setToken('');
      toast('МойСклад подключён');
      await invalidateMs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить МойСклад.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    // Отключение необратимо в том смысле, который важен пользователю: зашифрованный токен
    // удаляется, и чтобы вернуться, надо снова идти за ним в кабинет МойСклада.
    const ok = await confirm({
      title: 'Отключить МойСклад?',
      reason: 'Токен доступа будет удалён, сбор данных остановится. Уже загруженная история заказов сохранится, но для возобновления понадобится снова получить токен в кабинете МойСклада.',
      actionLabel: 'Отключить',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend('DELETE', '/api/ms/account', undefined, MutationOkSchema, { channelId });
      setFreshOrg(null);
      toast('МойСклад отключён');
      await invalidateMs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отключить источник.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="moysklad"
        name="МойСклад"
        pill={connected ? { label: 'Подключён', tone: 'ok' } : { label: 'Доступен', tone: 'go' }}
      />
      {connected ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Подключена организация <b className="font-medium text-foreground">{orgName}</b>. Выручка, заказы и топ
            товаров уже считаются; дневной архив пополняется автоматически.
          </p>
          <MsBackfillBlock />
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link to="/sklad">Открыть Обзор склада →</Link>
            </Button>
            <button
              type="button"
              data-mobile-touch-target=""
              onClick={() => void disconnect()}
              disabled={busy}
              className="btn-pill inline-flex min-h-11 items-center border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50 sm:min-h-0"
            >
              Отключить
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-ember">{error}</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Продажи, заказы и прибыль из МойСклада — рядом с аналитикой каналов. Понадобится токен API: в МойСкладе
            откройте <b className="font-medium text-foreground">Настройки → Обмен данными → Токены API</b> и создайте токен.
          </p>
          <form onSubmit={submit} className="flex items-center gap-2">
            <label htmlFor="moysklad-api-token" className="sr-only">Токен API МойСклада</label>
            <input
              data-mobile-touch-target=""
              id="moysklad-api-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Токен API МойСклада"
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'moysklad-api-token-help moysklad-api-token-error' : 'moysklad-api-token-help'}
              className="h-11 min-w-0 flex-1 rounded border border-border bg-background px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:h-9"
            />
            <Button type="submit" disabled={!token.trim() || busy} className="shrink-0">
              {busy ? 'Проверяем…' : 'Подключить'}
            </Button>
          </form>
          {error && <p id="moysklad-api-token-error" role="alert" className="text-xs text-ember">{error}</p>}
          <p id="moysklad-api-token-help" className="text-2xs text-muted-foreground">
            Токен хранится только на сервере в зашифрованном виде (AES-256-GCM) и не попадает в логи.
          </p>
        </div>
      )}
    </div>
  );
}

// ── СДЭК Fulfillment: источник без API, наполняется загрузкой Excel ──
// Здесь нет ни токена, ни OAuth: «подключить» тут означает завести источник, после чего в него
// грузят выгрузки. Поэтому вместо поля секрета — имя, а вместо статуса связи — код склада и дата
// последней загрузки: у ручного источника свежесть данных задаёт человек, а не фоновый сбор.
function CdekPanel({ channelId }: { channelId: number | null }) {
  const status = useCdekStatus(channelId);
  const create = useCreateCdekSource();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connected = channelId != null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    setError(null);
    try {
      const res = await create.mutateAsync({ name: name.trim() || 'СДЭК' });
      setName('');
      toast(`Источник «${res.title ?? 'СДЭК'}» создан`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать источник.');
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="cdek"
        name="СДЭК"
        pill={connected ? { label: 'Подключён', tone: 'ok' } : { label: 'Доступен', tone: 'go' }}
      />
      {connected ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {status.data?.warehouse_code
              ? <>Склад <b className="font-medium text-foreground">{status.data.warehouse_code}</b>. </>
              : 'Склад определится по первой выгрузке. '}
            {status.data?.last_import?.created_at
              ? `Последняя выгрузка загружена ${fmt.date(status.data.last_import.created_at)}.`
              : 'Выгрузок пока не было — загрузите первую.'}
          </p>
          <Button asChild>
            <Link to="/cdek">Открыть загрузки →</Link>
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            У СДЭК Fulfillment нет открытого API, поэтому заказы приезжают выгрузкой: в личном кабинете выгрузите
            заказы за нужный период и загрузите файл сюда. Схема выгрузки известна — сопоставлять колонки руками не
            придётся.
          </p>
          <form onSubmit={submit} className="flex items-center gap-2">
            <label htmlFor="cdek-source-name" className="sr-only">Название источника</label>
            <input
              data-mobile-touch-target=""
              id="cdek-source-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название источника — например, «Склад Москва»"
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'cdek-source-error' : undefined}
              className="h-11 min-w-0 flex-1 rounded border border-border bg-background px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:h-9"
            />
            <Button type="submit" disabled={create.isPending} className="shrink-0">
              {create.isPending ? 'Создаём…' : 'Создать источник'}
            </Button>
          </form>
          {error && <p id="cdek-source-error" role="alert" className="text-xs text-ember">{error}</p>}
        </div>
      )}
    </div>
  );
}

// ── Rusender: аккаунты email-рассылок (подключение по API-ключу) ──
// Устройство как у Метрики: один аккаунт = один канал, сервер дедупит их по accountId, поэтому
// панель — СПИСОК, а форма подключения доступна всегда, а не только пока пусто.

/** Строка подключённого аккаунта: email из учётки, переход на его Обзор и отключение. */
function RusenderAccountRow({
  channelId,
  title,
  onChanged,
  onReconnect,
}: {
  channelId: number;
  title: string;
  onChanged: () => Promise<unknown>;
  /** Вернуть аккаунт В ЭТОТ канал: у него остался архив, ради которого «Отключить» его и щадит. */
  onReconnect: (channelId: number) => void;
}) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { setChannelId } = useSelectedChannel();
  const status = useRusenderStatus(channelId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = status.data?.connected ?? false;
  const name = status.data?.account_email ?? title;
  const missing = status.data?.missing_scopes ?? [];

  const disconnect = async () => {
    if (busy) return;
    const ok = await confirm({
      title: `Отключить аккаунт «${name}»?`,
      reason:
        'Ключ будет удалён, сбор остановится. Уже загруженный архив рассылок и базы сохранится — источник останется в списке, и аккаунт можно будет подключить в него заново.',
      actionLabel: 'Отключить',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend('DELETE', '/api/rusender/account', undefined, MutationOkSchema, { channelId });
      toast('Аккаунт отключён');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отключить аккаунт.');
    } finally {
      setBusy(false);
    }
  };

  // Переход обязан ПЕРЕКЛЮЧИТЬ источник, иначе «Открыть» у второго аккаунта привело бы на обзор
  // первого: страница читает канал из свитчера, а не из ссылки (урок #539).
  const open = () => {
    setChannelId(channelId);
    navigate('/rusender');
  };

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium text-foreground">{name}</span>
      </span>
      {connected ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={open}>
            Открыть
          </Button>
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void disconnect()}>
            Отключить
          </Button>
        </span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Аккаунт отключён, архив сохранён</span>
          {/* «Подключить СНОВА», а не «Подключить»: рядом стоит кнопка формы с этим словом. */}
          <Button type="button" variant="ghost" size="xs" onClick={() => onReconnect(channelId)}>
            Подключить снова
          </Button>
        </span>
      )}
      {/* Разрешения могли отозвать уже ПОСЛЕ подключения — источник жив, но собирать ему нечем.
          Молчать об этом значит оставить владельца наедине с пустеющим обзором. */}
      {connected && missing.length > 0 && (
        <p role="alert" className="w-full text-xs text-status-warn">
          Ключу не хватает разрешений: {missing.join(', ')} — сбор не наполняется.
        </p>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-ember">
          {error}
        </p>
      )}
    </li>
  );
}

function RusenderPanel({ channels }: { channels: Channel[] }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Форма второго аккаунта открывается по кнопке: пока подключён хотя бы один, показывать поле
  // ключа постоянно значит предлагать работу там, где её обычно нет.
  const [adding, setAdding] = useState(false);
  // Куда подключаем: null — «заведи новый канал», число — вернуть аккаунт в УЖЕ существующий
  // источник (у него остался архив от прошлого подключения).
  const [attachTo, setAttachTo] = useState<number | null>(null);
  const connected = channels.length > 0;
  const formOpen = !connected || adding;

  const invalidateRusender = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.channels }),
      qc.invalidateQueries({ queryKey: rusenderKeys.all }),
    ]);

  const connect = async () => {
    const value = apiKey.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Ключ уходит только на НАШ бэкенд (шифруется AES-256-GCM до записи) — в браузере, логах и
      // git он не живёт; в Rusender ходит сервер.
      // channelId: null — «заведи новый канал под этот аккаунт». Явный null, а не пропуск: без
      // него apiSend подставит канал свитчера, и аккаунт приклеился бы к чужому источнику.
      const res = await apiSend(
        'POST',
        '/api/rusender/connect',
        { api_key: value },
        RusenderConnectSchema,
        { channelId: attachTo },
      );
      setApiKey('');
      setAdding(false);
      setAttachTo(null);
      toast(`Аккаунт «${res?.account_email || 'Rusender'}» подключён`);
      await invalidateRusender();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить Rusender.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void connect();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="rusender"
        name="Rusender"
        pill={connected ? { label: 'Подключён', tone: 'ok' } : { label: 'Доступен', tone: 'go' }}
      />
      <div className="mt-4 space-y-4">
        {connected ? (
          <ul className="space-y-2">
            {channels.map((channel) => (
              <RusenderAccountRow
                key={channel.id}
                channelId={channel.id}
                title={channel.title ?? 'Аккаунт'}
                onChanged={invalidateRusender}
                onReconnect={(id) => {
                  setAttachTo(id);
                  setAdding(true);
                  setError(null);
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Rusender — сервис email-рассылок. Подключите аккаунт по API-ключу, и сюда приедут рассылки с их
            открытиями и кликами, а также размер базы контактов.
          </p>
        )}

        {connected && !formOpen && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAttachTo(null);
              setAdding(true);
            }}
          >
            Добавить аккаунт
          </Button>
        )}

        {formOpen && (
          <div className="space-y-3">
            <form onSubmit={submit} className="flex items-center gap-2">
              <label htmlFor="rusender-api-key" className="sr-only">
                API-ключ Rusender
              </label>
              <input
                data-mobile-touch-target=""
                id="rusender-api-key"
                // type=password: ключ — секрет, и он не должен светиться на экране при демонстрации
                // или скриншоте. autoComplete=off — менеджеру паролей тут не место.
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="rs_ck_v1_…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'rusender-api-key-error' : 'rusender-api-key-help'}
                className="h-11 min-w-0 flex-1 rounded border border-border bg-background px-3 font-mono text-sm text-foreground outline-hidden placeholder:font-sans placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:h-9"
              />
              <Button type="submit" disabled={busy || !apiKey.trim()} className="shrink-0">
                {busy ? 'Проверяем…' : 'Подключить'}
              </Button>
              {connected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    setAdding(false);
                    setAttachTo(null);
                    setError(null);
                  }}
                >
                  Отмена
                </Button>
              )}
            </form>
            {error && (
              <p id="rusender-api-key-error" role="alert" className="text-xs text-ember">
                {error}
              </p>
            )}
            <p id="rusender-api-key-help" className="text-2xs text-muted-foreground">
              Ключ создаётся в кабинете Rusender. Ему нужны разрешения <code className="font-mono">campaigns.read</code>{' '}
              и <code className="font-mono">contacts.read</code> — без них подключение не пройдёт. Ключ хранится только
              на сервере в зашифрованном виде (AES-256-GCM) и не попадает в логи.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Яндекс.Метрика: счётчики (+ выбор счётчика при нескольких на токене) ──
// У Метрики МНОЖЕСТВО источников: один счётчик = один канал, сервер дедупит их по counter_id.
// Поэтому панель — список, а форма подключения доступна ВСЕГДА, а не только пока пусто.

/** Строка подключённого счётчика: имя из учётки, переход на его Обзор и отключение. */
function YmCounterRow({
  channelId,
  title,
  onChanged,
  onReconnect,
}: {
  channelId: number;
  title: string;
  onChanged: () => Promise<unknown>;
  /** Вернуть счётчик В ЭТОТ канал: у него остался дневной архив, ради которого «Отключить» его и щадит. */
  onReconnect: (channelId: number) => void;
}) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { setChannelId } = useSelectedChannel();
  const status = useYmStatus(channelId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = status.data?.connected ?? false;
  const name = status.data?.counter_name ?? status.data?.site ?? title;

  const disconnect = async () => {
    if (busy) return;
    const ok = await confirm({
      title: `Отключить счётчик «${name}»?`,
      reason: 'OAuth-доступ к этому счётчику будет отозван, сбор остановится. Уже загруженный дневной архив сохранится — источник останется в списке, и счётчик можно будет подключить в него заново.',
      actionLabel: 'Отключить',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend('DELETE', '/api/ym/account', undefined, MutationOkSchema, { channelId });
      toast('Счётчик отключён');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отключить счётчик.');
    } finally {
      setBusy(false);
    }
  };

  // Переход обязан ПЕРЕКЛЮЧИТЬ источник, иначе «Открыть» у второго счётчика привело бы на обзор
  // первого: страница читает канал из свитчера, а не из ссылки.
  const open = () => {
    setChannelId(channelId);
    navigate('/metrika');
  };

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium text-foreground">{name}</span>
        {status.data?.site && status.data.site !== name && (
          <span className="text-muted-foreground"> · {status.data.site}</span>
        )}
      </span>
      {connected ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={open}>
            Открыть
          </Button>
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void disconnect()}>
            Отключить
          </Button>
        </span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Счётчик отключён, архив сохранён</span>
          {/* «Подключить СНОВА», а не «Подключить»: рядом на том же экране стоит кнопка формы с
              этим словом, и два одинаковых действия читались бы как одно. */}
          <Button type="button" variant="ghost" size="xs" onClick={() => onReconnect(channelId)}>
            Подключить снова
          </Button>
        </span>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-ember">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * «Где взять токен» — инструкция ВНУТРИ панели, а не ссылка «читайте документацию». Раньше здесь
 * стояла одна фраза «выпустить его можно на oauth.yandex.ru для своего приложения»: она называет
 * место, но не говорит ни какое право отметить, ни какой Redirect URI вписать, ни где в итоге
 * искать сам токен — а без любого из трёх шаг не проходится.
 *
 * Последний шаг собирает ссылку выдачи ЗА человека: адрес авторизации отличается от обычного
 * только идентификатором приложения, и склеивать его руками в адресной строке — ровно то место,
 * где инструкции обычно и рвутся.
 */
function YmTokenGuide({ open }: { open: boolean }) {
  const [clientId, setClientId] = useState('');
  const id = clientId.trim();
  // ClientID Яндекса — 32 шестнадцатеричных знака. Проверяем форму, чтобы не звать человека по
  // заведомо битой ссылке (Яндекс ответит «unknown client», и он решит, что ошибся правами).
  const ready = /^[0-9a-fA-F]{32}$/.test(id);
  const authUrl = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${id}`;
  return (
    <details open={open} className="group rounded-lg border border-border bg-muted/30">
      <summary
        data-mobile-touch-target=""
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden sm:min-h-0"
      >
        <svg
          viewBox="0 0 16 16"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Где взять токен — три минуты
      </summary>
      <ol className="list-decimal space-y-3 py-1 pl-8 pr-3 text-sm leading-relaxed text-muted-foreground marker:font-medium marker:text-foreground">
        <li>
          <span className="font-medium text-foreground">Создайте приложение.</span> На Яндекс OAuth выберите
          вариант «Для API-доступа или отладки». Название любое — оно нужно только вам.
          <div className="mt-2">
            <Button asChild variant="outline" size="sm">
              <a href="https://oauth.yandex.ru/?dialog=create-client-entry" target="_blank" rel="noreferrer noopener">
                Открыть Яндекс OAuth ↗
              </a>
            </Button>
          </div>
        </li>
        <li>
          <span className="font-medium text-foreground">Отметьте одно право:</span> <Code>metrika:read</Code> —
          «Получение статистики, данных о параметрах своих счётчиков». Право на запись не нужно: Atlavue только
          читает.
        </li>
        <li>
          <span className="font-medium text-foreground">В поле «Redirect URI» вставьте этот адрес.</span> Он
          служебный: на него Яндекс вернёт готовый токен.
          <Snippet className="mt-2" value="https://oauth.yandex.ru/verification_code" />
        </li>
        <li>
          <span className="font-medium text-foreground">Выпустите токен.</span> Скопируйте ClientID созданного
          приложения сюда — соберём ссылку за вас:
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor="yandex-client-id" className="sr-only">ClientID приложения Яндекса</label>
            <input
              data-mobile-touch-target=""
              id="yandex-client-id"
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="ClientID — 32 знака"
              autoComplete="off"
              spellCheck={false}
              // На телефоне поле занимает СВОЮ строку, а кнопка переносится под него: рядом с
              // широкой кнопкой на 430px в поле оставалось ~90px — в ClientID из 32 знаков виден
              // огрызок, и проверить вставленное нечем.
              className="h-11 w-full min-w-0 rounded border border-border bg-background px-3 font-mono text-xs text-foreground outline-hidden placeholder:font-sans placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:h-9 sm:w-auto sm:flex-1"
            />
            {ready ? (
              <Button asChild size="sm" className="shrink-0">
                <a href={authUrl} target="_blank" rel="noreferrer noopener">
                  Открыть страницу выдачи ↗
                </a>
              </Button>
            ) : (
              <Button size="sm" className="shrink-0" disabled>
                Открыть страницу выдачи ↗
              </Button>
            )}
          </div>
          <p className="mt-2">
            Открывайте под тем аккаунтом Яндекса, у которого есть доступ к счётчику. Нажмите «Разрешить» — токен
            появится в адресной строке после <Code>#access_token=</Code>.
          </p>
        </li>
        <li>
          <span className="font-medium text-foreground">Вставьте токен в поле ниже</span> — и всё, счётчик
          подключён. Токен живёт около года; когда истечёт, повторите четвёртый шаг и нажмите «Подключить снова» у
          нужного счётчика — он вернётся в свой источник вместе с архивом.
        </li>
      </ol>
    </details>
  );
}

function MetrikaPanel({ channels }: { channels: Channel[] }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Форма второго счётчика открывается по кнопке: пока подключён хотя бы один, показывать поле
  // токена постоянно значит предлагать работу там, где её обычно нет.
  const [adding, setAdding] = useState(false);
  // Куда подключаем: null — «заведи новый канал», число — вернуть счётчик в УЖЕ существующий
  // источник (у него остался дневной архив от прошлого подключения).
  const [attachTo, setAttachTo] = useState<number | null>(null);
  // Несколько счётчиков на аккаунте: сервер отвечает choice_required + список (id/имя/сайт —
  // не секреты), клиент повторяет connect с выбранным counter_id. Токен остаётся в памяти
  // формы между шагами и уходит только на НАШ бэкенд.
  const [counters, setCounters] = useState<Array<{ id: string; name: string | null; site: string | null }> | null>(null);
  const connected = channels.length > 0;
  const formOpen = !connected || adding;

  // ВСЕ семьи Метрики, а не три: разрезы кэшируются на 5 минут, и после смены счётчика
  // четырнадцать неинвалидированных карточек продолжали бы показывать данные ПРЕДЫДУЩЕГО
  // счётчика. Список живёт в qk.ymAll — новая семья попадает сюда сама.
  const invalidateYm = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.channels }),
      ...qk.ymAll.map((key) => qc.invalidateQueries({ queryKey: key })),
    ]);

  const connect = async (counterId?: string) => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Токен уходит только на НАШ бэкенд (шифруется AES-256-GCM до записи) — в браузере,
      // логах и git он не живёт; в Яндекс ходит сервер.
      // channelId: null — «заведи новый канал под этот счётчик». Явный null, а не пропуск:
      // без него apiSend подставит канал свитчера, и счётчик приклеился бы к чужому источнику.
      const res = await apiSend(
        'POST',
        '/api/ym/connect',
        counterId ? { token: value, counter_id: counterId } : { token: value },
        YmConnectSchema,
        { channelId: attachTo },
      );
      if (res?.choice_required) {
        setCounters(Array.isArray(res.counters) ? res.counters : []);
        return;
      }
      setToken('');
      setCounters(null);
      setAdding(false);
      setAttachTo(null);
      toast(`Счётчик «${res?.counter_name || res?.site || 'Метрика'}» подключён`);
      await invalidateYm();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить Яндекс.Метрику.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void connect();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="metrika"
        name="Яндекс.Метрика"
        pill={connected ? { label: 'Подключена', tone: 'ok' } : { label: 'Доступна', tone: 'go' }}
      />
      <div className="mt-4 space-y-4">
        {connected ? (
          <ul className="space-y-2">
            {channels.map((channel) => (
              <YmCounterRow
                key={channel.id}
                channelId={channel.id}
                title={channel.title ?? 'Счётчик'}
                onChanged={invalidateYm}
                onReconnect={(id) => {
                  setAttachTo(id);
                  setAdding(true);
                  setError(null);
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Трафик сайта встанет рядом с аналитикой каналов: визиты, посетители, источники и цели — в тех же
            карточках и за тот же период. Нужен один OAuth-токен Яндекса; ниже по шагам, как его выпустить.
          </p>
        )}

        {connected && !formOpen && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            Добавить счётчик
          </Button>
        )}

        {formOpen && (
          <div className="space-y-4">
            {connected && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {attachTo != null
                  ? 'Счётчик вернётся в этот же источник — вместе с уже загруженным дневным архивом.'
                  : 'Второй счётчик встанет отдельным источником — его видно в переключателе рядом с первым. Токен подойдёт тот же, если счётчики на одном аккаунте Яндекса: дальше спросим, какой подключить. Если аккаунты разные — выпустите второй токен по шагам ниже.'}
              </p>
            )}
            <YmTokenGuide open={!connected} />
            <form onSubmit={submit} className="flex items-center gap-2">
              <label htmlFor="yandex-metrika-token" className="sr-only">OAuth-токен Яндекса</label>
              <input
                data-mobile-touch-target=""
                id="yandex-metrika-token"
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setCounters(null);
                }}
                placeholder="OAuth-токен Яндекса"
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'yandex-metrika-token-help yandex-metrika-token-error' : 'yandex-metrika-token-help'}
                className="h-11 min-w-0 flex-1 rounded border border-border bg-background px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:h-9"
              />
              <Button type="submit" disabled={!token.trim() || busy} className="shrink-0">
                {busy ? 'Проверяем…' : 'Подключить'}
              </Button>
              {connected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={busy}
                  onClick={() => {
                    setAdding(false);
                    setAttachTo(null);
                    setToken('');
                    setCounters(null);
                    setError(null);
                  }}
                >
                  Отмена
                </Button>
              )}
            </form>
            {counters && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {counters.length
                    ? 'На аккаунте несколько счётчиков — выберите, какой подключить:'
                    : 'На аккаунте не нашлось счётчиков Метрики.'}
                </p>
                {counters.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-mobile-touch-target=""
                    disabled={busy}
                    onClick={() => void connect(c.id)}
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:border-primary/60 hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:min-h-0 sm:items-baseline"
                  >
                    <span className="min-w-0 truncate font-medium text-foreground">{c.name ?? c.site ?? `Счётчик ${c.id}`}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{c.site ?? c.id}</span>
                  </button>
                ))}
              </div>
            )}
            <p id="yandex-metrika-token-help" className="text-2xs leading-relaxed text-muted-foreground">
              Токен уходит только на наш сервер: там он шифруется (AES-256-GCM), в логи и в браузер не попадает, а
              в Яндекс за данными ходит сервер. Отозвать доступ можно в любой момент — кнопкой «Отключить».
            </p>
          </div>
        )}
        {error && <p id="yandex-metrika-token-error" role="alert" className="text-xs text-ember">{error}</p>}
      </div>
    </div>
  );
}

// ── Instagram: real OAuth ──
function InstagramPanel() {
  const confirm = useConfirm();
  const { channelId } = useSelectedChannel();
  const status = useIgOauthStatus();
  const connect = useConnectIg();
  const disconnect = useDisconnectIg();
  const connected = status.data?.connected ?? false;
  // A global env IG account (IG_ACCESS_TOKEN/IG_ACCOUNT_ID) is serving data even without a
  // per-channel OAuth connection — real numbers are flowing, so this is NOT «не настроено».
  const envAccount = status.data?.env_fallback ?? false;
  const serverReady = status.data?.server_ready ?? false;
  const notReady = status.isSuccess && !serverReady;
  const connectError = connect.error instanceof Error ? connect.error.message : null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead
        id="instagram"
        name="Instagram"
        pill={connected ? { label: 'Подключён', tone: 'ok' } : envAccount ? { label: 'Общий аккаунт', tone: 'ok' } : { label: 'Доступен', tone: 'go' }}
      />

      {channelId == null ? (
        <p className="mt-4 text-sm text-muted-foreground">Сначала выберите канал в переключателе источника слева вверху.</p>
      ) : connected ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Подключён бизнес-аккаунт <span className="font-mono text-foreground">@{status.data?.username}</span>. Реальные охваты,
            аудитория и публикации этого канала идут из Instagram.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {serverReady && (
              <Button
                type="button"
                onClick={() => connect.mutate({ newSource: true })}
                pending={connect.isPending}
                disabled={connect.isPending}
              >
                {connect.isPending ? 'Открытие Instagram…' : 'Подключить ещё один аккаунт'}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void (async () => {
                  const ok = await confirm({
                    title: 'Отключить Instagram?',
                    reason: 'OAuth-доступ к аккаунту будет отозван, сбор остановится. Уже загруженная история сохранится, но для возобновления понадобится заново пройти авторизацию Instagram.',
                    actionLabel: 'Отключить',
                  });
                  if (ok) disconnect.mutate(undefined, { onSuccess: () => toast('Instagram отключён') });
                })();
              }}
              pending={disconnect.isPending}
              disabled={disconnect.isPending}
              className="text-muted-foreground hover:text-destructive"
            >
              {disconnect.isPending ? 'Отключение…' : 'Отключить'}
            </Button>
          </div>
          {serverReady && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ещё один аккаунт появится отдельным источником в переключателе — войдите в НЕГО в
              Instagram перед подтверждением (или смените профиль в окне подключения).
            </p>
          )}
          {connectError && <p role="alert" className="text-xs font-medium text-destructive">{connectError}</p>}
        </div>
      ) : envAccount ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-verdant" />
            <span className="text-foreground">Подключён общий аккаунт</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Instagram-аналитика уже идёт из аккаунта, настроенного на сервере — охваты, аудитория и
            публикации доступны в разделе Instagram.
          </p>
          {serverReady && (
            <>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Можно подключить <b className="font-medium text-foreground">свой</b> бизнес-аккаунт к
                этому каналу вместо общего:
              </p>
              <Button
                type="button"
                onClick={() => connect.mutate()}
                pending={connect.isPending}
                disabled={connect.isPending}
                size="lg"
                className="px-5"
              >
                {connect.isPending ? 'Открытие Instagram…' : 'Подключить свой аккаунт'}
              </Button>
              {connectError && <p role="alert" className="text-xs font-medium text-destructive">{connectError}</p>}
            </>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Вход через Instagram — один клик. Нужен аккаунт <b className="font-medium text-foreground">Business</b> или{' '}
            <b className="font-medium text-foreground">Creator</b> (не личный). Facebook-страница не требуется.
          </p>
          <Button
            type="button"
            onClick={() => connect.mutate()}
            pending={connect.isPending}
            disabled={connect.isPending || notReady}
            size="lg"
            className="px-5"
          >
            {connect.isPending ? 'Открытие Instagram…' : 'Войти через Instagram'}
          </Button>
          {connectError && <p role="alert" className="text-xs font-medium text-destructive">{connectError}</p>}
          {notReady && (
            <p className="text-xs text-muted-foreground">
              Подключение Instagram ещё не настроено на сервере.
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

// ── Telegram: hybrid connect — QR by default, collector agent for pro ──
// The public status shape (incl. connection_state health) lives in api/schemas as TgQrStatusSchema and
// is read through the shared useTgQrStatus() query — no private duplicate here.
const QrStartSchema = z.object({ id: z.string(), url: z.string(), expires_in: z.coerce.number().optional() }).passthrough();
const QrChannelSchema = z
  .object({
    id: z.coerce.number(),
    title: z.string().optional(),
    username: z.string().nullish(),
    broadcast: z.boolean().optional(),
    megagroup: z.boolean().optional(),
    creator: z.boolean().optional(),
    participants: z.coerce.number().nullish(),
    eligible: z.boolean().optional(),
  })
  .passthrough();
const QrPollSchema = z
  .object({ status: z.string(), url: z.string().nullish(), username: z.string().nullish(), channels: z.array(QrChannelSchema).optional(), error: z.string().nullish() })
  .passthrough();
const OkSchema = z.object({ ok: z.boolean().optional() }).passthrough();
const AddChannelsSchema = z
  .object({ ok: z.boolean().optional(), added: z.coerce.number().optional(), skipped: z.coerce.number().optional() })
  .passthrough();

interface QrChannel {
  id: number;
  title?: string;
  username?: string | null;
  broadcast?: boolean;
  megagroup?: boolean;
  creator?: boolean;
  participants?: number | null;
  eligible?: boolean;
}

// A channel is collectable when it's a broadcast channel. `eligible === undefined` (a channel from
// an older mtproto build that didn't send the flag) is treated as eligible so nothing is hidden.
const isEligible = (c: QrChannel) => c.eligible !== false;

/**
 * Telegram connect: «QR-вход» (managed — scan and done) by default, «Через агента» (collector,
 * privacy-first, session stays on the user's machine) as the pro tab. The QR flow starts a login
 * on the server, renders the QR, and polls until the scan completes (with a 2FA-password step);
 * the session is captured + stored server-side (never touches the browser).
 */
function TelegramPanel({
  channelName,
  queryTab,
  reconnectRequested,
}: {
  channelName: string | null;
  queryTab?: 'qr' | 'agent' | null;
  reconnectRequested?: boolean;
}) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  // Shared status (same ['tg-qr-status'] cache the Overview banner reads). The live login flow below
  // keeps LOCAL state (phase/qrImg/captured channels) — a scan-in-progress overrides the shared
  // snapshot — but the baseline connected/server_ready/connection_state comes from the query, and on
  // success/disconnect we invalidate it so every reader (incl. the Overview) drops the old state.
  const qrQuery = useTgQrStatus();
  const status = qrQuery.data;
  const serverReady = status?.server_ready ?? false;
  const connected = status?.connected ?? false;
  const reauthRequired = status?.connection_state === 'reauth_required';

  const [tab, setTab] = useState<'qr' | 'agent'>(queryTab === 'agent' ? 'agent' : 'qr');
  useEffect(() => {
    if (queryTab === 'qr' || queryTab === 'agent') setTab(queryTab);
  }, [queryTab]);

  const [phase, setPhase] = useState<'idle' | 'scanning' | 'password' | 'done'>('idle');
  const [qrImg, setQrImg] = useState<string | null>(null);
  const [channels, setChannels] = useState<QrChannel[]>([]);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startRetrying, setStartRetrying] = useState(false);
  // A successful replacement login clears the focused reconnect callout locally (before the shared
  // status refetch lands), so the user immediately sees the fresh connected/channels view.
  const [reconnectDone, setReconnectDone] = useState(false);
  // Username captured by the just-completed scan — the shared status refetch may not have landed yet.
  const [doneUser, setDoneUser] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);
  const failRef = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollRef.current) window.clearTimeout(pollRef.current);
      // Reclaim a still-pending login server-side when the user navigates away.
      if (idRef.current) apiSend('POST', '/api/tg/qr/cancel', { id: idRef.current }, OkSchema).catch(() => {});
    };
  }, []);

  const stopPoll = () => {
    if (pollRef.current) { window.clearTimeout(pollRef.current); pollRef.current = null; }
  };

  const refreshStatus = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.tgQrStatus }),
      qc.invalidateQueries({ queryKey: qk.channels }),
    ]);

  const onConnected = (username: string | null, chans: QrChannel[]) => {
    stopPoll();
    idRef.current = null;
    setQrImg(null);
    setPassword('');
    setChannels(chans);
    setDoneUser(username);
    setPhase('done');
    setReconnectDone(true);
    // saveTgSession upserted the fresh session server-side (channels/history preserved) — pull the
    // new health so 'reauth_required' can't linger anywhere it's read.
    void refreshStatus();
  };

  const poll = async () => {
    const id = idRef.current;
    if (!id || !alive.current) return;
    try {
      const r = await apiSend('POST', '/api/tg/qr/poll', { id }, QrPollSchema);
      if (!alive.current) return;
      failRef.current = 0;
      if (r.status === 'ok') return onConnected(r.username ?? null, (r.channels ?? []) as QrChannel[]);
      if (r.status === 'password') return setPhase('password');
      if (r.status === 'expired') return void start();
      if (r.status === 'error') { setErr(r.error || 'Не удалось войти — попробуйте ещё раз'); setPhase('idle'); return; }
      if (r.status === 'pending') {
        // The server rotates the QR token as it expires — re-render when the url changes.
        if (r.url && r.url !== urlRef.current) {
          urlRef.current = r.url;
          QRCode.toDataURL(r.url, { margin: 1, width: 208 }).then((img) => { if (alive.current) setQrImg(img); }).catch(() => {});
        }
        pollRef.current = window.setTimeout(poll, 2500);
        return;
      }
      setErr('Непонятный ответ сервера'); // unknown status → stop instead of polling forever
      setPhase('idle');
    } catch {
      if (!alive.current) return;
      failRef.current += 1;
      if (failRef.current > 6) { setErr('Соединение прервалось — попробуйте снова'); setPhase('idle'); return; }
      pollRef.current = window.setTimeout(poll, 2500);
    }
  };

  const start = async () => {
    setErr(null);
    setBusy(true);
    setStartRetrying(false);
    setChannels([]);
    try {
      let r: z.infer<typeof QrStartSchema>;
      try {
        r = await apiSend('POST', '/api/tg/qr/start', undefined, QrStartSchema);
      } catch (e) {
        // Retry a cold service once, but respect explicit server backpressure. Retrying a capacity
        // response would amplify the onboarding spike that the admission limit is protecting from.
        if (!(e instanceof ApiError) || e.status !== 503 || e.retryAfter != null || !alive.current) throw e;
        setStartRetrying(true);
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        if (!alive.current) return;
        r = await apiSend('POST', '/api/tg/qr/start', undefined, QrStartSchema);
      }
      const img = await QRCode.toDataURL(r.url, { margin: 1, width: 208 });
      if (!alive.current) return;
      idRef.current = r.id;
      urlRef.current = r.url;
      failRef.current = 0;
      setQrImg(img);
      setPhase('scanning');
      setBusy(false);
      setStartRetrying(false);
      stopPoll();
      pollRef.current = window.setTimeout(poll, 2500);
    } catch (e) {
      if (!alive.current) return;
      setBusy(false);
      setStartRetrying(false);
      // Prefer the server's translated message (backpressure like the 40-login cap comes back as a
      // truthful "too busy, retry in a minute" — distinct from a real outage). Raw snake_case codes
      // have no spaces, so fall back to generic copy for those rather than leaking a code to the UI.
      const serverMsg = e instanceof ApiError ? e.message : '';
      setErr(/\s/.test(serverMsg)
        ? serverMsg
        : e instanceof ApiError && e.status === 503
          ? 'Не удалось подготовить QR-код. Telegram пока недоступен — попробуйте ещё раз.'
          : e instanceof Error ? e.message : 'Не удалось начать вход');
    }
  };

  const submitPassword = async () => {
    const id = idRef.current;
    if (!id || !password) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiSend('POST', '/api/tg/qr/password', { id, password }, QrPollSchema);
      if (!alive.current) return;
      setBusy(false);
      if (r.status === 'ok') return onConnected(r.username ?? null, (r.channels ?? []) as QrChannel[]);
      if (r.error === 'bad_password') return setErr('Неверный пароль');
      if (r.status === 'expired') { setErr('Код устарел — начните заново'); setPhase('idle'); return; }
      if (r.status === 'error') { setErr('Не удалось войти — начните заново'); setPhase('idle'); return; }
      setErr(r.error || 'Не удалось войти — попробуйте ещё раз');
    } catch (e) {
      if (!alive.current) return;
      setBusy(false);
      setErr(e instanceof Error ? e.message : 'Не удалось войти — попробуйте ещё раз');
    }
  };

  const disconnect = async () => {
    // Самое дорогое отключение в продукте: managed QR-сессия ОБЩАЯ для всех каналов владельца,
    // и её нельзя восстановить — только войти заново по QR с телефона. Поэтому здесь не просто
    // подтверждение, а type-to-confirm (тот же приём, что у удаления канала).
    const ok = await confirm({
      title: 'Отключить Telegram?',
      reason: 'Сессия будет удалена, и сбор остановится СРАЗУ ПО ВСЕМ каналам этого подключения. Восстановить её нельзя — понадобится заново войти по QR-коду с телефона. Каналы и уже собранная история сохранятся.',
      actionLabel: 'Отключить Telegram',
      typeToConfirm: 'Telegram',
      typeToConfirmLabel: 'Введите «Telegram», чтобы подтвердить',
    });
    if (!ok) return;
    setBusy(true);
    // Тост — только при удачном DELETE; провал молча игнорируется (сессия и так мертва), не тостить.
    try {
      await apiSend('DELETE', '/api/tg/qr/session', undefined, OkSchema);
      toast('Telegram отключён');
    } catch { /* ignore */ }
    if (!alive.current) return;
    setBusy(false);
    setPhase('idle');
    setChannels([]);
    setDoneUser(null);
    setReconnectDone(true);
    void refreshStatus();
  };

  // A login in progress (scan/password) overrides EVERYTHING — during a replacement login the old
  // session may still read as connected, but the QR/password UI must be what's on screen. Reconnect
  // focus fires on an explicit ?action=reconnect OR a server-reported reauth_required, until a
  // successful scan/disconnect clears it locally.
  const loginActive = phase === 'scanning' || phase === 'password';
  const wantReconnect = (reauthRequired || !!reconnectRequested) && !reconnectDone;
  // Never show a green «Подключён» pill as the primary signal while a re-login is required.
  const pillConnected = phase === 'done' || (connected && !reauthRequired);
  const pill = pillConnected
    ? { label: 'Подключён', tone: 'ok' as const }
    : reauthRequired
      ? { label: 'Требуется вход', tone: 'warn' as const }
      : { label: 'Доступен', tone: 'go' as const };

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <PanelHead id="telegram" name="Telegram" pill={pill} />

      <div className="mt-4 flex gap-1 border-b border-border">
        <TgTab active={tab === 'qr'} onClick={() => setTab('qr')}>QR-вход</TgTab>
        <TgTab active={tab === 'agent'} onClick={() => setTab('agent')}>Через агента</TgTab>
      </div>

      {tab === 'qr' ? (
        <div className="mt-5">
          {qrQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Загрузка…</p>
          ) : !serverReady ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Вход по QR ещё не настроен на сервере. Пока можно подключиться на вкладке «Через агента».
            </p>
          ) : loginActive ? (
            <TgScanning
              img={qrImg}
              phase={phase === 'password' ? 'password' : 'scanning'}
              password={password}
              setPassword={setPassword}
              onSubmit={submitPassword}
              err={err}
              busy={busy}
            />
          ) : phase === 'done' ? (
            <TgConnected username={doneUser} channels={channels} onDisconnect={disconnect} busy={busy} />
          ) : wantReconnect ? (
            <TgReconnect
              reauth={reauthRequired}
              username={status?.username ?? null}
              onReconnect={start}
              busy={busy}
              startRetrying={startRetrying}
              err={err}
            />
          ) : connected ? (
            <TgConnected username={status?.username ?? null} channels={channels} onDisconnect={disconnect} busy={busy} />
          ) : (
            <div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Отсканируйте QR-код в своём Telegram — каналы, где вы админ, подключатся автоматически. Устанавливать ничего не нужно.
              </p>
              <Button type="button" onClick={start} disabled={busy} size="lg" className="mt-4 px-5">
                {busy ? (startRetrying ? 'Telegram запускается…' : 'Подготовка кода…') : 'Показать QR-код'}
              </Button>
              {err && <p role="alert" className="mt-3 text-xs font-medium text-destructive">{err}</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5">
          <CollectorGuide channelName={channelName} />
        </div>
      )}
    </div>
  );
}

function TgTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-mobile-touch-target=""
      onClick={onClick}
      aria-pressed={active}
      className={cn('relative min-h-11 px-3 py-2 text-sm font-medium transition-colors sm:min-h-0', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      {children}
      {active && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
    </button>
  );
}

function TgScanning({
  img,
  phase,
  password,
  setPassword,
  onSubmit,
  err,
  busy,
}: {
  img: string | null;
  phase: 'scanning' | 'password';
  password: string;
  setPassword: (v: string) => void;
  onSubmit: () => void;
  err: string | null;
  busy: boolean;
}) {
  if (phase === 'password') {
    return (
      <div className="mx-auto w-full max-w-xs">
        <label htmlFor="telegram-cloud-password" className="block text-sm text-muted-foreground">
          У аккаунта включена двухфакторная защита. Введите облачный пароль Telegram:
        </label>
        <input
          data-mobile-touch-target=""
          id="telegram-cloud-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder="Облачный пароль"
          autoComplete="off"
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? 'telegram-cloud-password-error' : undefined}
          className="mt-3 min-h-11 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-hidden focus:ring-1 focus:ring-primary sm:min-h-0"
        />
        {err && <p id="telegram-cloud-password-error" role="alert" className="mt-2 text-xs font-medium text-destructive">{err}</p>}
        <Button type="button" onClick={onSubmit} disabled={busy || !password} className="mt-3">
          {busy ? 'Проверка…' : 'Подтвердить'}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center text-center">
      <div className="rounded-xl border border-border bg-white p-3">
        {img ? <img src={img} alt="QR-код для входа в Telegram" className="h-52 w-52" /> : <div className="h-52 w-52" />}
      </div>
      <p className="mt-4 max-w-sm text-sm text-muted-foreground">
        В Telegram: <b className="text-foreground">Настройки → Устройства → Подключить устройство</b> — наведите камеру на код. Он обновляется автоматически.
      </p>
      {err && <p role="alert" className="mt-2 text-xs font-medium text-destructive">{err}</p>}
    </div>
  );
}

// Focused reconnect callout — shown when the stored session died (reauth_required) or the user
// intentionally asked to replace it (?action=reconnect). It NEVER auto-starts the QR login (that would
// be surprising on a mere visit); the «Переподключить» button calls the same start() as a first
// login. For a revoked session it leads with the honest problem statement, not a green «Подключён».
function TgReconnect({
  reauth,
  username,
  onReconnect,
  busy,
  startRetrying,
  err,
}: {
  reauth: boolean;
  username: string | null;
  onReconnect: () => void;
  busy: boolean;
  startRetrying: boolean;
  err: string | null;
}) {
  return (
    <div>
      <div role="status" className="flex items-center gap-2 text-sm">
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', reauth ? 'bg-status-warn' : 'bg-verdant')} />
        <span className="text-foreground">
          {reauth ? (
            'Сессия Telegram недействительна'
          ) : (
            <>Подключён{username ? <> · <span className="font-mono">@{username}</span></> : null}</>
          )}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {reauth
          ? 'Telegram завершил прежнюю сессию, поэтому новые данные не поступают. Каналы и вся история сохранены — после повторного входа сбор продолжится с того же места.'
          : 'Можно войти заново, чтобы заменить текущую сессию Telegram. Каналы и история сохранятся.'}
      </p>
      <Button type="button" onClick={onReconnect} disabled={busy} size="lg" className="mt-4 px-5">
        {busy ? (startRetrying ? 'Telegram запускается…' : 'Подготовка кода…') : 'Переподключить'}
      </Button>
      {err && <p role="alert" className="mt-3 text-xs font-medium text-destructive">{err}</p>}
    </div>
  );
}

function TgConnected({ username, channels, onDisconnect, busy }: { username: string | null; channels: QrChannel[]; onDisconnect: () => void; busy: boolean }) {
  const qc = useQueryClient();
  const { data: channelsData } = useChannels();
  // Channels already in the dashboard (match the QR channel id against the stored tg_channel_id;
  // pg returns BIGINT as a string, so compare stringified).
  const existing = useMemo(
    () => new Set((channelsData?.channels ?? [])
      .map((c) => (c.tg_channel_id == null ? '' : String(c.tg_channel_id)))
      .filter(Boolean)),
    [channelsData],
  );
  const isAdded = useCallback((c: QrChannel) => existing.has(String(c.id)), [existing]);

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState<number | null>(null);

  // Seed the pre-selection once per SCAN (when the captured channel list changes) — deliberately NOT
  // on every ['channels'] refetch. add() below awaits invalidateQueries(['channels']); keying this on
  // `isAdded`/`existing` would re-run it right after an add, wiping the user's manual ticks and the
  // «Добавлено» confirmation that add() just set. Already-tracked channels are excluded at render
  // time via `selected`/`isAdded`, so they don't need excluding here.
  useEffect(() => {
    setPicked(new Set(channels.filter(isEligible).map((c) => c.id)));
    setAddedCount(null);
    setAddErr(null);
  }, [channels]);

  const toggle = (id: number) =>
    setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const selected = channels.filter((c) => picked.has(c.id) && isEligible(c) && !isAdded(c));

  const add = async () => {
    if (!selected.length) return;
    setAdding(true); setAddErr(null); setAddedCount(null);
    try {
      const r = await apiSend(
        'POST', '/api/tg/qr/channels',
        { channels: selected.map((c) => ({ id: c.id, title: c.title, username: c.username })) },
        AddChannelsSchema,
      );
      await qc.invalidateQueries({ queryKey: qk.channels });
      setAddedCount(r.added ?? selected.length);
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : 'Не удалось добавить каналы');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <div role="status" className="flex items-center gap-2 text-sm">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-verdant" />
        <span className="text-foreground">Подключён{username ? <> · <span className="font-mono">@{username}</span></> : null}</span>
      </div>

      {channels.length > 0 ? (
        <div className="mt-4">
          <div className="text-2xs font-medium tracking-wide text-muted-foreground">Каналы, где вы админ — выберите, что отслеживать</div>
          <ul className="mt-2 space-y-0.5">
            {channels.map((c) => {
              const added = isAdded(c);
              const eligible = isEligible(c);
              const disabled = added || !eligible;
              return (
                <li key={c.id}>
                  <label data-mobile-touch-target="" className={cn('flex min-h-11 items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors sm:min-h-0',
                    disabled ? 'cursor-default text-muted-foreground' : 'cursor-pointer text-foreground hover:bg-muted/40')}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={!disabled && picked.has(c.id)}
                      onChange={() => toggle(c.id)}
                      className="size-4 shrink-0 accent-primary disabled:opacity-50"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {c.title || '(без названия)'}
                      {c.username ? <span className="font-mono text-muted-foreground"> · @{c.username}</span> : null}
                      {typeof c.participants === 'number' ? <span className="text-muted-foreground"> · {c.participants.toLocaleString('ru-RU')}</span> : null}
                    </span>
                    {added ? <span className="shrink-0 text-2xs text-verdant">в дашборде</span>
                      : !eligible ? <span className="shrink-0 text-2xs text-muted-foreground">группа</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>

          {selected.length > 0 && (
            <Button type="button" onClick={add} disabled={adding} className="mt-3">
              {adding ? 'Добавление…' : `Добавить выбранные (${selected.length})`}
            </Button>
          )}
          <div aria-live="polite">
            {addedCount != null && addedCount > 0 && (
              <p className="mt-2 text-xs text-verdant">Добавлено: {addedCount}. Каналы появились в переключателе источника.</p>
            )}
          </div>
          {addErr && <p role="alert" className="mt-2 text-xs font-medium text-destructive">{addErr}</p>}
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Каналов, где вы админ, не нашлось.</p>
      )}

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Выбранные каналы появляются в переключателе источника. Автоматический сбор статистики по ним подключаем следующим шагом.
      </p>
      <button
        type="button"
        data-mobile-touch-target=""
        onClick={onDisconnect}
        disabled={busy}
        className="btn-pill mt-4 inline-flex min-h-11 items-center border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50 sm:min-h-0"
      >
        {busy ? 'Отключение…' : 'Отключить'}
      </button>
    </div>
  );
}

// ── Collector agent wizard (the "pro" path — the session stays on the user's machine) ──
/**
 * Интерактивный пошаговый мастер вместо статичной инструкции (паттерн blocks.so dialog-11/
 * onboarding-steps): ключ создаётся ПРЯМО в шаге 1 (раньше гоняли в Настройки и обратно), а
 * финальный шаг — живая проверка агента поллингом collector-status, так что мануал замыкается
 * наблюдаемым «агент на связи», а не «обновите дашборд через минуту».
 */
const WIZARD_STEPS = ['Ключ', 'Telegram-app', 'Сессия', '.env', 'Проверка'] as const;

function CollectorGuide({ channelName }: { channelName: string | null }) {
  const handle = channelName ?? '@ваш_канал';
  const { channelId } = useSelectedChannel();
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [visited, setVisited] = useState(1);
  const goTo = (n: number) => {
    setStep(n);
    setVisited((v) => Math.max(v, n));
  };

  // Шаг 1 — ключ прямо здесь (паттерн ChannelsSection): one-time показ + копирование.
  const createKey = useCreateKey(channelId ?? 0);
  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const handleCreateKey = async () => {
    setKeyErr(null);
    try {
      const res = await createKey.mutateAsync({ label: 'локальный коллектор' });
      if (res.key) setOneTimeKey(res.key);
    } catch (error) {
      setKeyErr(error instanceof ApiError ? error.message : 'Не удалось сгенерировать ключ — попробуйте ещё раз');
    }
  };
  // Шаг 5 — живая проверка: поллим collector-status, пока шаг открыт.
  const onCheckStep = step === WIZARD_STEPS.length;
  const statusQ = useCollectorStatus(onCheckStep ? channelId : null);
  useEffect(() => {
    if (!onCheckStep || channelId == null) return;
    const timer = window.setInterval(
      () => qc.invalidateQueries({ queryKey: qk.collectorStatus(channelId) }),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [onCheckStep, channelId, qc]);
  const collectorStatus = statusQ.data?.status ?? null;
  const agentAlive = !!collectorStatus && !collectorStatus.stale;

  return (
    <div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Для приватности: каналы считает <span className="font-medium text-foreground">collector-агент</span> у вас на компьютере и шлёт
        сюда только готовые цифры. Telegram-сессию мы не храним.
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

      {/* Прогресс-шапка мастера: пройденные шаги кликабельны (вернуться и перечитать). */}
      <ol className="mt-5 flex items-center gap-1" aria-label="Шаги настройки коллектора">
        {WIZARD_STEPS.map((label, index) => {
          const n = index + 1;
          const done = n < step;
          const active = n === step;
          const reachable = n <= visited;
          return (
            <li key={label} className={cn('flex items-center gap-1', n < WIZARD_STEPS.length && 'flex-1')}>
              <button
                type="button"
                data-mobile-touch-target=""
                onClick={() => reachable && setStep(n)}
                disabled={!reachable}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex min-h-11 min-w-11 items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-2xs font-medium transition-colors sm:min-h-0 sm:min-w-0',
                  active ? 'text-foreground' : 'text-muted-foreground',
                  reachable && !active && 'hover:text-foreground',
                  !reachable && 'pointer-events-none',
                )}
              >
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium',
                    active ? 'bg-primary text-primary-foreground' : done ? 'bg-primary/15 text-accent-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {done ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="size-3" aria-hidden="true">
                      <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    n
                  )}
                </span>
                <span className="hidden sm:inline">{label}</span>
              </button>
              {n < WIZARD_STEPS.length && <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-border" />}
            </li>
          );
        })}
      </ol>

      <div className="mt-4 min-h-48 rounded-lg border border-border p-4">
        {step === 1 && (
          <div>
            <h3 className="text-sm font-medium text-foreground">API-ключ канала</h3>
            {channelId == null ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Сначала добавьте канал в{' '}
                <Link to="/settings" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">Настройках</Link>
                {' '}— ключ выпускается для конкретного канала.
              </p>
            ) : (
              <div className="mt-2 space-y-3">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Ключ для <Code>{handle}</Code> создаётся здесь и показывается{' '}
                  <span className="font-medium text-foreground">один раз</span>. Уже есть действующий ключ — этот шаг можно пропустить.
                </p>
                {!oneTimeKey && (
                  <Button
                    type="button"
                    onClick={handleCreateKey}
                    pending={createKey.isPending}
                    disabled={createKey.isPending}
                    size="sm"
                    className="px-4 text-sm"
                  >
                    {createKey.isPending ? 'Генерация…' : 'Создать ключ'}
                  </Button>
                )}
                {keyErr && <p role="alert" className="text-xs text-destructive">{keyErr}</p>}
                {oneTimeKey && (
                  <Snippet
                    value={oneTimeKey}
                    label="Скопируйте сейчас — повторно ключ не показывается."
                    tone="warn"
                  />
                )}
              </div>
            )}
          </div>
        )}
        {step === 2 && (
          <div>
            <h3 className="text-sm font-medium text-foreground">Создайте Telegram-приложение</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">my.telegram.org</a>{' '}
              → API development tools → создайте app → запишите <Code>api_id</Code> и <Code>api_hash</Code>.
            </p>
          </div>
        )}
        {step === 3 && (
          <div>
            <h3 className="text-sm font-medium text-foreground">Получите строку сессии (один раз)</h3>
            <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Установите Telethon и залогиньтесь по номеру и коду — скопируйте напечатанную строку:
              <CodeBlock>{`pip install telethon
python -c "from telethon.sync import TelegramClient as T; \\
from telethon.sessions import StringSession as S; \\
print(T(S(), API_ID, 'API_HASH').start().session.save())"`}</CodeBlock>
            </div>
          </div>
        )}
        {step === 4 && (
          <div>
            <h3 className="text-sm font-medium text-foreground">Заполните .env рядом с агентом</h3>
            <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
              <CodeBlock>{`PULSE_API_URL=${window.location.origin}
PULSE_API_KEY=pa_…        # ключ из шага 1
TG_API_ID=123456          # из шага 2
TG_API_HASH=…             # из шага 2
TG_SESSION=…              # из шага 3
TG_CHANNEL=${handle}`}</CodeBlock>
              <p className="mt-2 text-xs text-muted-foreground">
                Ingest URL берётся из <Code>PULSE_API_URL</Code>: <Code>{INGEST_URL}</Code>
              </p>
            </div>
          </div>
        )}
        {step === 5 && (
          <div>
            <h3 className="text-sm font-medium text-foreground">Запустите агента — мы ждём его здесь</h3>
            <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
              <CodeBlock>{`python collector/pulse_collector.py doctor   # проверка конфига
python collector/pulse_collector.py once     # один прогон
python collector/pulse_collector.py run      # дальше каждые 6 ч`}</CodeBlock>
            </div>
            <div
              data-testid="collector-live-check"
              className={cn(
                'mt-3 flex items-center gap-2.5 rounded border p-3 text-sm',
                agentAlive ? 'border-verdant/40 bg-verdant/[0.05] text-foreground' : 'border-border text-muted-foreground',
              )}
            >
              {agentAlive ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4 shrink-0 text-verdant" aria-hidden="true">
                    <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>
                    Агент на связи — данные получены{' '}
                    {collectorStatus?.last_success_at ? fmt.date(collectorStatus.last_success_at) : 'только что'}.{' '}
                    <Link to="/" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">Открыть дашборд →</Link>
                  </span>
                </>
              ) : (
                <>
                  {/* Канон-лоадер (полировка 2026-07-28): стаггер-точки вместо одиночного пульса. */}
                  <LoaderDots className="shrink-0 text-status-warn" />
                  <span>Ждём первый прогон агента… страница проверяет связь каждые 5 секунд.</span>
                </>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Упоминания: флаг <Code>--mentions</Code>.</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          data-mobile-touch-target=""
          onClick={() => step > 1 && setStep(step - 1)}
          disabled={step === 1}
          className="btn-pill inline-flex min-h-11 items-center border border-border px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:min-h-0"
        >
          Назад
        </button>
        {step < WIZARD_STEPS.length ? (
          <Button type="button" onClick={() => goTo(step + 1)} size="xs" className="px-4">
            Далее
          </Button>
        ) : (
          <Button asChild size="xs" className="px-4">
            <Link to="/">Открыть дашборд</Link>
          </Button>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Если что-то не так</h3>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li><Code>doctor</Code> пишет «Missing env» → проверьте <Code>.env</Code>.</li>
          <li>401/403 на ingest → ключ не тот или отозван → пересоздайте в шаге 1.</li>
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
        data-mobile-touch-target=""
        disabled
        className="btn-pill mt-5 inline-flex min-h-11 items-center border border-border px-4 py-2 text-sm font-medium text-muted-foreground opacity-60 sm:min-h-0"
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
  const text = typeof children === 'string' ? children : '';
  if (!text) {
    return (
      <pre className="mt-2 overflow-x-auto rounded border border-border bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
        {children}
      </pre>
    );
  }
  return (
    <Snippet
      value={text}
      multiline
      copyLabel="Скопировать команды"
      className="mt-2"
    />
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
