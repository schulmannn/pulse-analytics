// Barrel for the lazy-loaded Instagram cluster: App.tsx's five React.lazy() calls all
// dynamic-import THIS module, so Rollup emits the whole IG section as ONE async chunk
// (instead of five tiny ones sharing waterfall edges).
export { InstagramLayout } from '@/panels/instagram/Layout';
export { IgOverview } from '@/panels/instagram/IgOverview';
export { IgAnalytics } from '@/panels/instagram/IgAnalytics';
export { IgContent } from '@/panels/instagram/IgContent';
export { IgAudience } from '@/panels/instagram/IgAudience';
