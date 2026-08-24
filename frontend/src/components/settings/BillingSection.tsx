import { useChannels } from '@/api/queries';
import { useTeam } from '@/api/team';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { PLAN_LABEL, setPlan, usePlan, type PlanId } from '@/lib/plan';
import { SettingsGroup, SettingsIcon } from '@/components/settings/primitives';

/**
 * «Подписка» — план как данные, а не маркетинговый список: сводка текущего тарифа несёт живые
 * usage-метры (источники и места команды из уже закэшированных сторов), карточки тарифов лежат
 * стеком утопленными панелями (bg-background внутри bg-card). UI-preview: оплата не подключена,
 * выбор плана переключает локальный `pulse_plan` без изменения доступа. Ровно один solid-CTA на
 * всю секцию — рекомендуемый тариф (канон «одно solid-primary действие на settings-view»).
 */

interface PlanDef {
  id: PlanId;
  price: number;
  blurb: string;
  features: string[];
  /** Числовые лимиты плана — источник для usage-метров сводки. */
  limits: { sources: number; seats: number; history: string };
}

const PLANS: PlanDef[] = [
  {
    id: 'free',
    price: 0,
    blurb: 'Личный дашборд для одного канала.',
    features: ['1 источник данных', 'История 30 дней', 'Базовые виджеты и графики', '1 отчёт'],
    // seats — места для КОЛЛЕГ, владелец не в счёт (тот же счёт, что в TEAM_LIMIT и в ростере).
    // На Free команды нет вовсе, поэтому 0, а не «одно место под самого себя».
    limits: { sources: 1, seats: 0, history: '30 дней' },
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
    limits: { sources: 5, seats: 3, history: '12 месяцев' },
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
    limits: { sources: 20, seats: 10, history: 'без лимита' },
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
    <div className="space-y-8">
      <SettingsGroup>
        <div className="px-5 py-4 @min-[32rem]:py-5">
          <div className="flex flex-col gap-3 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:justify-between @min-[32rem]:gap-6">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Текущий план</div>
              <div className="mt-1 max-w-[56ch] text-xs leading-relaxed text-ink3">{current.blurb}</div>
            </div>
            <span className="flex shrink-0 items-baseline gap-2">
              <span className="text-lg font-medium tracking-tight text-foreground">
                {PLAN_LABEL[current.id]}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {current.price > 0 ? `$${current.price}/мес` : 'бесплатно'}
              </span>
            </span>
          </div>
        </div>
        <PlanUsage limits={current.limits} />
      </SettingsGroup>

      <SettingsGroup title="Тарифы">
        <div className="px-5 py-5">
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
          <p className="mt-4 max-w-[64ch] text-2xs leading-relaxed text-ink3">
            Тарифы в предпросмотре: оплата ещё не подключена, выбор плана переключается локально и не
            меняет доступ к данным.
          </p>
        </div>
      </SettingsGroup>
    </div>
  );
}

/**
 * Живое использование против лимитов плана. Источники — из общего реестра каналов (кэш сайдбара),
 * команда — серверный ростер воркспейса (`/api/team`); история — статичная глубина архива.
 * Места считаются ДЛЯ КОЛЛЕГ, владелец не в счёт — та же величина, что печатают шапка и тело
 * раздела «Команда» (раньше три поверхности считали её тремя способами).
 */
function PlanUsage({ limits }: { limits: PlanDef['limits'] }) {
  const { data } = useChannels();
  const team = useTeam({ enabled: limits.seats > 0 });
  const sources = data?.enabled === false ? null : (data?.channels.length ?? null);

  return (
    <div className="grid gap-x-6 gap-y-4 px-5 py-4 @min-[30rem]:grid-cols-3 @min-[32rem]:py-5">
      <UsageMeter
        label="Источники"
        value={sources}
        cap={limits.sources}
      />
      <UsageMeter label="Коллеги" value={team.data?.seats.used ?? null} cap={limits.seats} />
      <div className="min-w-0">
        <div className="text-xs text-ink3">История</div>
        <div className="mt-1 text-sm font-medium tabular-nums text-foreground">{limits.history}</div>
        <div className="mt-2 text-2xs text-ink3">глубина архива</div>
      </div>
    </div>
  );
}

function UsageMeter({ label, value, cap }: { label: string; value: number | null; cap: number }) {
  // cap = 0 (команда на Free) — деление дало бы NaN в ширине полосы; такой лимит показываем
  // словами, а не «0 из 0».
  const unavailable = cap <= 0;
  const percent = value == null || unavailable ? 0 : Math.min(100, Math.round((value / cap) * 100));
  const text = unavailable ? 'нет на плане' : value == null ? '—' : `${value} из ${cap}`;
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink3">{label}</div>
      <div className="mt-1 text-sm font-medium tabular-nums text-foreground">{text}</div>
      <Progress
        value={percent}
        aria-label={`${label}: ${text}`}
        className="mt-2 h-1"
      />
    </div>
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
        'flex flex-col rounded-xl border bg-background p-4 @min-[28rem]:p-5',
        active ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex flex-col gap-3 @min-[28rem]:flex-row @min-[28rem]:items-center @min-[28rem]:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{PLAN_LABEL[plan.id]}</span>
          <span className="text-lg font-medium tabular-nums tracking-tight text-foreground">
            ${plan.price}
          </span>
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
      <ul className="mt-3.5 grid flex-1 gap-x-5 gap-y-1.5 @min-[28rem]:grid-cols-2">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-xs text-ink2">
            <SettingsIcon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink3" />
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
