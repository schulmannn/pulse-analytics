// Rule-based actionable insights for the Telegram dashboard. Pure + testable: a thin panel
// gathers the computed signals (deltas, best time, velocity, top post, hashtag lift) and this
// decides what's worth saying — as Insight → why → action, with a concrete evidence post.
// Mirrors lib/igInsights.ts but each insight carries why/action/evidence (the IG version is text-only).

import type { MetricDelta } from '@/lib/delta';
import { pluralRu } from '@/lib/format';

export interface TgInsightEvidence {
  caption?: string;
  permalink?: string | null;
  reach?: number;
  erv?: number | null;
}

export interface TgInsight {
  tone: 'up' | 'down' | 'neutral';
  /** Что произошло. */
  statement: string;
  /** Почему / контекст. */
  why?: string;
  /** Что сделать. */
  action?: string;
  /** Доказательство — конкретный пост. */
  evidence?: TgInsightEvidence;
}

export interface TgInsightInput {
  viewsDelta?: MetricDelta | null;
  subscriberChange?: number | null;
  erDelta?: MetricDelta | null;
  er?: number | null;
  bestWeekday?: string | null;
  peakHour?: number | null;
  velocity?: { day1Share?: number | null; t80Days?: number | null } | null;
  topPost?: { caption: string; reach: number; erv: number | null; permalink: string | null } | null;
  topHashtag?: { tag: string; lift: number } | null;
  postsCount?: number;
}

const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pctStr = (d: MetricDelta) => (d.pct >= 100 ? d.pct.toFixed(0) : d.pct.toFixed(1));

export function buildTgInsights(i: TgInsightInput): TgInsight[] {
  const out: TgInsight[] = [];
  const evidence: TgInsightEvidence | undefined = i.topPost
    ? { caption: i.topPost.caption, permalink: i.topPost.permalink, reach: i.topPost.reach, erv: i.topPost.erv }
    : undefined;

  // Channel-wide views trend from channel_daily. A top post is supporting context, not the source
  // of this total: publication views and the channel-wide daily flow answer different questions.
  if (i.viewsDelta && i.viewsDelta.dir !== 'flat') {
    const up = i.viewsDelta.dir === 'up';
    out.push({
      tone: up ? 'up' : 'down',
      statement: `Просмотры канала ${up ? 'выросли' : 'снизились'} на ${pctStr(i.viewsDelta)}% к прошлому периоду.`,
      why: up
        ? 'Суммарный дневной поток просмотров выше, чем в прошлом окне.'
        : 'Суммарный дневной поток просмотров ниже, чем в прошлом окне.',
      action: up
        ? 'Проверьте дни роста в разборе метрики «Просмотры», затем сопоставьте их с публикациями.'
        : 'Откройте разбор метрики «Просмотры» и сопоставьте дни снижения с темами и частотой публикаций.',
      evidence,
    });
  }

  // Subscriber movement.
  if (i.subscriberChange != null && i.subscriberChange !== 0) {
    const up = i.subscriberChange > 0;
    out.push({
      tone: up ? 'up' : 'down',
      statement: up
        ? `База выросла на ${fmtInt(i.subscriberChange)} ${pluralRu(i.subscriberChange, ['подписчика', 'подписчика', 'подписчиков'])} за период.`
        : `База сократилась на ${fmtInt(Math.abs(i.subscriberChange))} ${pluralRu(Math.abs(i.subscriberChange), ['подписчика', 'подписчика', 'подписчиков'])} за период.`,
      why: up ? undefined : 'Охваты могут расти даже при оттоке — стоит понять причину.',
      action: up ? undefined : 'Посмотрите, после каких постов уходят, в разделе «Рост».',
    });
  }

  // Engagement trend. erDelta is a reactions+forwards flow-delta (direction), NOT the per-member
  // ER ratio — so we report direction/magnitude only and don't pin an "ER Y%" level to it.
  if (i.erDelta && i.erDelta.dir !== 'flat') {
    const up = i.erDelta.dir === 'up';
    out.push({
      tone: up ? 'up' : 'down',
      statement: `Вовлечённость ${up ? 'выросла' : 'снизилась'} на ${pctStr(i.erDelta)}% к прошлому периоду.`,
      action: up ? undefined : 'Добавьте вопросы, опросы и явные призывы к реакции.',
    });
  }

  // Best publishing window.
  if (i.bestWeekday || i.peakHour != null) {
    const parts = [
      i.bestWeekday ?? null,
      i.peakHour != null ? `около ${i.peakHour}:00` : null,
    ].filter(Boolean);
    out.push({
      tone: 'neutral',
      statement: `Лучшее окно для публикаций — ${parts.join(' ')}.`,
      why: i.postsCount != null && i.postsCount < 8 ? `Мало постов (${i.postsCount}) — оценка приблизительная.` : undefined,
      action: 'Ставьте ключевые посты на этот слот — там выше охват.',
    });
  }

  // Velocity / shelf-life.
  if (i.velocity?.day1Share != null && i.velocity.day1Share > 0) {
    out.push({
      tone: 'neutral',
      statement: `За первые сутки пост набирает ~${Math.round(i.velocity.day1Share)}% охвата.`,
      why: i.velocity.t80Days != null ? `80% охвата приходит примерно за ${i.velocity.t80Days} дн.` : undefined,
      action: 'Анонсируйте важное сразу после публикации, пока пост «горячий».',
    });
  }

  // Hashtag lift.
  if (i.topHashtag && i.topHashtag.lift > 5) {
    out.push({
      tone: 'up',
      statement: `Хэштег ${i.topHashtag.tag} поднимает вовлечённость на +${i.topHashtag.lift.toFixed(0)}%.`,
      action: 'Используйте его в тематических постах.',
    });
  }

  return out;
}
