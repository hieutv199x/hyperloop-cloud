import { describe, expect, it } from 'vitest';
import { readyNodes, topologicalSort } from './dag.js';

describe('dag', () => {
  const dag = {
    nodes: ['a', 'b', 'c'],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  };

  it('topologically sorts dependencies', () => {
    expect(topologicalSort(dag)).toEqual(['a', 'b', 'c']);
  });

  it('detects cycles', () => {
    expect(() =>
      topologicalSort({
        nodes: ['a', 'b'],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).toThrow(/cycle/i);
  });

  it('returns ready nodes after completions', () => {
    expect(readyNodes(dag, new Set())).toEqual(['a']);
    expect(readyNodes(dag, new Set(['a']))).toEqual(['b']);
    expect(readyNodes(dag, new Set(['a', 'b']))).toEqual(['c']);
  });
});
