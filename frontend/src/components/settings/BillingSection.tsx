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
      <div className="py-4">
        <div className="grid gap-3 sm:grid-cols-3">
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
      className={cn(
        'flex flex-col rounded-lg border p-4',
        active ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{PLAN_LABEL[plan.id]}</span>
        {active && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
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
      <button
        type="button"
        disabled={active}
        onClick={() => setPlan(plan.id)}
        className={cn(
          'btn-pill mt-4 w-full px-3 py-1.5 text-xs font-medium transition-colors',
          active
            ? 'cursor-default border border-border text-muted-foreground'
            : plan.id === 'free'
              ? 'border border-border text-foreground hover:bg-muted'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
        )}
      >
        {active ? 'Текущий план' : plan.id === 'free' ? 'Перейти на Free' : `Перейти на ${PLAN_LABEL[plan.id]}`}
      </button>
    </div>
  );
}
