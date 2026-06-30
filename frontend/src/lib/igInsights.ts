// Rule-based auto-insights for Instagram — turns computed metrics into a few evidence-backed
// takeaways. Each insight carries the numbers behind it and a confidence level, so the UI reads
// like an analyst's note ("here's the claim, here's the proof, here's how sure we are"), not a
// generic AI summary. Pure + testable: the panel gathers inputs, this decides what's worth saying.
export type Confidence = 'high' | 'medium' | 'low';

export interface IgInsightInput {
  /** Real subscriber movement for the window: net = gross follows − gross unfollows. */
  netFollowers?: number | null;
  follows?: number | null;
  unfollows?: number | null;
  erReach?: number;
  erReachPrev?: number;
  /** Best format by interactions, with the raw share so the evidence is concrete. */
  bestFormat?: { label: string; sharePct: number; interactions: number; total: number } | null;
  /** Pass ONLY when online_followers actually returned data — null suppresses the insight so the
      UI never claims a "best time" from an empty metric. */
  bestSlot?: { day: string; hour: number; online: number } | null;
  topHashtag?: { tag: string; lift: number; count: number } | null;
  topPost?: { reach: number; type?: string | null } | null;
  /** Number of posts the rates are computed over — drives confidence (small n → lower). */
  postCount?: number;
}

export interface IgInsight {
  tone: 'up' | 'down' | 'neutral';
  text: string;
  evidence?: string;
  confidence: Confidence;
  /** Higher = surfaced first; lets the Overview take just the single strongest takeaway. */
  priority: number;
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'высокая уверенность',
  medium: 'средняя уверенность',
  low: 'низкая уверенность',
};

const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function buildIgInsights(i: IgInsightInput): IgInsight[] {
  const out: IgInsight[] = [];
  const n = i.postCount ?? 0;

  // Real subscriber movement (net = follows − unfollows) — the headline signal. A net loss matters
  // as much as growth, so it's surfaced too (the old logic only ever reported gross follows).
  if (i.netFollowers != null) {
    const ev =
      i.follows != null && i.unfollows != null
        ? `подписки +${fmtInt(i.follows)}, отписки −${fmtInt(i.unfollows)}`
        : undefined;
    const net = i.netFollowers;
    if (net < 0) {
      out.push({
        tone: 'down',
        text: 'Канал теряет подписчиков — отписок больше, чем подписок.',
        evidence: [`чистый прирост −${fmtInt(Math.abs(net))} за период`, ev].filter(Boolean).join(' · '),
        confidence: 'high',
        priority: 95,
      });
    } else if (net > 0) {
      out.push({
        tone: 'up',
        text: 'Канал растёт по подписчикам.',
        evidence: [`чистый прирост +${fmtInt(net)} за период`, ev].filter(Boolean).join(' · '),
        confidence: 'high',
        priority: 90,
      });
    } else {
      out.push({
        tone: 'neutral',
        text: 'Подписчики на месте — подписки и отписки уравновешены.',
        evidence: ev,
        confidence: 'medium',
        priority: 55,
      });
    }
  }

  // Engagement-rate trend.
  if (i.erReach != null && i.erReach > 0) {
    if (i.erReachPrev != null && i.erReachPrev > 0 && i.erReach.toFixed(2) !== i.erReachPrev.toFixed(2)) {
      const up = i.erReach > i.erReachPrev;
      out.push({
        tone: up ? 'up' : 'down',
        text: `Вовлечённость ${up ? 'выросла' : 'снизилась'}.`,
        evidence: `ER по охвату ${i.erReach.toFixed(2)}% (было ${i.erReachPrev.toFixed(2)}%)`,
        confidence: n >= 5 ? 'high' : 'medium',
        priority: 80,
      });
    } else {
      out.push({
        tone: 'neutral',
        text: 'Вовлечённость держится стабильно.',
        evidence: `ER по охвату ${i.erReach.toFixed(2)}%`,
        confidence: n >= 5 ? 'medium' : 'low',
        priority: 40,
      });
    }
  }

  // Best format by interactions — actionable, but needs enough volume to trust.
  if (i.bestFormat && i.bestFormat.total > 0 && i.bestFormat.sharePct >= 40) {
    out.push({
      tone: 'up',
      text: `${i.bestFormat.label} собирают больше всего взаимодействий.`,
      evidence: `${i.bestFormat.sharePct.toFixed(0)}% (${fmtInt(i.bestFormat.interactions)} из ${fmtInt(i.bestFormat.total)})`,
      confidence: i.bestFormat.total >= 1000 ? 'high' : 'medium',
      priority: 70,
    });
  }

  // Hashtag lift — only when used enough times to mean something.
  if (i.topHashtag && i.topHashtag.lift > 5 && i.topHashtag.count >= 2) {
    out.push({
      tone: 'up',
      text: `${i.topHashtag.tag} поднимает вовлечённость публикаций.`,
      evidence: `+${i.topHashtag.lift.toFixed(0)}% к среднему ER · использован ${i.topHashtag.count}×`,
      confidence: i.topHashtag.count >= 4 ? 'medium' : 'low',
      priority: 50,
    });
  }

  // Best time — emitted ONLY when online_followers had real data (caller passes null otherwise).
  if (i.bestSlot) {
    out.push({
      tone: 'neutral',
      text: `Аудитория активнее всего в ${i.bestSlot.day} ${i.bestSlot.hour}:00.`,
      evidence: `~${fmtInt(i.bestSlot.online)} онлайн в этот час`,
      confidence: 'low',
      priority: 45,
    });
  }

  // Top post reach — factual context.
  if (i.topPost && i.topPost.reach > 0) {
    out.push({
      tone: 'neutral',
      text: 'Лучшая публикация заметно опережает остальные.',
      evidence: `${fmtInt(i.topPost.reach)} охвата`,
      confidence: 'high',
      priority: 35,
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}
