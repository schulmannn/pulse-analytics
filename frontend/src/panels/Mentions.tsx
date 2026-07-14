import { useMediaQuery } from '@/lib/useMediaQuery';
import { MentionsDesktop } from '@/panels/mentions/MentionsDesktop';
import { MentionsMobile } from '@/panels/mentions/MentionsMobile';

/**
 * «Упоминания» — desktop/mobile split by JS branch (not CSS): only one presentation mounts, so the
 * period chips / dense table live on desktop while the original mobile card stack is preserved
 * verbatim. Both share the same free-on-mount archive query and the quota-costing live search; the
 * desktop branch scopes everything to the authoritative page period (URL-backed).
 */
export function Mentions() {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  return isDesktop ? <MentionsDesktop /> : <MentionsMobile />;
}

// The Home widgets keep reading the legacy archive shape — re-exported so existing imports
// (`@/panels/Mentions`) are unaffected.
export { MentionsByDayWidget, MentionsWidgetBody } from '@/panels/mentions/MentionsMobile';
