import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { GitHubClient } from "./github";
import { GithubApiSyncSettingTab } from "./settings";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  OperationMode,
  FileChangeOp,
} from "./types";
import {
  startTimer,
  endTimer,
  logger,
  setLogLevel,
  encodeBase64,
  IgnoreManager,
  normalizePathNFC,
} from "./utils";
import { GithubSyncView, VIEW_TYPE_GITHUB_SYNC } from "./sidebar";
import { MerkleTreeBuilder, MerkleDiff, gitBlobSha1Hex } from "./tree";
import { threeWayMerge } from "./merge";

export default class GithubApiSyncPlugin extends Plugin {
  settings: PluginSettings;
  private client?: GitHubClient;
  private statusEl?: HTMLElement;
  private ignoreMgr?: IgnoreManager;
  private syncInProgress = false;
  private lastAutoSyncTs = 0;
  private intervalId: number | null = null;
  private onSaveTimerId: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GithubApiSyncSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.setStatus("Idle");

    this.addRibbonIcon("sync", "GitHub API Sync", async () => {
      await this.syncAll();
    });

    this.addRibbonIcon("git-branch", "GitHub Sidebar", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "github-api-sync-now",
      name: "Sync with GitHub",
      callback: async () => {
        await this.syncAll();
      },
    });

    setLogLevel("debug");

    // Register sidebar view
    this.registerView(
      VIEW_TYPE_GITHUB_SYNC,
      (leaf: WorkspaceLeaf) => new GithubSyncView(leaf, this),
    );

    this.addCommand({
      id: "open-github-api-sync-sidebar",
      name: "Open GitHub Sync Sidebar",
      callback: async () => {
        await this.activateView();
      },
    });

    // Experimental: compute Merkle diff between local vault and remote repo
    this.addCommand({
      id: "github-api-sync-merkle-diff",
      name: "Show Diff",
      callback: async () => {
        const { owner, repo } = this.getOwnerRepo();
        const { targetBranch } = await this.getTargetBranch(owner, repo);
        await this.getMerkleDiff(targetBranch);
      },
    });

    this.setupAutoSyncHooks();
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.githubToken) {
      this.client = new GitHubClient(this.settings.githubToken);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.settings.githubToken) {
      this.client = new GitHubClient(this.settings.githubToken);
    } else {
      this.client = undefined;
    }
    this.setupAutoSyncHooks();
  }

  ignoreManager(): IgnoreManager {
    if (!this.ignoreMgr)
      this.ignoreMgr = new IgnoreManager(this.app.vault.adapter);
    return this.ignoreMgr;
  }

  getOwnerRepo(): { owner: string; repo: string } {
    const repoPath = this.settings.repositoryPath?.trim();
    if (repoPath) {
      const parts = repoPath
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 2) {
        return { owner: parts[0], repo: parts[1] };
      }
      throw new Error("Repository path must be in the format owner/repo.");
    }
    const owner = this.settings.githubUsername?.trim();
    const repo = this.app.vault.getName();
    if (!owner) throw new Error("GitHub username is not set in settings.");
    return { owner, repo };
  }

  private async ensureClient(): Promise<GitHubClient> {
    if (!this.client) {
      if (!this.settings.githubToken) {
        throw new Error("GitHub token (PAT) is not set in settings.");
      }
      this.client = new GitHubClient(this.settings.githubToken);
    }
    return this.client;
  }

  private async getTargetBranch(
    owner: string,
    repo: string,
  ): Promise<{ targetBranch: string; headOid: string }> {
    const client = await this.ensureClient();
    let targetBranch = this.settings.targetBranch;
    if (targetBranch) {
      const headOid = await client.getBranchHeadOid(owner, repo, targetBranch);
      return { targetBranch, headOid };
    } else {
      const { defaultBranch, headOid } = await client.getDefaultBranch(
        owner,
        repo,
      );
      return { targetBranch: defaultBranch, headOid };
    }
  }

  private async getMerkleDiff(ref: string): Promise<{
    localOnly: string[];
    modified: string[];
    remoteOnly: string[];
  }> {
    try {
      const client = await this.ensureClient();
      this.setStatus("Building Merkle trees...");
      startTimer("merkleDiff");
      const { owner, repo } = this.getOwnerRepo();

      const getLocalTree = async () => {
        startTimer("buildLocalTree");
        const localFiles = await this.listAllLocalFiles();
        const tree = await MerkleTreeBuilder.buildTree(
          await this.ignoreManager().ignoreFilter(
            localFiles.map(normalizePathNFC),
          ),
          async (v) => {
            const data = await this.app.vault.adapter.readBinary(v);
            return gitBlobSha1Hex(new Uint8Array(data));
          },
        );
        logger("info", "buildLocalTree:", endTimer("buildLocalTree"), "s");
        return tree;
      };
      const getRemoteTree = async () => {
        startTimer("buildRemoteTree");
        const remoteFiles = (await client.getAllFilesAt(owner, repo, ref)).map(
          (v) => ({ ...v, path: normalizePathNFC(v.path) }),
        );
        const remoteShas = new Map<string, string>(
          remoteFiles.map((v) => [v.path, v.sha]),
        );
        const tree = await MerkleTreeBuilder.buildTree(
          await this.ignoreManager().ignoreFilter(
            remoteFiles.filter((v) => v.type === "blob").map((v) => v.path),
          ),
          (v) => remoteShas.get(v)!,
        );
        logger("info", "buildRemoteTree:", endTimer("buildRemoteTree"), "s");
        return tree;
      };
      const [localTree, remoteTree] = await Promise.all([
        getLocalTree(),
        getRemoteTree(),
      ]);

      logger("debug", "localTree", localTree);
      logger("debug", "remoteTree", remoteTree);

      const diffs = MerkleDiff.findDifferences(localTree, remoteTree);
      logger("info", "merkleDiff:", endTimer("merkleDiff"), "s");
      const summary = `Diff: +${diffs.left.length} ~${diffs.both.length} -${diffs.right.length}`;
      this.setStatus(summary);
      new Notice(summary, 8000);
      logger(
        "info",
        "MerkleDiff",
        "local:",
        diffs.left,
        "modified:",
        diffs.both,
        "remote:",
        diffs.right,
      );
      return {
        localOnly: diffs.left,
        modified: diffs.both,
        remoteOnly: diffs.right,
      };
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.setStatus(`Merkle diff failed: ${msg}`);
      throw new Error(`Merkle diff failed: ${msg}`);
    }
  }

  async syncAll() {
    const { owner, repo } = this.getOwnerRepo();
    const { targetBranch, headOid } = await this.getTargetBranch(owner, repo);
    this.checkout(targetBranch, this.settings.operationMode);
  }

  async checkout(ref: string, strategy: OperationMode) {
    if (this.syncInProgress) {
      return;
    }
    this.syncInProgress = true;
    const lastSyncedAt = this.settings.lastSyncedAt;
    const currentCommit = this.settings.currentCommit;
    try {
      const { localOnly, modified, remoteOnly } = await this.getMerkleDiff(ref);

      const client = await this.ensureClient();
      const { owner, repo } = this.getOwnerRepo();

      this.setStatus("Scan local/remote changes...");
      startTimer("scan");
      const [localChanges, remoteChanges] = await Promise.all([
        lastSyncedAt ? this.scanLocalUpdatedSince(lastSyncedAt) : null,
        currentCommit
          ? client.getFileChangesSince(owner, repo, currentCommit, ref)
          : null,
      ]);
      logger("info", "scan:", endTimer("scan"), "s");
      logger("debug", "localChanges:", localChanges);
      logger("debug", "remoteChanges:", remoteChanges);

      this.setStatus("Resolving delta...");
      startTimer("delta");
      let downloads: string[] = [];
      let removes: string[] = [];
      let uploads: string[] = [];
      let conflicts: string[] = [];

      if (strategy === "pull") {
        downloads = [...remoteOnly, ...modified];
        removes = [...localOnly];
      } else if (strategy === "push") {
        uploads = [...localOnly, ...modified];
      } else {
        downloads = [...remoteOnly, ...modified].filter(
          (v) =>
            !localChanges?.contains(v) &&
            !remoteChanges
              ?.filter((v) => v.action === "removed")
              .map((v) => v.path)
              .includes(v),
        );

        removes =
          remoteChanges
            ?.filter(
              (v) => v.action === "removed" && !localChanges?.contains(v.path),
            )
            .map((v) => v.path) || [];

        uploads = [...localOnly, ...modified].filter(
          (v) => !remoteChanges?.map((v) => v.path).contains(v),
        );
        // upload remoteOnly because it may be deleted
        if (remoteChanges) {
          uploads = [
            ...uploads,
            ...remoteOnly.filter(
              (v) => !remoteChanges.map((v) => v.path).includes(v),
            ),
          ];
        }

        conflicts =
          remoteChanges
            ?.map((v) => v.path)
            .filter((v) => localChanges?.includes(v)) ?? [];
      }

      downloads = await this.ignoreManager().ignoreFilter(downloads);
      uploads = await this.ignoreManager().ignoreFilter(uploads);
      removes = await this.ignoreManager().ignoreFilter(removes);
      logger("debug", "downloads: ", downloads);
      logger("debug", "uploads: ", uploads);
      logger("debug", "removes: ", removes);
      logger("info", "delta:", endTimer("delta"), "s");

      startTimer("sync");
      this.setStatus("Syncing...");

      const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
      const additions: { path: string; contents: string }[] = [];
      const deletions: { path: string }[] = [];
      let tasks = [];

      let progress = 0;
      let incrementProgress = () => {};
      tasks = [
        ...downloads.map(async (path) => {
          const data = await client.getFileRawAtRef(owner, repo, ref, path);
          if (data.byteLength > maxBytes) {
            incrementProgress();
            return;
          }
          await this.ensureFolder(path);
          await this.app.vault.adapter.writeBinary(
            path,
            data.buffer as ArrayBuffer,
          );
          incrementProgress();
        }),
        ...uploads.map(async (path) => {
          const stat = await this.app.vault.adapter.stat(path);
          if (stat) {
            if (stat.size <= maxBytes) {
              const bin = await this.app.vault.adapter.readBinary(path);
              const u8 =
                bin instanceof Uint8Array
                  ? bin
                  : new Uint8Array(bin as ArrayBuffer);
              const contents = encodeBase64(u8);
              additions.push({ path, contents });
            }
          } else {
            deletions.push({ path });
          }
          incrementProgress();
        }),
        ...removes.map(async (path) => {
          await this.app.vault.adapter.remove(path);
        }),
        ...conflicts.map(async (path) => {
          if (!currentCommit) {
            return;
          }
          const stat = await this.app.vault.adapter.stat(path);
          if (!stat || maxBytes < stat.size) {
            return;
          }
          const bin = await this.app.vault.adapter.readBinary(path);
          const content = new TextDecoder().decode(bin);
          const baseContent = await client.getFileRawAtRef(
            owner,
            repo,
            currentCommit,
            path,
          );
          if (baseContent.byteLength > maxBytes) {
            incrementProgress();
            return;
          }
          const baseText = new TextDecoder().decode(baseContent);
          const refContent = await client.getFileRawAtRef(
            owner,
            repo,
            ref,
            path,
          );
          if (refContent.byteLength > maxBytes) {
            incrementProgress();
            return;
          }
          const refText = new TextDecoder().decode(refContent);
          const merged = threeWayMerge(baseText, content, refText);
          if (!merged) {
            return;
          }
          await this.ensureFolder(path);
          await this.app.vault.adapter.writeBinary(
            path,
            new TextEncoder().encode(merged).buffer,
          );
        }),
      ];
      incrementProgress = () => {
        progress += 1;
        this.setStatus(`Syncing: ${progress}/${tasks.length}`);
      };

      await Promise.all(tasks);
      logger("info", "sync:", endTimer("sync"), "s");
      if (0 < additions.length || 0 < deletions.length) {
        startTimer("upload");
        this.setStatus("Uploading...");
        const { targetBranch, headOid } = await this.getTargetBranch(
          owner,
          repo,
        );
        const newOid = await client.createCommitOnBranch(
          owner,
          repo,
          targetBranch,
          headOid,
          additions,
          deletions,
          `Obsidian sync: ${additions.length + deletions.length} change(s) at ${new Date().toISOString()}`,
        );
        this.settings.currentCommit = newOid;
        logger("info", "upload:", endTimer("upload"), "s");
      }
      this.settings.lastSyncedAt = new Date().toISOString();
      await this.saveSettings();

      new Notice(
        `GitHub API Sync: ↓${downloads.length} ↑${uploads.length} -${removes.length}`,
      );
    } catch (e: any) {
      console.error(e);
      new Notice(`GitHub API Sync failed: ${e?.message ?? e}`);
      this.setStatus("Idle");
    } finally {
      this.syncInProgress = false;
      this.lastAutoSyncTs = Date.now();
      this.setStatus("");
    }
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GITHUB_SYNC);
    if (leaves.length === 0) {
      const right =
        this.app.workspace.getRightLeaf(false) ||
        this.app.workspace.getLeaf(true);
      await right.setViewState({ type: VIEW_TYPE_GITHUB_SYNC, active: true });
    }
    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_GITHUB_SYNC)[0],
    );
  }

  setupAutoSyncHooks() {
    // Clear previous
    if (this.intervalId != null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.onSaveTimerId != null) {
      window.clearTimeout(this.onSaveTimerId);
      this.onSaveTimerId = null;
    }
    // unregister events is handled by this.registerEvent; create new ones based on mode
    const mode = this.settings.autoSyncMode;
    const minMs =
      Math.max(0.1, this.settings.autoSyncMinIntervalMin) * 60 * 1000;

    if (mode === "interval" || mode === "onsave") {
      // periodic check; trigger only if enough time since last
      this.intervalId = window.setInterval(async () => {
        if (Date.now() - this.lastAutoSyncTs < minMs) return;
        await this.syncAll();
      }, minMs);
    }
    if (mode === "onsave") {
      const scheduleDebouncedSync = () => {
        if (this.onSaveTimerId != null) {
          window.clearTimeout(this.onSaveTimerId);
          this.onSaveTimerId = null;
        }
        // Wait 3 seconds after the last change; if no more changes, attempt sync
        this.onSaveTimerId = window.setTimeout(async () => {
          this.onSaveTimerId = null;
          if (Date.now() - this.lastAutoSyncTs < minMs) return;
          await this.syncAll();
        }, 3000);
      };
      this.registerEvent(this.app.vault.on("modify", scheduleDebouncedSync));
      this.registerEvent(this.app.vault.on("create", scheduleDebouncedSync));
      this.registerEvent(this.app.vault.on("delete", scheduleDebouncedSync));
    }
  }

  private async ensureFolder(filePath: string) {
    const parts = filePath.split("/");
    parts.pop();
    if (parts.length === 0) return;
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async listAllLocalFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (folder: string) => {
      const { files, folders } = await this.app.vault.adapter.list(folder);
      for (const f of files) {
        // adapter.list returns absolute-like paths from root without leading slash
        out.push(f);
      }
      for (const d of folders) {
        await walk(d);
      }
    };
    await walk("");
    return out;
  }

  async scanLocalUpdatedSince(
    sinceISO: string | Date | null,
  ): Promise<string[]> {
    const files = await this.listAllLocalFiles();
    const updated: string[] = [];
    const since =
      typeof sinceISO === "string"
        ? new Date(sinceISO).getTime()
        : sinceISO?.getTime() || 0;
    let processed = 0;
    for (const p of files) {
      if (await this.ignoreManager().isIgnored(p)) {
        processed += 1;
        continue;
      }
      const st = await this.app.vault.adapter.stat(p);
      if (!st) {
        processed += 1;
        continue;
      }
      if (since < st.mtime) updated.push(p);
      processed += 1;
      this.setStatus(`Scan ${processed}/${files.length}`);
    }
    return updated;
  }

  private setStatus(text: string) {
    try {
      this.statusEl?.setText(text);
    } catch {
      // ignore rendering failures
    }
  }
}
