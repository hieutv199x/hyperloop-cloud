export interface DesiredJobSpec {
  name: string;
  namespace: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  activeDeadlineSeconds: number;
  ttlSecondsAfterFinished: number;
}

export interface ObservedJob {
  name: string;
  namespace: string;
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'NotFound';
  uid?: string;
}

export interface KubernetesJobPort {
  createJob(spec: DesiredJobSpec): Promise<ObservedJob>;
  getJob(namespace: string, name: string): Promise<ObservedJob>;
  deleteJob(namespace: string, name: string): Promise<void>;
}
