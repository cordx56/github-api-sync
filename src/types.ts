import { FileStats, Stat } from "obsidian";

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
  targetFileType: "normal" | "includeConfig" | "includeHidden";
  logLevel: "debug" | "info" | "warn" | "error" | "none";
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
  targetFileType: "normal",
  logLevel: "none",
};

export type FileInfo = {
  path: string;
  stat: Stat | FileStats;
};

export interface FileChangeOp {
  path: string;
  action: "added" | "modified" | "removed";
}

export const OperationModeValues = ["pull", "push", "bidirectional"] as const;
export type OperationMode = (typeof OperationModeValues)[number];

export const AutoSyncModeValues = ["disable", "interval", "onsave"] as const;
export type AutoSyncMode = (typeof AutoSyncModeValues)[number];
