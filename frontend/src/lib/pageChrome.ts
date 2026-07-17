/**
 * Shared sticky page-header geometry — ONE source for the personal Home header (panels/Home) and
 * every feed section header (panels/feed/useFeed). The strip bleeds to the shared main canvas edges
 * (the negative `-mx` cancels the shell's `px-4 sm:px-6`), sticks to the top of the inset panel over
 * a SOLID canvas background (no hairline / blur — it is indistinguishable from the page at rest and
 * simply clips the content sliding under it), and reserves a consistent gap below. Flex alignment
 * (single-row vs mobile-stacked) is left to each caller; only the geometry is shared here so the two
 * headers cannot drift apart into diverging copies.
 */
export const PAGE_HEADER_SHELL =
  'sticky top-0 z-sticky -mx-4 mb-6 bg-background px-4 py-3 sm:-mx-6 sm:px-6';
