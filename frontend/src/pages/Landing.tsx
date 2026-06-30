import { useRef } from 'react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  motion,
  useScroll,
  useTransform,
  useReducedMotion,
  useMotionValue,
  cubicBezier,
  type MotionValue,
} from 'framer-motion';
import { PulseMark } from '@/components/PulseMark';

/**
 * Public marketing landing — "Pulse Refined Technical" (light, product-forward, Steep-style).
 * Light by default (no forced .dark): warm paper canvas, hairline section dividers, one calm blue
 * accent, pill CTAs. The product itself does the selling — a dashboard that *assembles itself* in
 * the hero on scroll (scroll-scrubbed), and real product fragments that rise into view down the page.
 *
 * Motion: a pinned hero whose dashboard pieces (KPI cards, sparkline, headline metric, post rows,
 * insight) scrub in as you scroll; sections below reveal on entry. All of it collapses to a static,
 * fully-assembled state under `prefers-reduced-motion` and on mobile (where the mock is hidden).
 */

const MAXW = 'mx-auto w-full max-w-[1200px] px-6 sm:px-10';

const EASE = cubicBezier(0.22, 1, 0.36, 1);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// shared sparkline geometry (static fragment + animated hero share one path)
const SPARK_LINE =
  'M0,44 L18,40 L36,42 L54,33 L72,35 L90,27 L108,29 L126,20 L144,22 L162,12 L180,15 L200,6';

// ── tiny inline icons (stroke = currentColor) ──────────────────────────────
function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12.5l4 4 10-11" />
    </svg>
  );
}
function Calendar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="4" y="5" width="16" height="16" rx="2.2" />
      <path d="M3.5 9.5h17M8 2.8v3.6M16 2.8v3.6" />
    </svg>
  );
}
function Shield({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6l7-3z" />
    </svg>
  );
}
function Lightbulb({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10c.7.7 1 1.3 1 2h6c0-.7.3-1.3 1-2a6 6 0 0 0-4-10z" />
    </svg>
  );
}

// ── shared product-preview atoms ────────────────────────────────────────────
function Sparkline() {
  return (
    <svg viewBox="0 0 200 52" preserveAspectRatio="none" className="h-[52px] w-full" aria-hidden="true">
      <defs>
        <linearGradient id="lp-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.16" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${SPARK_LINE} L200,52 L0,52 Z`} fill="url(#lp-spark)" />
      <path d={SPARK_LINE} fill="none" stroke="hsl(var(--foreground))" strokeWidth="1.5" />
      <circle cx="200" cy="6" r="3" fill="hsl(var(--primary))" />
    </svg>
  );
}

function MiniNav({ label, active, demo }: { label: string; active?: boolean; demo?: boolean }) {
  return (
    <div className={`flex w-full items-center gap-2 rounded px-2 py-1 ${active ? 'text-foreground' : 'text-ink3'}`}>
      <span className={`h-1.5 w-1.5 rounded-sm ${active ? 'bg-primary' : 'bg-ink3/50'}`} />
      <span className="text-[10px]">{label}</span>
      {demo && <span className="ml-auto rounded bg-status-warn/15 px-1 text-[7px] font-medium text-status-warn">демо</span>}
    </div>
  );
}

function Col({ label, value, delta, up }: { label: string; value: string; delta: string; up?: boolean }) {
  return (
    <div className="flex-1 border-l border-border pl-3 first:border-l-0 first:pl-0">
      <div className="text-[9px] text-ink3">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[15px] font-medium tabular-nums text-foreground">{value}</span>
        <span className={`text-[9px] tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>{delta}</span>
      </div>
    </div>
  );
}

function PostRow({ n, title, views, er, delta, up }: { n: number; title: string; views: string; er: string; delta: string; up?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-2 text-[10px]">
      <span className="w-3 text-ink3 tabular-nums">{n}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      <span className="w-12 text-right tabular-nums text-ink2">{views}</span>
      <span className="w-8 text-right tabular-nums text-ink2">{er}</span>
      <span className={`w-9 text-right tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>{delta}</span>
    </div>
  );
}

// ── animated hero: a dashboard that assembles itself on scroll ───────────────

// one KPI tile that flies in from `from*` and docks into the grid as p → end
function useScatter(p: MotionValue<number>, fx: number, fy: number, frot: number, a: number, b: number) {
  const x = useTransform(p, [a, b], [fx, 0], { ease: EASE });
  const y = useTransform(p, [a, b], [fy, 0], { ease: EASE });
  const rotate = useTransform(p, [a, b], [frot, 0], { ease: EASE });
  const scale = useTransform(p, [a, b], [0.85, 1], { ease: EASE });
  const opacity = useTransform(p, [a - 0.06, a + 0.04], [0, 1]);
  const boxShadow = useTransform(
    p,
    [a, b],
    ['0 18px 34px -16px rgba(20,24,40,0.5)', '0 0 0 0 rgba(20,24,40,0)'],
  );
  return { x, y, rotate, scale, opacity, boxShadow };
}

function KpiTile({
  p, label, value, delta, up, fx, fy, frot, a, b,
}: {
  p: MotionValue<number>; label: string; value: string; delta: string; up?: boolean;
  fx: number; fy: number; frot: number; a: number; b: number;
}) {
  const style = useScatter(p, fx, fy, frot, a, b);
  return (
    <motion.div style={style} className="rounded-lg border border-border bg-card px-2.5 py-2 will-change-transform">
      <div className="text-[9px] text-ink3">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[15px] font-medium tabular-nums text-foreground">{value}</span>
        <span className={`text-[9px] tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>{delta}</span>
      </div>
    </motion.div>
  );
}

function HeroSparkline({ p }: { p: MotionValue<number> }) {
  const draw = useTransform(p, [0.16, 0.5], [0, 1], { ease: EASE });
  const areaOpacity = useTransform(draw, [0, 1], [0, 1]);
  const dotOpacity = useTransform(draw, [0.85, 1], [0, 1]);
  return (
    <svg viewBox="0 0 200 52" preserveAspectRatio="none" className="h-[52px] w-full" aria-hidden="true">
      <defs>
        <linearGradient id="lp-spark-h" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.16" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={`${SPARK_LINE} L200,52 L0,52 Z`} fill="url(#lp-spark-h)" style={{ opacity: areaOpacity }} />
      <motion.path d={SPARK_LINE} fill="none" stroke="hsl(var(--foreground))" strokeWidth="1.5" style={{ pathLength: draw }} />
      <motion.circle cx="200" cy="6" r="3" fill="hsl(var(--primary))" style={{ opacity: dotOpacity }} />
    </svg>
  );
}

const RISK_LINE = 'Охват растёт на 8%, а подписчиков стало меньше на 108.';

function DashboardMock({ p }: { p: MotionValue<number> }) {
  const frameOpacity = useTransform(p, [0, 0.1], [0.55, 1]);
  const sidebarX = useTransform(p, [0.03, 0.2], [-16, 0], { ease: EASE });
  const sidebarOpacity = useTransform(p, [0.03, 0.2], [0, 1]);

  const viewsNum = useTransform(p, [0.12, 0.46], [0, 48210], { ease: EASE });
  const viewsText = useTransform(viewsNum, (v) => Math.round(v).toLocaleString('ru-RU'));
  const pillOpacity = useTransform(p, [0.46, 0.56], [0, 1]);

  const typed = useTransform(p, (v) =>
    RISK_LINE.slice(0, Math.round(RISK_LINE.length * clamp01((v - 0.64) / 0.14))),
  );
  const caretOpacity = useTransform(p, [0.64, 0.66, 0.8, 0.84], [0, 1, 1, 0]);
  const insightOpacity = useTransform(p, [0.6, 0.7], [0, 1]);
  const insightY = useTransform(p, [0.6, 0.7], [8, 0], { ease: EASE });

  const postsOpacity = [
    useTransform(p, [0.48, 0.6], [0, 1]),
    useTransform(p, [0.53, 0.65], [0, 1]),
    useTransform(p, [0.58, 0.7], [0, 1]),
  ];
  const postsY = [
    useTransform(p, [0.48, 0.6], [8, 0], { ease: EASE }),
    useTransform(p, [0.53, 0.65], [8, 0], { ease: EASE }),
    useTransform(p, [0.58, 0.7], [8, 0], { ease: EASE }),
  ];

  return (
    <motion.div style={{ opacity: frameOpacity }} className="flex w-full text-foreground">
      {/* sidebar */}
      <motion.div
        style={{ x: sidebarX, opacity: sidebarOpacity }}
        className="hidden w-[132px] shrink-0 flex-col gap-3 border-r border-border bg-background p-3 sm:flex"
      >
        <div className="flex items-center gap-1.5">
          <PulseMark className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-medium">Pulse</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-1">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-avatar text-[9px] font-medium text-ink2">N</span>
          <div className="min-w-0">
            <div className="truncate text-[10px] font-medium">@newsroom</div>
            <div className="truncate text-[8px] text-ink3">4 781 подписчик</div>
          </div>
        </div>
        <div>
          <div className="px-2 pb-1 text-[8px] text-ink3">Платформа</div>
          <MiniNav label="Telegram" active />
          <MiniNav label="Instagram" demo />
        </div>
        <div className="space-y-0.5">
          <MiniNav label="Обзор" active />
          <MiniNav label="Аналитика" />
          <MiniNav label="Посты" />
          <MiniNav label="Упоминания" />
        </div>
      </motion.div>

      {/* main */}
      <div className="min-w-0 flex-1 bg-card p-4">
        <div className="flex items-center justify-between border-b border-border pb-2.5">
          <span className="text-[11px] font-medium">Обзор</span>
          <div className="flex items-center gap-2 text-[9px] text-ink3">
            <span>7д</span>
            <span className="relative text-foreground">30д<span className="absolute inset-x-0 -bottom-1 h-px bg-primary" /></span>
            <span>90д</span>
            <span className="h-2.5 w-px bg-border" />
            <Calendar className="h-3 w-3 text-ink2" />
          </div>
        </div>

        <div className="pt-3">
          <div className="text-[9px] text-ink3">Просмотры · 30 дней</div>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <motion.span className="text-[34px] font-medium leading-none tabular-nums">{viewsText}</motion.span>
              <motion.span style={{ opacity: pillOpacity }} className="rounded bg-green-tint px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-verdant">↑ 8.4%</motion.span>
            </div>
            <div className="w-[46%]"><HeroSparkline p={p} /></div>
          </div>
          <div className="mt-1 text-[8px] text-ink3">к прошлому периоду · ≈2 835 на пост</div>
        </div>

        {/* KPI tiles assemble here */}
        <div className="mt-3 grid grid-cols-4 gap-2 border-t border-border pt-3">
          <KpiTile p={p} label="Подписчики" value="4 781" delta="−108" fx={-120} fy={-28} frot={-6} a={0.22} b={0.44} />
          <KpiTile p={p} label="Ср. охват" value="2 835" delta="+4%" up fx={44} fy={-104} frot={5} a={0.28} b={0.50} />
          <KpiTile p={p} label="Реакции" value="1 204" delta="+58" up fx={-34} fy={104} frot={4} a={0.34} b={0.56} />
          <KpiTile p={p} label="Вовлечённость" value="6.7%" delta="+0.4" up fx={128} fy={40} frot={-6} a={0.40} b={0.62} />
        </div>

        <div className="mt-3 border-t border-border pt-2">
          <div className="pb-1 text-[9px] text-ink3">Топ постов</div>
          <motion.div style={{ opacity: postsOpacity[0], y: postsY[0] }}>
            <PostRow n={1} title="Как мы выбираем темы для канала" views="12 480" er="9.1%" delta="+24%" up />
          </motion.div>
          <motion.div style={{ opacity: postsOpacity[1], y: postsY[1] }}>
            <PostRow n={2} title="Большой гайд по продуктивности" views="8 902" er="7.4%" delta="−6%" />
          </motion.div>
          <motion.div style={{ opacity: postsOpacity[2], y: postsY[2] }}>
            <PostRow n={3} title="Подкаст: итоги сезона и планы" views="7 415" er="6.2%" delta="+11%" up />
          </motion.div>
        </div>

        {/* self-typing insight */}
        <motion.div style={{ opacity: insightOpacity, y: insightY }} className="mt-3 flex items-start gap-2 border-t border-border pt-2.5">
          <span className="mt-0.5 rounded bg-amber-tint px-1 py-0.5 text-[8px] font-medium text-status-warn">Риск</span>
          <p className="text-[10px] leading-snug text-ink2">
            <motion.span>{typed}</motion.span>
            <motion.span style={{ opacity: caretOpacity }} className="ml-px inline-block text-primary">▍</motion.span>
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}

function HeroCopy({ reduce }: { reduce: boolean }) {
  const container = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } };
  const item = {
    hidden: { opacity: 0, y: 16 },
    show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
  };
  return (
    <motion.div variants={container} initial={reduce ? false : 'hidden'} animate="show">
      <motion.div variants={item} className="text-[13px] font-medium text-primary">Telegram + Instagram</motion.div>
      <motion.h1 variants={item} className="mt-4 text-[clamp(54px,8vw,76px)] font-medium leading-[0.95] tracking-tight text-foreground">Pulse</motion.h1>
      <motion.p variants={item} className="mt-5 max-w-[22em] text-[clamp(18px,1.6vw,22px)] leading-snug text-ink2">
        Аналитика Telegram и Instagram без лишнего шума
      </motion.p>
      <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
        <Link to="/register" className="btn-pill bg-primary px-5 py-3 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90">
          Создать аккаунт
        </Link>
        <Link to="/login" className="btn-pill border border-border bg-card px-5 py-3 text-[15px] font-medium text-foreground transition-colors hover:bg-muted">
          Посмотреть демо
        </Link>
      </motion.div>
      <motion.p variants={item} className="mt-5 text-[13px] text-ink3">Демо доступно без регистрации · данные собираются локально</motion.p>
    </motion.div>
  );
}

function Hero() {
  const reduce = useReducedMotion() ?? false;
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const staticP = useMotionValue(1);
  const p = reduce ? staticP : scrollYProgress;

  const runway = reduce ? '' : 'md:h-[200vh]';
  const stage = reduce
    ? ''
    : 'md:sticky md:top-[68px] md:flex md:h-[calc(100vh-68px)] md:items-center md:overflow-hidden';
  const gridPad = reduce ? 'py-14 md:py-20' : 'py-14 md:py-0';

  return (
    <section ref={heroRef} className={`relative border-b border-border ${runway}`}>
      <div className={stage}>
        {/* soft blue halo behind the dashboard */}
        <ScrollHalo p={p} />
        <div className={`${MAXW} relative z-[1] grid w-full items-center gap-12 ${gridPad} md:grid-cols-[minmax(0,420px)_1fr]`}>
          <HeroCopy reduce={reduce} />
          <div className="relative hidden md:block">
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_30px_70px_-40px_rgba(20,24,40,0.28)]">
              <DashboardMock p={p} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ScrollHalo({ p }: { p: MotionValue<number> }) {
  const opacity = useTransform(p, [0.08, 0.42], [0, 0.9]);
  return (
    <motion.div
      aria-hidden="true"
      style={{ opacity }}
      className="pointer-events-none absolute right-[6%] top-1/2 hidden h-[680px] w-[680px] -translate-y-1/2 rounded-full md:block"
    >
      <div className="h-full w-full rounded-full bg-primary/10 blur-3xl" />
    </motion.div>
  );
}

// ── scroll-reveal wrapper for the sections below the hero ────────────────────
function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

// ── page sections ──────────────────────────────────────────────────────────
function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
      <div className={`${MAXW} flex h-[68px] items-center justify-between`}>
        <Link to="/" className="flex items-center gap-2.5">
          <PulseMark className="h-[18px] w-[18px] text-primary" />
          <span className="text-[17px] font-medium tracking-tight text-foreground">Pulse</span>
        </Link>
        <nav className="flex items-center gap-6 sm:gap-7">
          <a href="#features" className="hidden text-sm text-ink2 transition-colors hover:text-foreground sm:block">Возможности</a>
          <a href="#security" className="hidden text-sm text-ink2 transition-colors hover:text-foreground sm:block">Безопасность</a>
          <Link to="/login" className="text-sm font-medium text-foreground transition-colors hover:text-primary">Войти</Link>
          <Link to="/register" className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Начать
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Pillars() {
  const items = [
    { h: 'Локальный сбор данных', p: 'Collector работает на вашей стороне. Сессия Telegram не попадает в Pulse.', icon: Shield },
    { h: 'Инсайты по постам', p: 'Сигнал → тезис → действие по каждому посту, а не просто графики.', icon: Lightbulb },
    { h: 'Состояние источников', p: 'Источник, последний сбор, версия сборщика и статус API — на виду.', icon: PulseMark },
  ];
  return (
    <section id="security" className="border-b border-border">
      <Reveal className={`${MAXW} py-16`}>
        <div className="text-[13px] font-medium text-ink3">Почему Pulse</div>
        <h2 className="mt-2 max-w-[16em] text-[clamp(24px,3vw,30px)] font-medium tracking-tight text-foreground">
          Спокойная аналитика, которой можно доверять
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden md:grid-cols-3">
          {items.map((it, i) => {
            const Ico = it.icon;
            return (
            <div key={it.h} className={i > 0 ? 'md:border-l md:border-border md:pl-10' : 'md:pr-10'}>
              <Ico className="h-5 w-5 text-foreground" />
              <h3 className="mt-3 text-[17px] font-medium text-foreground">{it.h}</h3>
              <p className="mt-2 max-w-[20em] text-sm leading-relaxed text-ink2">{it.p}</p>
            </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-border bg-card p-5">{children}</div>;
}

function KpiFragment() {
  return (
    <Panel>
      <div className="text-[11px] text-ink3">Просмотры · 30 дней</div>
      <div className="mt-1 flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[40px] font-medium leading-none tabular-nums text-foreground">48 210</span>
          <span className="rounded bg-green-tint px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-verdant">↑ 8.4%</span>
        </div>
        <div className="w-[42%]"><Sparkline /></div>
      </div>
      <div className="mt-1.5 text-[11px] text-ink3">к прошлому периоду · ≈2 835 на пост</div>
      <div className="mt-4 flex gap-3 border-t border-border pt-4">
        <Col label="Подписчики" value="4 781" delta="−108" />
        <Col label="Ср. охват" value="2 835" delta="+4%" up />
        <Col label="Реакции" value="1 204" delta="+58" up />
        <Col label="Вовлечённость" value="6.7%" delta="+0.4" up />
      </div>
    </Panel>
  );
}

function InsightFragment() {
  return (
    <Panel>
      <div className="text-[11px] text-ink3">Инсайт</div>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="rounded bg-amber-tint px-1.5 py-0.5 text-[11px] font-medium text-status-warn">Риск</span>
        <span className="text-[15px] font-medium text-foreground">Охват растёт, база сжимается</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink2">
        Подписчиков стало меньше на 108 при росте просмотров на 8%.
      </p>
      <p className="mt-3 flex items-start gap-2 text-sm text-ink2">
        <span className="text-primary">→</span>
        Проверьте посты перед оттоком в разделе «Рост».
      </p>
      <div className="mt-3 text-[13px] font-medium text-primary">Топ-пост: «Как мы выбираем темы» →</div>
    </Panel>
  );
}

function HealthRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-2.5 first:border-t-0 first:pt-0">
      <span className="text-[13px] text-ink2">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-ink3">{value}</span>
    </div>
  );
}

function HealthFragment() {
  return (
    <Panel>
      <div className="text-[11px] text-ink3">Состояние данных</div>
      <div className="mt-3">
        <HealthRow label="Источник" value="Telegram · MTProto" />
        <HealthRow label="Последний сбор" value="09:14 · 2 ч назад" />
        <HealthRow label="Сборщик" value="v1.0.5" />
        <HealthRow
          label="API"
          value={<span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-verdant" />200 OK</span>}
        />
      </div>
      <div className="mt-3 text-[13px] font-medium text-primary">Настроить сбор →</div>
    </Panel>
  );
}

function Feature({
  eyebrow,
  title,
  body,
  bullets,
  fragment,
  reverse,
}: {
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  fragment: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="border-b border-border">
      <div className={`${MAXW} grid items-center gap-12 py-16 md:grid-cols-2`}>
        <Reveal className={reverse ? 'md:order-2' : ''}>
          <div className="text-[13px] font-medium text-primary">{eyebrow}</div>
          <h2 className="mt-3 max-w-[12em] text-[clamp(24px,3vw,30px)] font-medium tracking-tight text-foreground">{title}</h2>
          <p className="mt-3 max-w-[26em] text-base leading-relaxed text-ink2">{body}</p>
          <ul className="mt-5 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex items-center gap-2.5 text-sm text-ink2">
                <Check className="h-4 w-4 shrink-0 text-primary" />
                {b}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal className={reverse ? 'md:order-1' : ''} delay={0.1}>{fragment}</Reveal>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="bg-blue-tint">
      <Reveal className={`${MAXW} flex flex-col items-center py-20 text-center`}>
        <h2 className="text-[clamp(28px,4vw,36px)] font-medium tracking-tight text-foreground">Начните за минуту</h2>
        <p className="mt-4 max-w-[28em] text-[17px] text-ink2">Подключите канал или откройте демо без регистрации.</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link to="/register" className="btn-pill bg-primary px-5 py-3 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Создать аккаунт
          </Link>
          <Link to="/login" className="btn-pill border border-border bg-card px-5 py-3 text-[15px] font-medium text-foreground transition-colors hover:bg-muted">
            Посмотреть демо
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className={`${MAXW} flex flex-col items-start justify-between gap-4 py-10 sm:flex-row sm:items-center`}>
        <div className="flex items-center gap-2.5 text-[13px] text-ink3">
          <PulseMark className="h-[18px] w-[18px] text-ink3" />
          Pulse · спокойная аналитика
        </div>
        <nav className="flex items-center gap-6 text-[13px] text-ink3">
          <a href="#features" className="transition-colors hover:text-foreground">Возможности</a>
          <a href="#security" className="transition-colors hover:text-foreground">Безопасность</a>
          <Link to="/login" className="transition-colors hover:text-foreground">Войти</Link>
          <Link to="/register" className="transition-colors hover:text-foreground">Создать аккаунт</Link>
        </nav>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <Hero />
      <Pillars />
      <div id="features">
        <Feature
          eyebrow="Обзор"
          title="Весь канал на одном экране"
          body="Просмотры, охват, реакции и вовлечённость — одним взглядом, с дельтой к прошлому периоду."
          bullets={['Главная метрика + спарклайн с пиками', 'KPI-ledger: 4 показателя в строке', 'Сравнение с прошлым периодом']}
          fragment={<KpiFragment />}
        />
        <Feature
          eyebrow="Инсайты"
          title="Инсайты, а не просто графики"
          body="Каждый сигнал — это готовый вывод и следующий шаг, а не ещё один график, который надо толковать."
          bullets={['Сигнал: Риск или Рост', 'Тезис простым языком', 'Действие и ссылка-доказательство']}
          fragment={<InsightFragment />}
          reverse
        />
        <Feature
          eyebrow="Данные"
          title="Источники под контролем"
          body="Видно, откуда данные, когда собраны в последний раз и здоров ли сборщик — без догадок."
          bullets={['Источник и последний сбор', 'Версия сборщика', 'Статус API в реальном времени']}
          fragment={<HealthFragment />}
        />
      </div>
      <CtaBand />
      <Footer />
    </div>
  );
}
