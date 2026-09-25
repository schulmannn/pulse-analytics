import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Check } from 'lucide-react';
import { patchAppearance, setAppearance, useAppearance } from '@/lib/appearance';
import { prefetchAppearanceFonts } from '@/lib/appearanceFonts';
import {
  APPEARANCE_DEFAULT,
  isCanonAppearance,
  setThemeStudioOpen,
  type AppearanceSettings,
} from '@/lib/appearanceStorage';
import {
  ACCENTS,
  BASES,
  FONTS,
  PRESETS,
  RADII,
  accentSwatch,
  appearanceCssPretty,
  baseSwatch,
  chartSwatches,
  fontDef,
  shuffleAppearance,
} from '@/lib/appearanceTheme';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Snippet } from '@/components/ui/snippet';
import { SettingsGroup, SettingsIcon } from '@/components/settings/primitives';

/**
 * «Оформление» — студия темы. Пользователь двигает ТОН и ФОРМУ, канон остаётся дефолтом: пока все
 * поля стоят на «Atlavue», ни одна переменная не переопределяется (см. lib/appearance).
 *
 * Подача выбора — поле-карточка с выпадающим списком (референс владельца — ui.shadcn.com/create):
 * подпись сверху, текущее значение крупно, справа образец. Сетки свотчей не годились в узкой
 * панели-студии, а два разных вида выбора на одну настройку — это два места, где расходится
 * поведение.
 *
 * ДВА ХОЗЯИНА, ОДИН КОМПОНЕНТ:
 *  • `variant="settings"` — раздел модальных настроек: поля в две колонки + живой предпросмотр и
 *    полная копия CSS;
 *  • `variant="dock"` — левая панель поверх работающего приложения (AppearanceDock). Предпросмотра
 *    там нет намеренно: предпросмотр — это сами графики справа, ради них панель и открывают.
 *
 * Чего в студии нет и почему: зелёный/красный дельт и янтарный риска — семантика, а не вкус;
 * отдельного шрифта заголовков нет, потому что в вёрстке нет отдельного `font-display`, а вводить
 * его ради одной ручки — правка каждой страницы.
 */
export function AppearanceStudio({
  variant = 'settings',
  onLeaveSettings,
}: {
  variant?: 'settings' | 'dock';
  onLeaveSettings?: () => void;
}) {
  const settings = useAppearance();
  const { theme, mode, setMode } = useTheme();
  const canon = isCanonAppearance(settings);
  const dock = variant === 'dock';
  const css = useMemo(() => appearanceCssPretty(settings), [settings]);
  const preset = PRESETS.find((item) =>
    (Object.keys(APPEARANCE_DEFAULT) as Array<keyof AppearanceSettings>).every(
      (key) => item.settings[key] === settings[key],
    ),
  );

  const fields = (
    <>
      <FieldGroup dock={dock}>
        <Field
          label="Тема"
          value={THEME_OPTIONS.find((item) => item.key === mode)?.label ?? ''}
          glyph={<ThemeGlyph mode={mode} />}
          options={THEME_OPTIONS.map((item) => ({
            key: item.key,
            label: item.label,
            sample: <ThemeGlyph mode={item.key} />,
          }))}
          active={mode}
          onChange={(next) => setMode(next as ThemeMode)}
        />
        <Field
          label="Базовый цвет"
          value={BASES.find((item) => item.key === settings.base)?.label ?? ''}
          glyph={<Dot color={baseSwatch(settings.base, theme)} />}
          options={BASES.map((item) => ({
            key: item.key,
            label: item.label,
            sample: <Dot color={baseSwatch(item.key, theme)} />,
          }))}
          active={settings.base}
          onChange={(base) => patchAppearance({ base })}
        />
        <Field
          label="Акцент"
          value={ACCENTS.find((item) => item.key === settings.accent)?.label ?? ''}
          glyph={<Dot color={accentSwatch(settings.accent, theme)} />}
          options={ACCENTS.map((item) => ({
            key: item.key,
            label: item.label,
            sample: <Dot color={accentSwatch(item.key, theme)} />,
          }))}
          active={settings.accent}
          onChange={(accent) => patchAppearance({ accent })}
        />
        <Field
          label="Цвет графиков"
          value={chartLabel(settings.chart)}
          glyph={<Ramp colors={chartSwatches(settings.chart, settings.accent, theme)} />}
          options={CHART_OPTIONS.map((item) => ({
            key: item.key,
            label: item.label,
            sample: <Ramp colors={chartSwatches(item.key, settings.accent, theme)} />,
          }))}
          active={settings.chart}
          onChange={(chart) => patchAppearance({ chart })}
        />
      </FieldGroup>

      <FieldGroup dock={dock}>
        <Field
          label="Шрифт"
          value={fontDef(settings.font)?.label ?? ''}
          glyph={<FontGlyph stack={fontDef(settings.font)?.stack} />}
          // Список открыли — значит шрифты нужно ПОКАЗАТЬ: имена набраны своими начертаниями,
          // и семейства подтягиваются в простое браузера (см. lib/appearanceFonts).
          onOpen={prefetchAppearanceFonts}
          options={FONTS.map((item) => ({
            key: item.key,
            label: item.label,
            group: item.group,
            style: item.stack ? { fontFamily: item.stack } : undefined,
            sample: <FontGlyph stack={item.stack} />,
          }))}
          active={settings.font}
          onChange={(font) => patchAppearance({ font })}
        />
        <Field
          label="Скругление"
          value={`${RADII.find((item) => item.key === settings.radius)?.label ?? ''} px`}
          glyph={<RadiusGlyph radius={settings.radius} />}
          options={RADII.map((item) => ({
            key: item.key,
            label: `${item.label} px`,
            sample: <RadiusGlyph radius={item.key} />,
          }))}
          active={settings.radius}
          onChange={(radius) => patchAppearance({ radius })}
        />
      </FieldGroup>

      <FieldGroup dock={dock}>
        <Field
          label="Пресет"
          value={preset?.label ?? 'Свой'}
          glyph={<Dot color={accentSwatch(settings.accent, theme)} />}
          options={PRESETS.map((item) => ({
            key: item.key,
            label: item.label,
            sample: <Dot color={accentSwatch(item.settings.accent, theme)} />,
          }))}
          active={preset?.key ?? ''}
          onChange={(key) => {
            const next = PRESETS.find((item) => item.key === key);
            if (next) setAppearance(next.settings);
          }}
        />
      </FieldGroup>
    </>
  );

  const actions = (
    <div className={cn('flex flex-wrap gap-2', dock && 'flex-col')}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={dock ? 'w-full' : undefined}
        onClick={() => setAppearance(shuffleAppearance(settings))}
      >
        Случайно
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={canon}
        className={dock ? 'w-full' : undefined}
        onClick={() => setAppearance(APPEARANCE_DEFAULT)}
      >
        Сбросить
      </Button>
      {!dock && onLeaveSettings ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="hidden md:inline-flex"
          onClick={() => {
            setThemeStudioOpen(true);
            onLeaveSettings();
          }}
        >
          Настроить поверх приложения
        </Button>
      ) : null}
    </div>
  );

  if (dock) {
    return (
      <div className="flex flex-col">
        {fields}
        <div className="px-3 py-3">{actions}</div>
        <div className="border-t border-border px-3 py-3">
          <CopyCss css={css} className="w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsGroup
        title="Тема"
        description="Светлота поверхностей и чернил остаётся канонической — выбор двигает только тон, поэтому контраст текста к фону не может уехать."
      >
        <div className="px-5 py-5">
          {fields}
          <div className="mt-4">{actions}</div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Предпросмотр">
        <div className="px-5 py-5">
          <Preview />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Код"
        description="Те же переменные, что применились к интерфейсу: их можно перенести в любой проект на CSS-переменных."
      >
        <div className="px-5 py-4">
          <Snippet value={css} multiline copyLabel="Скопировать CSS" />
        </div>
      </SettingsGroup>
    </div>
  );
}

// ── Поле выбора ───────────────────────────────────────────────────────────────────────────────
const THEME_OPTIONS: Array<{ key: ThemeMode; label: string }> = [
  { key: 'light', label: 'Светлая' },
  { key: 'system', label: 'Системная' },
  { key: 'dark', label: 'Тёмная' },
];

const CHART_OPTIONS = [
  { key: 'canon', label: 'Канон' },
  { key: 'accent', label: 'Как акцент' },
  ...ACCENTS.filter((item) => item.key !== 'canon').map((item) => ({
    key: item.key,
    label: item.label,
  })),
];

const chartLabel = (key: string) =>
  CHART_OPTIONS.find((item) => item.key === key)?.label ?? 'Канон';

interface Option {
  key: string;
  label: string;
  sample: ReactNode;
  /** Заголовок раздела списка; повторяющиеся подряд значения печатаются один раз. */
  group?: string;
  /** Стиль подписи — семейством, которое эта строка и предлагает. */
  style?: CSSProperties;
}

/** Ряд полей: в панели — колонкой, в широких настройках — по две в строку. */
function FieldGroup({ dock, children }: { dock: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid gap-2 border-border px-3 py-3 [&+&]:border-t',
        dock ? 'grid-cols-1' : 'grid-cols-1 px-0 py-3 @min-[30rem]:grid-cols-2',
      )}
    >
      {children}
    </div>
  );
}

/**
 * Поле-карточка с выпадающим списком: подпись, текущее значение и образец справа. Список —
 * Radix-меню, то есть клавиатурная модель (стрелки, Home/End, набор буквами) достаётся даром, а
 * выбранный пункт помечен галочкой справа — как в референсе, а не точкой слева (дефолт примитива
 * гасится: `[&>span:first-child]:hidden`).
 */
function Field({
  label,
  value,
  glyph,
  options,
  active,
  onChange,
  onOpen,
}: {
  label: string;
  value: string;
  glyph: ReactNode;
  options: Option[];
  active: string;
  onChange: (key: string) => void;
  onOpen?: () => void;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) onOpen?.(); }}>
      <DropdownMenuTrigger
        className={cn(
          'flex min-h-11 w-full items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors',
          'hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 data-[state=open]:bg-muted/60',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-2xs text-muted-foreground">{label}</span>
          <span className="block truncate text-sm font-medium text-foreground">{value}</span>
        </span>
        {glyph}
      </DropdownMenuTrigger>
      {/* layer="modal": один из двух хозяев студии — САМ модальный диалог настроек, и на дефолтном
          слое меню открывалось бы ПОД его затемнением (поймано e2e). */}
      <DropdownMenuContent
        align="start"
        layer="modal"
        className="max-h-80 w-(--radix-dropdown-menu-trigger-width) min-w-48 overflow-y-auto"
      >
        <DropdownMenuRadioGroup value={active} onValueChange={onChange}>
          {options.map((option, index) => (
            <Fragment key={option.key}>
              {option.group && option.group !== options[index - 1]?.group ? (
                <DropdownMenuLabel className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-ink3">
                  {option.group}
                </DropdownMenuLabel>
              ) : null}
              <DropdownMenuRadioItem
                value={option.key}
                className="gap-2.5 pl-2 pr-2 [&>span:first-child]:hidden"
              >
                {option.sample}
                <span className="min-w-0 flex-1 truncate" style={option.style}>
                  {option.label}
                </span>
                {option.key === active ? (
                  <Check aria-hidden="true" className="ml-2 h-3.5 w-3.5 shrink-0" />
                ) : null}
              </DropdownMenuRadioItem>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Образцы ───────────────────────────────────────────────────────────────────────────────────
function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-4.5 w-4.5 shrink-0 rounded-full ring-1 ring-inset ring-foreground/10"
      style={{ backgroundColor: color }}
    />
  );
}

function Ramp({ colors }: { colors: string[] }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-4.5 w-4.5 shrink-0 flex-col overflow-hidden rounded-full ring-1 ring-inset ring-foreground/10"
    >
      {colors.slice(0, 3).map((color) => (
        <span key={color} className="flex-1" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

/** Квадрат с НАСТОЯЩИМ радиусом варианта — форму видно до выбора. */
function RadiusGlyph({ radius }: { radius: string }) {
  const value = RADII.find((item) => item.key === radius)?.value ?? '0.25rem';
  return (
    <span
      aria-hidden="true"
      className="h-4.5 w-4.5 shrink-0 border-2 border-foreground/40"
      style={{ borderRadius: `calc(${value} + 1px)` }}
    />
  );
}

/** «Aa» тем самым семейством, которое выбирают. */
function FontGlyph({ stack }: { stack?: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="w-4.5 shrink-0 text-center text-sm font-medium leading-none text-ink2"
      style={stack ? { fontFamily: stack } : undefined}
    >
      Aa
    </span>
  );
}

const THEME_ICON: Record<ThemeMode, 'sun' | 'monitor' | 'moon'> = {
  light: 'sun',
  system: 'monitor',
  dark: 'moon',
};

function ThemeGlyph({ mode }: { mode: ThemeMode }) {
  return <SettingsIcon name={THEME_ICON[mode]} className="h-4.5 w-4.5 shrink-0 text-ink2" />;
}

// ── Копия CSS одной кнопкой (в панели полный сниппет не помещается) ───────────────────────────
function CopyCss({ css, className }: { css: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <Button
        type="button"
        size="sm"
        className={className}
        onClick={() => {
          void navigator.clipboard.writeText(css).then(() => {
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 2_000);
          });
        }}
      >
        {copied ? 'Скопировано' : 'Скопировать CSS'}
      </Button>
      <span role="status" className="sr-only">
        {copied ? 'Скопировано' : ''}
      </span>
    </>
  );
}

// ── Живой предпросмотр (только в настройках) ──────────────────────────────────────────────────
const SERIES = [34, 41, 38, 52, 47, 63, 58, 71, 66, 82, 78, 94];

/** Одна карточка со всем сразу: акцент, палитра данных, радиус, шрифт и шкала чернил. */
function Preview() {
  const path = SERIES.map((value, i) => {
    const x = (i / (SERIES.length - 1)) * 100;
    const y = 100 - ((value - 30) / 70) * 100;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink3">Просмотры</span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-accent-foreground">
          30 дней
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2.5">
        <KpiValue size="compact" text="128 400" className="text-foreground" />
        <span className="text-xs font-medium text-verdant">↑ 12,4%</span>
      </div>
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="mt-3 h-16 w-full"
      >
        <path
          d={`${path} L100 100 L0 100 Z`}
          fill="hsl(var(--chart-role-primary))"
          fillOpacity={0.12}
        />
        <path
          d={path}
          fill="none"
          stroke="hsl(var(--chart-role-primary))"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {['Telegram', 'Instagram', 'Сайт', 'Рассылка', 'Реклама', 'Прочее'].map((label, i) => (
          <span key={label} className="flex items-center gap-1.5 text-2xs text-ink3">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: `hsl(var(--chart-${i + 1}-cat))` }}
            />
            {label}
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
        <Button type="button" size="sm">
          Сохранить
        </Button>
        <Button type="button" variant="secondary" size="sm">
          Отмена
        </Button>
        <span className="text-xs text-ink2">Вторичный текст</span>
      </div>
    </div>
  );
}
