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

const RECOMMENDED: Record<PlanId, PlanId | null> = {
  free: 'pro',
  pro: 'max',
  max: null,
};

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
      <div className="px-4 py-4">
        <div className="grid gap-3">
          {PLANS.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              active={p.id === plan}
              recommended={p.id === RECOMMENDED[plan]}
            />
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

function PlanCard({
  plan,
  active,
  recommended,
}: {
  plan: PlanDef;
  active: boolean;
  recommended: boolean;
}) {
  return (
    <div
      data-settings-plan-card=""
      className={cn(
        'flex flex-col rounded-lg border p-4',
        active ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex flex-col gap-3 @min-[28rem]:flex-row @min-[28rem]:items-center @min-[28rem]:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{PLAN_LABEL[plan.id]}</span>
          <span className="text-lg font-medium tabular-nums text-foreground">${plan.price}</span>
          <span className="text-xs text-muted-foreground">/мес</span>
        </div>
        {/* h-auto/py-1.5 keeps the legacy CTA geometry while the hierarchy changes by plan. */}
        <Button
          type="button"
          disabled={active}
          onClick={() => setPlan(plan.id)}
          variant={recommended ? 'default' : 'secondary'}
          size="xs"
          className={cn(
            'h-auto w-full py-1.5 @min-[28rem]:w-auto',
            active && 'text-muted-foreground disabled:opacity-100',
          )}
        >
          {active
            ? 'Текущий план'
            : plan.id === 'free'
              ? 'Перейти на Free'
              : `Перейти на ${PLAN_LABEL[plan.id]}`}
        </Button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink3">{plan.blurb}</p>
      <ul className="mt-3 grid flex-1 gap-x-5 gap-y-1.5 @min-[28rem]:grid-cols-2">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-xs text-ink2">
            <SettingsIcon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verdant" />
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
