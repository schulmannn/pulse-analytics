// Barrel for the lazy-loaded Instagram cluster: App.tsx's React.lazy() call dynamic-imports THIS
// module, so Rollup emits the whole IG section as ONE async chunk (instead of several tiny ones
// sharing waterfall edges). IgFeed is the single entry; it imports the four panels, so they ride
// the same chunk automatically — only IgFeed needs a named export here for the route.
export { IgFeed } from '@/panels/instagram/IgFeed';
