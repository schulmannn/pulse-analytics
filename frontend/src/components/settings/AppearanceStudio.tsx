import { useMemo, type ReactNode } from 'react';
import { patchAppearance, setAppearance, useAppearance } from '@/lib/appearance';
import {
  APPEARANCE_DEFAULT,
  isCanonAppearance,
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
  shuffleAppearance,
} from '@/lib/appearanceTheme';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Snippet } from '@/components/ui/snippet';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SettingsGroup, SettingsIcon, SettingsRow, type SettingsIconName } from '@/components/settings/primitives';

/**
 * «Оформление» — студия темы. Пользователь двигает ТОН и ФОРМУ, канон остаётся дефолтом: пока
 * все ручки стоят на «Atlavue», ни одна переменная не переопределяется (см. lib/appearance).
 *
 * Предпросмотр здесь намеренно маленький: настройки открыты ОВЕРЛЕЕМ поверх рабочей страницы, и
 * настоящий предпросмотр — само приложение за диалогом, которое перекрашивается на том же кадре.
 * Карточка ниже нужна, чтобы увидеть акцент, палитру данных, радиус и шрифт РЯДОМ, не закрывая
 * настройки.
 *
 * Чего в студии нет и почему: зелёный/красный дельт и янтарный риска — семантика, а не вкус;
 * отдельного шрифта заголовков нет, потому что в вёрстке нет отдельного `font-display`, а вводить
 * его ради одной ручки — правка каждой страницы.
 */
export function AppearanceStudio() {
  const settings = useAppearance();
  const { theme } = useTheme();
  const canon = isCanonAppearance(settings);
  const css = useMemo(() => appearanceCssPretty(settings), [settings]);
  const activePreset = PRESETS.find((preset) =>
    (Object.keys(APPEARANCE_DEFAULT) as Array<keyof AppearanceSettings>).every(
      (key) => preset.settings[key] === settings[key],
    ),
  );

  return (
    <div className="space-y-8">
      <SettingsGroup title="Тема">
        <SettingsRow
          title="Цветовая схема"
          description="Светлая, тёмная или синхронизированная с настройками системы. Хранится на этом устройстве."
          footer={<ThemeControl />}
        />
        <SettingsRow
          title="Пресет"
          description="Готовое сочетание акцента, нейтрали, палитры данных и формы."
          control={
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setAppearance(shuffleAppearance(settings))}
              >
                Случайно
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={canon}
                onClick={() => setAppearance(APPEARANCE_DEFAULT)}
              >
                Сбросить
              </Button>
            </>
          }
          footer={
            <div className="mt-4 flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  aria-pressed={activePreset?.key === preset.key}
                  onClick={() => setAppearance(preset.settings)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50',
                    activePreset?.key === preset.key
                      ? 'border-primary bg-primary/10 font-medium text-accent-foreground'
                      : 'border-border bg-background text-ink2 hover:bg-muted hover:text-foreground',
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Предпросмотр">
        <div className="px-5 py-5">
          <Preview />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Цвет"
        description="Светлота поверхностей и чернил остаётся канонической — выбор двигает только тон, поэтому контраст текста к фону не может уехать."
      >
        <SettingsRow
          title="Акцент"
          description="Ссылки, активные состояния, кнопка действия и линия одиночной серии."
          footer={
            <ChoiceGrid
              legend="Акцент интерфейса"
              options={ACCENTS.map((accent) => ({
                key: accent.key,
                label: accent.label,
                sample: <Dot color={accentSwatch(accent.key, theme)} />,
              }))}
              value={settings.accent}
              onChange={(accent) => patchAppearance({ accent })}
            />
          }
        />
        <SettingsRow
          title="Базовый цвет"
          description="Температура холста, панелей и hairline-линий."
          footer={
            <ChoiceGrid
              legend="Базовый цвет"
              options={BASES.map((base) => ({
                key: base.key,
                label: base.label,
                sample: <Dot color={baseSwatch(base.key, theme)} />,
              }))}
              value={settings.base}
              onChange={(base) => patchAppearance({ base })}
            />
          }
        />
        <SettingsRow
          title="Палитра данных"
          description="«Канон» — категориальный набор Okabe-Ito, различимый при дальтонизме. Любой другой выбор превращает серии в шесть ступеней одного тона: красиво, но соседние категории различаются слабее — их по-прежнему держат подписи и легенда."
          footer={
            <ChoiceGrid
              legend="Палитра данных"
              options={[
                { key: 'canon', label: 'Канон' },
                { key: 'accent', label: 'Как акцент' },
                ...ACCENTS.filter((accent) => accent.key !== 'canon').map((accent) => ({
                  key: accent.key,
                  label: accent.label,
                })),
              ].map((option) => ({
                key: option.key,
                label: option.label,
                sample: <Ramp colors={chartSwatches(option.key, settings.accent, theme)} />,
              }))}
              value={settings.chart}
              onChange={(chart) => patchAppearance({ chart })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Форма и текст">
        <SettingsRow
          title="Скругление"
          description="Радиус панелей, полей ввода и карточек, в пикселях."
          control={
            <SegmentedControl
              ariaLabel="Скругление"
              value={settings.radius}
              onChange={(radius) => patchAppearance({ radius })}
              options={RADII.map((option) => ({
                value: option.key,
                content: option.label,
                ariaLabel: `${option.label} пикселей`,
              }))}
            />
          }
        />
        <SettingsRow
          title="Шрифт интерфейса"
          description="Только системные семейства — ничего не скачивается дополнительно."
          control={
            <SegmentedControl
              ariaLabel="Шрифт интерфейса"
              value={settings.font}
              onChange={(font) => patchAppearance({ font })}
              options={FONTS.map((option) => ({
                value: option.key,
                content: (
                  <span style={option.stack ? { fontFamily: option.stack } : undefined}>
                    {option.label}
                  </span>
                ),
              }))}
            />
          }
        />
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

// ── Выбор из набора ───────────────────────────────────────────────────────────────────────────
interface Choice {
  key: string;
  label: string;
  sample: ReactNode;
}

/**
 * Сетка образцов. Кнопки с `aria-pressed`, а не radiogroup: так же устроен выбор темы выше, и
 * читалка объявляет состояние без подмены семантики нативных радиокнопок.
 */
function ChoiceGrid({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: Choice[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <fieldset className="m-0 mt-4 grid min-w-0 grid-cols-2 gap-2 @min-[30rem]:grid-cols-3">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.key)}
            className={cn(
              'flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 sm:min-h-0',
              active
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-background text-ink2 hover:bg-muted hover:text-foreground',
            )}
          >
            {option.sample}
            <span className="truncate text-xs">{option.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 shrink-0 rounded-full ring-1 ring-inset ring-foreground/10"
      style={{ backgroundColor: color }}
    />
  );
}

function Ramp({ colors }: { colors: string[] }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 flex-col overflow-hidden rounded-full ring-1 ring-inset ring-foreground/10"
    >
      {colors.slice(0, 3).map((color) => (
        <span key={color} className="flex-1" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

// ── Живой предпросмотр ────────────────────────────────────────────────────────────────────────
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
        <span className="text-3xl font-medium tabular-nums tracking-tight text-foreground">
          128 400
        </span>
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

// ── Светлая / тёмная / системная ──────────────────────────────────────────────────────────────
const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: SettingsIconName }> = [
  { value: 'light', label: 'Светлая', icon: 'sun' },
  { value: 'system', label: 'Системная', icon: 'monitor' },
  { value: 'dark', label: 'Тёмная', icon: 'moon' },
];

function ThemeControl() {
  const { mode, setMode } = useTheme();
  return (
    <fieldset className="m-0 mt-4 grid min-w-0 grid-cols-3 gap-2">
      <legend className="sr-only">Тема интерфейса</legend>
      {THEME_OPTIONS.map((option) => {
        const active = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setMode(option.value)}
            className={cn(
              'min-w-0 rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50',
              active
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <ThemePreview mode={option.value} />
            <span className="mt-2 flex min-w-0 items-center gap-1.5 px-0.5">
              <SettingsIcon name={option.icon} className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">{option.label}</span>
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

function ThemePreview({ mode }: { mode: ThemeMode }) {
  if (mode === 'system') {
    return (
      <span
        aria-hidden="true"
        className="grid h-16 grid-cols-2 overflow-hidden rounded-lg border border-border"
      >
        <ThemePreviewPanel className="force-light border-r" />
        <ThemePreviewPanel className="dark" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block h-16 overflow-hidden rounded-lg border border-border',
        mode === 'light' ? 'force-light' : 'dark',
      )}
      style={{ borderColor: 'hsl(var(--border))' }}
    >
      <ThemePreviewPanel />
    </span>
  );
}

function ThemePreviewPanel({ className }: { className?: string }) {
  return (
    <span
      className={cn('flex h-full min-w-0 gap-1.5 p-2', className)}
      style={{
        backgroundColor: 'hsl(var(--background))',
        borderColor: 'hsl(var(--border))',
      }}
    >
      <span className="w-2 shrink-0 rounded" style={{ backgroundColor: 'hsl(var(--muted))' }} />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span
          className="block h-1.5 w-3/4 rounded-full"
          style={{ backgroundColor: 'hsl(var(--foreground))' }}
        />
        {[0, 1].map((line) => (
          <span
            key={line}
            className="block h-2.5 rounded border"
            style={{
              backgroundColor: 'hsl(var(--card))',
              borderColor: 'hsl(var(--border))',
            }}
          />
        ))}
      </span>
    </span>
  );
}
