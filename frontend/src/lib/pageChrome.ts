/**
 * Shared sticky page-header geometry — ONE source for the personal Home header (panels/Home) and
 * every feed section header (panels/feed/useFeed). The strip bleeds to the shared main canvas edges
 * (the negative `-mx` cancels the shell's `px-4 sm:px-6`), sticks to the top of the inset panel as a
 * shadcn-style translucent site header with a quiet bottom border, and reserves a consistent gap
 * below. Flex alignment
 * (single-row vs mobile-stacked) is left to each caller; only the geometry is shared here so the two
 * headers cannot drift apart into diverging copies.
 */
export const PAGE_HEADER_SHELL =
  'sticky top-0 z-sticky -mx-4 mb-6 border-b border-border/70 bg-background/90 px-4 py-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6';
