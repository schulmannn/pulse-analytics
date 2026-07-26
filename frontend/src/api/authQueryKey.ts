/** Kept outside the full query-key factory so the public auth gate can seed the protected cache
 * without importing every source-specific key and period helper. */
export const ME_QUERY_KEY = ['me'] as const;
