import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PLAN_LABEL, setPlan, usePlan, type PlanId } from '@/lib/plan';
import { SettingsGroup, SettingsIcon, SettingsRow } from '@/components/settings/primitives';

/**
 * «Подписка» — plan overview + tier comparison (Free / Pro / Max, USD). UI-preview only:
 * payments aren't wired, so picking a plan flips the local `pulse_plan` flag (plan-gated
 * surfaces render) without touching server access. The columns are a structural comparison
 * table — hairline borders, the active tier marked by a primary border, zero shadows.
 */

interface PlanDef {
  id: PlanId;
  price: number;
  blurb: string;
  features: string[];
}

const PLANS: PlanDef[] = [
  {
    id: 'free',
    price: 0,
    blurb: 'Личный дашборд для одного канала.',
    features: ['1 источник данных', 'История 30 дней', 'Базовые виджеты и графики', '1 отчёт'],
  },
  {
    id: 'pro',
    price: 12,
    blurb: 'Для авторов и растущих каналов.',
    features: [
      'До 5 источников',
      'История 12 месяцев',
      'Отчёты + email-рассылка',
      'Экспорт CSV и PNG',
      'Команда до 3 участников',
    ],
  },
  {
    id: 'max',
    price: 29,
    blurb: 'Для команд и агентств.',
    features: [
      'До 20 источников',
      'Полная история без лимита',
      'Команда до 10 участников',
      'API-доступ',
      'Приоритетная поддержка',
    ],
  },
];

export function BillingSection() {
  const plan = usePlan();
  const current = PLANS.find((p) => p.id === plan) ?? PLANS[0];

  return (
    <SettingsGroup>
      <SettingsRow
        title="Текущий план"
        description={current.blurb}
        control={
          <span className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">{PLAN_LABEL[current.id]}</span>
            <span className="text-xs text-muted-foreground">
              {current.price > 0 ? `$${current.price}/мес` : 'бесплатно'}
            </span>
          </span>
        }
      />
      <div className="@container py-4">
        <div className="grid gap-3 @min-[40rem]:grid-cols-3">
          {PLANS.map((p) => (
            <PlanCard key={p.id} plan={p} active={p.id === plan} />
          ))}
        </div>
        <p className="mt-3 max-w-[64ch] text-2xs leading-relaxed text-ink3">
          Тарифы в предпросмотре: оплата ещё не подключена, выбор плана переключается локально и не
          меняет доступ к данным.
        </p>
      </div>
    </SettingsGroup>
  );
}

function PlanCard({ plan, active }: { plan: PlanDef; active: boolean }) {
  return (
    <div
      data-settings-plan-card=""
      className={cn(
        'flex flex-col rounded-lg border p-4',
        active ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{PLAN_LABEL[plan.id]}</span>
        {active && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-accent-foreground">
            Текущий
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-medium tabular-nums text-foreground">${plan.price}</span>
        <span className="text-xs text-muted-foreground">/мес</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink3">{plan.blurb}</p>
      <ul className="mt-3 flex-1 space-y-1.5">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-xs text-ink2">
            <SettingsIcon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verdant" />
            {f}
          </li>
        ))}
      </ul>
      {/* Канонический Button: solid-ветка = variant default как есть; тихие ветки = secondary с
          прозрачным фоном (кнопка лежит прямо на bg-card диалога настроек — bg-background из
          варианта дал бы видимую плашку). h-auto py-1.5 вместо фикс-высоты xs сохраняет прежнюю
          авто-геометрию: у ветвей с бордером внешняя высота на 2px больше solid-ветки, как и было.
          Активная ветка — постоянное disabled-состояние с собственным стилем, поэтому дефолтное
          disabled:opacity-50 возвращено к полной непрозрачности (раньше затемнения не было). */}
      <Button
        type="button"
        disabled={active}
        onClick={() => setPlan(plan.id)}
        variant={active || plan.id === 'free' ? 'secondary' : 'default'}
        size="xs"
        className={cn(
          'mt-4 h-auto w-full py-1.5',
          active
            ? 'bg-transparent text-muted-foreground disabled:opacity-100'
            : plan.id === 'free' && 'bg-transparent',
        )}
      >
        {active ? 'Текущий план' : plan.id === 'free' ? 'Перейти на Free' : `Перейти на ${PLAN_LABEL[plan.id]}`}
      </Button>
    </div>
  );
}
