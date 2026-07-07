// Barrel for the lazy-loaded Instagram cluster: the feed registry's React.lazy() calls
// dynamic-import THIS module, so Rollup emits the whole IG section as ONE async chunk (instead of
// several tiny ones sharing waterfall edges). Everything here lives in IgFeed.tsx, which imports
// the four section panels — they all ride the same chunk automatically.
export { IgShell, IgOverviewPage, IgAnalyticsPage, IgContentPage, IgAudiencePage, IgPeriodControl } from '@/panels/instagram/IgFeed';
