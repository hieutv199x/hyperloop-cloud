export interface SddServiceDeclaration {
  name: string;
  repository: string;
  workingBranch: string;
  targetBranch: string;
  dependsOn: string[];
}

export interface SddManifest {
  apiVersion: 'hyperloop.dev/v1';
  kind: 'SDDPackage';
  metadata: {
    devSpecId: string;
    project: string;
  };
  spec: {
    devSpecPath: string;
    requirements: string[];
    analysis?: string[];
    designs: string[];
    acceptanceCriteria: string[];
    services: SddServiceDeclaration[];
  };
}

export interface SddPackageFiles {
  /** Relative path -> file contents (text). */
  files: Record<string, string>;
}

export interface PinnedSddContext {
  sddProject: string;
  sddCommitSha: string;
  devSpecPath: string;
  manifest: SddManifest;
  packageFiles: SddPackageFiles;
}

export interface SddValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface SddValidationResult {
  ok: boolean;
  issues: SddValidationIssue[];
}
