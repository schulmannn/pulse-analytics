import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import QRCode from 'qrcode';
import { useQueryClient } from '@tanstack/react-query';
import { useChannels, useConnectIg, useDisconnectIg, useIgOauthStatus, useMsBackfillStatus, useMsStatus, useTgQrStatus } from '@/api/queries';
import { ApiError, apiSend } from '@/api/client';
import { fmt } from '@/lib/format';
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

type ServiceId = 'telegram' | 'instagram' | 'moysklad' | 'threads' | 'youtube' | 'tiktok' | 'x' | 'vk' | 'facebook';
type ServiceKind = 'telegram' | 'instagram' | 'moysklad' | 'soon';

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
  const igStatus = useIgOauthStatus();

  // IG counts as connected when a per-channel OAuth account is linked OR the global env account is
  // serving data (env_fallback) — both mean real Instagram numbers are flowing.
  const igConnected = (igStatus.data?.connected ?? false) || (igStatus.data?.env_fallback ?? false);
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
        <p className="text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
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
        <div className="relative flex justify-center">
          <Starfield />
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
              <span className="text-2xs font-medium uppercase tracking-[0.1em] text-muted-foreground">Источник</span>
              <span className="mt-1 text-base font-medium tracking-tight text-foreground sm:text-lg">{active.name}</span>
              <span className="mt-0.5 text-2xs text-muted-foreground">
                {activeState === 'connected' ? 'Подключён' : activeState === 'available' ? 'Доступен' : 'Скоро'}
              </span>
            </div>

            {/* nodes */}
            {SERVICES.map((s, i) => {
              // Шаг — от ФАКТИЧЕСКОГО числа узлов, не жёсткие π/4: восьмишаговая сетка с девятым
              // источником (МойСклад) клала Facebook (i=8, 2π) ровно под Telegram (i=0).
              const theta = (i * 2 * Math.PI) / SERVICES.length;
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
          {active.kind === 'telegram' && (
            <TelegramPanel channelName={channelName(channelsData)} queryTab={tgTab} reconnectRequested={actionParam === 'reconnect'} />
          )}
          {active.kind === 'instagram' && <InstagramPanel />}
          {active.kind === 'moysklad' && <MoySkladPanel />}
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
    // Финиш прогона: витрины склада (средний чек, воронка, когорты) читают ms_orders — обновить.
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
      await apiSend('POST', '/api/ms/backfill');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Прогон уже идёт (другая вкладка/повторный клик) — не ошибка: поллинг покажет прогресс.
      } else {
        setKick(false);
        setStartErr(err instanceof ApiError ? err.message : 'Не удалось запустить загрузку.');
        return;
      }
    }
    await qc.invalidateQueries({ queryKey: ['ms-backfill'] });
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
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
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
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: pct != null ? `${pct}%` : '30%' }}
          />
        </div>
      </div>
    );
  }

  if (st.status === 'done') {
    // Done-состояние ОБЯЗАНО оставлять путь к повторному прогону (прод-фидбек владельца: после
    // слайса 3 воронке нужен state_id у старых строк, а кнопки не было — тупик). Повтор безопасен:
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
            onClick={() => void startBackfill()}
            className="btn-pill border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Обновить историю заказов
          </button>
          <span className="text-2xs text-muted-foreground">
            перечитает все заказы заново — например, чтобы подтянуть статусы для воронки
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
        onClick={() => void startBackfill()}
        className="btn-pill border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
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
  const qc = useQueryClient();
  const status = useMsStatus();
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
      qc.invalidateQueries({ queryKey: ['channels'] }),
      qc.invalidateQueries({ queryKey: ['ms-status'] }),
      qc.invalidateQueries({ queryKey: ['ms-summary'] }),
      qc.invalidateQueries({ queryKey: ['ms-top-products'] }),
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
      const res = (await apiSend('POST', '/api/ms/connect', { token: value })) as { org_name?: string };
      setFreshOrg(res?.org_name || 'организация');
      setToken('');
      await invalidateMs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить МойСклад.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend('DELETE', '/api/ms/account');
      setFreshOrg(null);
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
            <Link
              to="/sklad"
              className="btn-pill inline-flex bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Открыть Обзор склада →
            </Link>
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className="btn-pill border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
            >
              Отключить
            </button>
          </div>
          {error && <p className="text-xs text-ember">{error}</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Продажи, заказы и прибыль из МойСклада — рядом с аналитикой каналов. Понадобится токен API: в МойСкладе
            откройте <b className="font-medium text-foreground">Настройки → Обмен данными → Токены API</b> и создайте токен.
          </p>
          <form onSubmit={submit} className="flex items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Токен API МойСклада"
              autoComplete="off"
              className="h-9 min-w-0 flex-1 rounded border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={!token.trim() || busy}
              className="btn-pill shrink-0 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Проверяем…' : 'Подключить'}
            </button>
          </form>
          {error && <p className="text-xs text-ember">{error}</p>}
          <p className="text-2xs text-muted-foreground">
            Токен хранится только на сервере в зашифрованном виде (AES-256-GCM) и не попадает в логи.
          </p>
        </div>
      )}
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
              <button
                type="button"
                onClick={() => connect.mutate({ newSource: true })}
                disabled={connect.isPending}
                className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {connect.isPending ? 'Открытие Instagram…' : 'Подключить ещё один аккаунт'}
              </button>
            )}
            <button
              type="button"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              className="btn-pill border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            >
              {disconnect.isPending ? 'Отключение…' : 'Отключить'}
            </button>
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
              <button
                type="button"
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
                className="btn-pill bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {connect.isPending ? 'Открытие Instagram…' : 'Подключить свой аккаунт'}
              </button>
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
          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending || notReady}
            className="btn-pill bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {connect.isPending ? 'Открытие Instagram…' : 'Войти через Instagram'}
          </button>
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

  const refreshStatus = () => qc.invalidateQueries({ queryKey: ['tg-qr-status'] });

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
    setBusy(true);
    try { await apiSend('DELETE', '/api/tg/qr/session', undefined, OkSchema); } catch { /* ignore */ }
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
              <button
                type="button"
                onClick={start}
                disabled={busy}
                className="btn-pill mt-4 bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? (startRetrying ? 'Telegram запускается…' : 'Подготовка кода…') : 'Показать QR-код'}
              </button>
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
      onClick={onClick}
      aria-pressed={active}
      className={cn('relative px-3 py-2 text-sm font-medium transition-colors', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
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
        <p className="text-sm text-muted-foreground">У аккаунта включена двухфакторная защита. Введите облачный пароль Telegram:</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
          placeholder="Облачный пароль"
          className="mt-3 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
        />
        {err && <p role="alert" className="mt-2 text-xs font-medium text-destructive">{err}</p>}
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !password}
          className="btn-pill mt-3 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Проверка…' : 'Подтвердить'}
        </button>
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
      <button
        type="button"
        onClick={onReconnect}
        disabled={busy}
        className="btn-pill mt-4 bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {busy ? (startRetrying ? 'Telegram запускается…' : 'Подготовка кода…') : 'Переподключить'}
      </button>
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
      await qc.invalidateQueries({ queryKey: ['channels'] });
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
                  <label className={cn('flex items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors',
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
                      {typeof c.participants === 'number' ? <span className="text-muted-foreground"> · {c.participants.toLocaleString('ru')}</span> : null}
                    </span>
                    {added ? <span className="shrink-0 text-2xs text-verdant">в дашборде</span>
                      : !eligible ? <span className="shrink-0 text-2xs text-muted-foreground">группа</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>

          {selected.length > 0 && (
            <button
              type="button"
              onClick={add}
              disabled={adding}
              className="btn-pill mt-3 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {adding ? 'Добавление…' : `Добавить выбранные (${selected.length})`}
            </button>
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
        onClick={onDisconnect}
        disabled={busy}
        className="btn-pill mt-4 border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
      >
        {busy ? 'Отключение…' : 'Отключить'}
      </button>
    </div>
  );
}

// ── Collector agent guide (the "pro" path — the session stays on the user's machine) ──
function CollectorGuide({ channelName }: { channelName: string | null }) {
  const handle = channelName ?? '@ваш_канал';
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
