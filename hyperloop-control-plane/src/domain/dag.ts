export interface DagEdge {
  from: string;
  to: string;
}

export interface Dag {
  nodes: string[];
  edges: DagEdge[];
}

export function topologicalSort(dag: Dag): string[] {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of dag.nodes) {
    indegree.set(node, 0);
    adjacency.set(node, []);
  }

  for (const edge of dag.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) {
      throw new Error(`DAG edge references unknown node: ${edge.from} -> ${edge.to}`);
    }
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([node]) => node)
    .sort();

  const ordered: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    ordered.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (ordered.length !== dag.nodes.length) {
    throw new Error('DAG contains a cycle');
  }

  return ordered;
}

export function readyNodes(dag: Dag, completed: ReadonlySet<string>): string[] {
  return dag.nodes.filter((node) => {
    if (completed.has(node)) {
      return false;
    }
    const deps = dag.edges.filter((edge) => edge.to === node).map((edge) => edge.from);
    return deps.every((dep) => completed.has(dep));
  });
}
