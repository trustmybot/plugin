export interface FileRegistryRow {
  path: string;
  type: 'source' | 'test' | 'config' | 'doc' | 'unknown';
  language: string | null;
  size_bytes: number | null;
  last_commit_sha: string | null;
  last_change_type: 'added' | 'modified' | 'deleted' | 'renamed' | null;
  last_change_at: string | null;
  imports: string[];
  exports: string[];
  metadata: Record<string, unknown>;
}

export interface RenderOptions {
  generatedAt: string;
}
