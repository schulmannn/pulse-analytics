import { describe, expect, it } from 'vitest';
import { BugSchema, BugsResponseSchema } from './schemas';

describe('BugSchema crash aggregation fields', () => {
  it('parses an aggregated crash row with occurrence_count + last_seen', () => {
    const bug = BugSchema.parse({
      id: 7,
      kind: 'crash',
      text: '[crash:widget] TypeError: boom · t1',
      occurrence_count: 42,
      last_seen: '2026-07-15T10:00:00',
    });
    expect(bug.occurrence_count).toBe(42);
    expect(bug.last_seen).toBe('2026-07-15T10:00:00');
  });

  it('coerces a numeric-string occurrence_count', () => {
    const bug = BugSchema.parse({ id: 8, kind: 'crash', occurrence_count: '3' });
    expect(bug.occurrence_count).toBe(3);
  });

  it('leaves occurrence_count / last_seen absent (undefined) for a normal ticket', () => {
    const bug = BugSchema.parse({ id: 9, kind: 'bug', text: 'обычный тикет' });
    expect(bug.occurrence_count ?? null).toBeNull();
    expect(bug.last_seen ?? null).toBeNull();
  });

  it('tolerates null occurrence_count / last_seen from the API', () => {
    const bug = BugSchema.parse({ id: 10, kind: 'bug', occurrence_count: null, last_seen: null });
    expect(bug.occurrence_count).toBeNull();
    expect(bug.last_seen).toBeNull();
  });

  it('parses a bugs response carrying a mixed crash + normal list', () => {
    const res = BugsResponseSchema.parse({
      enabled: true,
      bugs: [
        { id: 1, kind: 'crash', occurrence_count: 5, last_seen: '2026-07-15T09:00:00' },
        { id: 2, kind: 'feature' },
      ],
    });
    expect(res.bugs[0].occurrence_count).toBe(5);
    expect(res.bugs[1].occurrence_count ?? null).toBeNull();
  });
});
