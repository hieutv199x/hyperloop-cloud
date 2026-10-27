import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from './workflow-states.js';

describe('workflow-states', () => {
  it('allows submit to planning or NEEDS_SPEC_CLARIFICATION', () => {
    expect(canTransition('SUBMITTED', 'PLANNING')).toBe(true);
    expect(canTransition('SUBMITTED', 'NEEDS_SPEC_CLARIFICATION')).toBe(true);
  });

  it('blocks coding before approval path', () => {
    expect(canTransition('WAITING_SPEC_APPROVAL', 'AWAITING_CI')).toBe(false);
  });

  it('throws on illegal transition', () => {
    expect(() => assertTransition('COMPLETED', 'CODING')).toThrow(/Illegal workflow transition/);
  });
});
