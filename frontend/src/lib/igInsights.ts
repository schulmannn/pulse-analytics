// Rule-based auto-insights for the Instagram dashboard — turns the computed metrics into
// plain-language takeaways ("best format of the week", growth pace, etc.). Pure + testable:
// the panel gathers the inputs, this decides what's worth saying and how to phrase it.

export interface IgInsightInput {
  followersDelta?: { dir: 'up' | 'down' | 'flat'; pct: number } | null;
  newFollowers?: number;
  erReach?: number;
  erReachPrev?: number;
  bestFormat?: { label: string; sharePct: number } | null;
  bestSlot?: { day: string; hour: number } | null;
  topHashtag?: { tag: string; lift: number } | null;
  topPostReach?: number | null;
  topCountry?: string | null;
  topAge?: string | null;
}

export interface IgInsight {
  tone: 'up' | 'down' | 'neutral';
  text: string;
}

const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function buildIgInsights(i: IgInsightInput): IgInsight[] {
  const out: IgInsight[] = [];

  // Follower growth pace.
  if (i.newFollowers != null && i.newFollowers > 0) {
    const d = i.followersDelta;
    if (d && d.dir !== 'flat') {
      out.push({
        tone: d.dir === 'up' ? 'up' : 'down',
        text: `Прирост подписчиков ${d.dir === 'up' ? 'ускорился' : 'замедлился'}: +${fmtInt(i.newFollowers)} за период (${d.dir === 'up' ? '↑' : '↓'}${d.pct.toFixed(0)}% к прошлому).`,
      });
    } else {
      out.push({ tone: 'neutral', text: `+${fmtInt(i.newFollowers)} новых подписчиков за период.` });
    }
  }

  // Engagement-rate trend (three-way: up / down / unchanged — matches pctDelta + the KPI pill).
  if (i.erReach != null && i.erReach > 0) {
    if (i.erReachPrev != null && i.erReachPrev > 0 && i.erReach.toFixed(2) !== i.erReachPrev.toFixed(2)) {
      const up = i.erReach > i.erReachPrev;
      out.push({
        tone: up ? 'up' : 'down',
        text: `Вовлечённость ${up ? 'выросла' : 'снизилась'} до ${i.erReach.toFixed(2)}% (было ${i.erReachPrev.toFixed(2)}%).`,
      });
    } else {
      out.push({ tone: 'neutral', text: `Вовлечённость по охвату — ${i.erReach.toFixed(2)}%.` });
    }
  }

  if (i.bestFormat) {
    out.push({
      tone: 'up',
      text: `Лучший формат — ${i.bestFormat.label}: ${i.bestFormat.sharePct.toFixed(0)}% всех взаимодействий.`,
    });
  }

  if (i.bestSlot) {
    out.push({ tone: 'neutral', text: `Лучшее время для публикаций — ${i.bestSlot.day} ${i.bestSlot.hour}:00.` });
  }

  if (i.topHashtag && i.topHashtag.lift > 5) {
    out.push({
      tone: 'up',
      text: `Хэштег ${i.topHashtag.tag} повышает вовлечённость на +${i.topHashtag.lift.toFixed(0)}%.`,
    });
  }

  if (i.topPostReach != null && i.topPostReach > 0) {
    out.push({ tone: 'neutral', text: `Лучшая публикация набрала ${fmtInt(i.topPostReach)} охвата.` });
  }

  if (i.topAge || i.topCountry) {
    const parts: string[] = [];
    if (i.topAge) parts.push(`ядро аудитории — ${i.topAge}`);
    if (i.topCountry) parts.push(`чаще из «${i.topCountry}»`);
    out.push({ tone: 'neutral', text: `${parts.join(', ')}.` });
  }

  return out;
}
