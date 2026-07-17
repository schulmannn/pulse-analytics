/**
 * Контекст вопроса AI-ассистенту (STEEP-паттерн): выбранные источники (@) и период (часы)
 * из пикеров под полем ввода. Контекст НЕ отдельное API-поле — он честно дописывается в текст
 * вопроса строкой «(Контекст — …)»: пользователь видит ровно то, что ушло модели, бэкенд и
 * персист не меняются, а channel_id в скобках позволяет модели бить инструментами точно
 * в выбранный источник. Чистые функции — тестируются без React (aiAsk.test.ts).
 */

export type AiAskContext = {
  sourceIds: number[];
  period: AiPeriodKey | null;
};

export const emptyAiAskContext: AiAskContext = { sourceIds: [], period: null };

export const AI_PERIODS = [
  { key: 'this_week', label: 'Эта неделя' },
  { key: 'this_month', label: 'Этот месяц' },
  { key: 'this_year', label: 'Этот год' },
  { key: 'last_week', label: 'Прошлая неделя' },
  { key: 'last_month', label: 'Прошлый месяц' },
  { key: 'last_year', label: 'Прошлый год' },
] as const;
export type AiPeriodKey = (typeof AI_PERIODS)[number]['key'];

export const aiPeriodLabel = (key: AiPeriodKey | null): string | null =>
  AI_PERIODS.find((p) => p.key === key)?.label ?? null;

/** Минимальная форма источника для подписи чипа/контекста (структурно совместима с Channel). */
export type AiAskSource = { id: number; username?: string | null; title?: string | null };

export const aiSourceLabel = (s: AiAskSource): string =>
  s.username ? `@${s.username}` : s.title || `Источник ${s.id}`;

/** Итоговый текст вопроса: тримленный ввод + строка контекста (если что-то выбрано). */
export function composeAiQuestion(
  text: string,
  ctx: AiAskContext,
  sources: readonly AiAskSource[],
): string {
  const q = text.trim();
  const parts: string[] = [];
  if (ctx.sourceIds.length) {
    const names = ctx.sourceIds.map((id) => {
      const src = sources.find((s) => s.id === id);
      return src ? `${aiSourceLabel(src)} (channel_id=${id})` : `channel_id=${id}`;
    });
    parts.push(`${ctx.sourceIds.length > 1 ? 'источники' : 'источник'}: ${names.join(', ')}`);
  }
  const period = aiPeriodLabel(ctx.period);
  if (period) parts.push(`период: ${period.toLowerCase()}`);
  return parts.length ? `${q}\n\n(Контекст — ${parts.join('; ')})` : q;
}

export const toggleAiSource = (ctx: AiAskContext, id: number): AiAskContext => ({
  ...ctx,
  sourceIds: ctx.sourceIds.includes(id)
    ? ctx.sourceIds.filter((x) => x !== id)
    : [...ctx.sourceIds, id],
});

export const setAiPeriod = (ctx: AiAskContext, period: AiPeriodKey | null): AiAskContext => ({
  ...ctx,
  // Повторный выбор того же периода снимает его (toggle) — как повторный клик по чипу.
  period: ctx.period === period ? null : period,
});
