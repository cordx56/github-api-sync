export interface PluginSettings {
  githubUsername: string;
  githubToken: string;
  repositoryPath: string; // format: owner/repo
  targetBranch: string;
  maxFileSizeMB: number;
  // ISO string of the last sync timestamp
  lastSyncedAt?: string;
  currentCommit?: string;
  operationMode: OperationMode;
  autoSyncMode: AutoSyncMode;
  autoSyncMinIntervalMin: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  githubUsername: "",
  githubToken: "",
  repositoryPath: "",
  targetBranch: "",
  maxFileSizeMB: 5,
  lastSyncedAt: undefined,
  operationMode: "pull",
  autoSyncMode: "disable",
  autoSyncMinIntervalMin: 5,
};

export interface FileChangeOp {
  path: string;
  action: "added" | "modified" | "removed";
}

export type OperationMode = "pull" | "push" | "bidirectional";

export type AutoSyncMode = "disable" | "interval" | "onsave";
