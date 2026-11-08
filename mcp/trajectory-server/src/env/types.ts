// env_detect evidence shapes (GH 2066): what a repo's files say about its toolchain, with file:line sources and no resolved commands.

export interface ConfigFileEvidence {
  file: string;
  line?: number;
  section?: string;
}

export interface CiStep {
  file: string;
  line: number;
  run: string;
}

export interface RunnerTarget {
  file: string;
  line: number;
  name: string;
  command: string;
}

export interface DevDependency {
  file: string;
  line: number;
  name: string;
  group: string;
}

export interface PackageEvidence {
  package_path: string;
  manifests: string[];
  lockfiles: string[];
  config_files: ConfigFileEvidence[];
  ci_steps: CiStep[];
  runner_targets: RunnerTarget[];
  dev_dependencies: DevDependency[];
  extensions: Record<string, number>;
  evidence_files: string[];
  evidence_hash: string;
}

export interface ReaderOutput {
  config_files?: ConfigFileEvidence[];
  ci_steps?: CiStep[];
  runner_targets?: RunnerTarget[];
  dev_dependencies?: DevDependency[];
}

export type Reader = (file: string, text: string) => ReaderOutput;
