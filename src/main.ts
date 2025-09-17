import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { GitHubClient, TreeData } from "./github";
import { GithubApiSyncSettingTab } from "./settings";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  OperationMode,
  FileInfo,
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
  private statusTimerId: number | null;
  private ignoreMgr?: IgnoreManager;
  private syncInProgress = false;
  private lastAutoSyncTs = 0;
  private intervalId: number | null = null;
  private onSaveTimerId: number | null = null;
  private sideView: GithubSyncView | null;

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
      id: "sync-now",
      name: "Sync with GitHub",
      callback: async () => {
        await this.syncAll();
      },
    });

    setLogLevel(this.settings.logLevel);

    // Register sidebar view
    this.registerView(VIEW_TYPE_GITHUB_SYNC, (leaf: WorkspaceLeaf) => {
      this.sideView = new GithubSyncView(leaf, this);
      return this.sideView;
    });

    this.addCommand({
      id: "open-sidebar",
      name: "Open GitHub Sync Sidebar",
      callback: async () => {
        await this.activateView();
      },
    });

    this.setupAutoSyncHooks();
    if (this.settings.autoSyncMode !== "disable") {
      this.syncAll();
    }
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
    this.sideView?.reloadConfig();
    setLogLevel(this.settings.logLevel);
  }

  maxSizeBytes() {
    return this.settings.maxFileSizeMB * 1024 * 1024;
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

  private remoteFilesCache = new Map<string, TreeData[]>();
  async getRemoteFilesAt(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<TreeData[]> {
    const client = await this.ensureClient();
    const cache = this.remoteFilesCache.get(ref);
    if (cache) {
      return cache;
    }
    const data = await client.getAllFilesAt(owner, repo, ref);
    const filtered =
      this.settings.targetFileType !== "includeHidden"
        ? data.filter(
            (v) =>
              !v.path.split("/").find((w) => w.startsWith(".")) ||
              (this.settings.targetFileType === "includeConfig" &&
                v.path.startsWith(this.app.vault.configDir)),
          )
        : data;
    this.remoteFilesCache.set(ref, filtered);
    window.setTimeout(() => {
      this.remoteFilesCache.delete(ref);
    }, 3000);
    return filtered;
  }

  async getMerkleDiff(ref: string): Promise<{
    localOnly: string[];
    modified: string[];
    remoteOnly: string[];
  }> {
    try {
      this.setStatus("Building Merkle trees...");
      startTimer("merkleDiff");
      const { owner, repo } = this.getOwnerRepo();

      const getLocalTree = async () => {
        startTimer("buildLocalTree");
        const localFiles = (
          await this.listAllLocalFiles({
            include: this.settings.targetFileType,
          })
        ).map((v) => v.path);
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
        const remoteFiles = (await this.getRemoteFilesAt(owner, repo, ref)).map(
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
      const summary = `GitHub diff: +${diffs.left.length} ~${diffs.both.length} -${diffs.right.length}`;
      this.setStatus(summary);
      logger(
        "debug",
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
      throw new Error(`Merkle diff failed: ${msg}`);
    }
  }

  async syncAll() {
    const { owner, repo } = this.getOwnerRepo();
    const { targetBranch } = await this.getTargetBranch(owner, repo);
    this.checkout({
      branch: targetBranch,
      strategy: this.settings.operationMode,
    });
  }

  async checkout(
    params: { strategy: OperationMode; message?: string } & (
      | { sha: string }
      | { branch: string }
    ),
  ) {
    startTimer("checkout");
    const { strategy, message } = params;
    const ref = "sha" in params ? params.sha : params.branch;

    if (this.syncInProgress) {
      return;
    }
    this.syncInProgress = true;

    const lastSyncedAt = this.settings.lastSyncedAt;
    const currentCommit = this.settings.currentCommit;

    try {
      const client = await this.ensureClient();
      const { owner, repo } = this.getOwnerRepo();

      const { localOnly, modified, remoteOnly } = await this.getMerkleDiff(ref);

      this.setStatus("Scan local/remote changes...");
      startTimer("scan");
      const [localChanges, remoteChanges] = await Promise.all([
        lastSyncedAt
          ? this.scanLocalUpdatedSince(lastSyncedAt).then((v) =>
              v.map((w) => w.path),
            )
          : null,
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
        removes =
          remoteChanges
            ?.filter(
              (v) => v.action === "removed" && !localChanges?.contains(v.path),
            )
            .map((v) => v.path) ?? [];

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

        downloads = [...remoteOnly, ...modified].filter(
          (v) => !localChanges?.contains(v) && !uploads.includes(v),
        );

        conflicts =
          remoteChanges
            ?.map((v) => v.path)
            .filter((v) => localChanges?.includes(v)) ?? [];
      }

      const filterRemoteSize = async (path: string): Promise<boolean> => {
        const remoteFiles = await this.getRemoteFilesAt(owner, repo, ref);
        const size = remoteFiles.find((v) => path === v.path)?.size || 0;
        return size <= this.maxSizeBytes();
      };
      downloads = (await this.ignoreManager().ignoreFilter(downloads)).filter(
        (v) => filterRemoteSize(v),
      );
      uploads = await this.ignoreManager().ignoreFilter(uploads);
      removes = await this.ignoreManager().ignoreFilter(removes);
      conflicts = (await this.ignoreManager().ignoreFilter(conflicts)).filter(
        (v) => filterRemoteSize(v),
      );
      logger("debug", "downloads: ", downloads);
      logger("debug", "uploads: ", uploads);
      logger("debug", "removes: ", removes);
      logger("debug", "conflicts: ", conflicts);
      logger("info", "delta:", endTimer("delta"), "s");

      startTimer("sync");
      this.setStatus("Syncing...");
      const conflictTime = Math.floor(new Date().getTime() / 1000).toString();
      let tasks = [];
      let progress = 0;
      const incrementProgress = () => {
        progress += 1;
        this.setStatus(`Syncing: ${progress}/${tasks.length}`);
      };
      tasks = [
        ...downloads.map(async (path) => {
          const data = await client.getFileRawAtRef(owner, repo, ref, path);
          if (data.byteLength > this.maxSizeBytes()) {
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
        ...removes.map(async (path) => {
          await this.app.vault.adapter.remove(path);
        }),
        ...conflicts.map(async (path) => {
          const saveConflict = async (remote: Uint8Array) => {
            const pathSplit = path.split("/");
            const basename = pathSplit.last()!;
            const split = basename.split(".");
            const filename =
              split.length === 1
                ? `${split[0]}.conflict-${conflictTime}`
                : `${split.slice(0, -1).join(".")}.conflict-${conflictTime}.${split.last()}`;
            const newPath = [...pathSplit.slice(0, -1), filename].join("/");
            await this.ensureFolder(newPath);
            await this.app.vault.adapter.writeBinary(newPath, remote);
          };
          if (!currentCommit) {
            return;
          }
          const stat = await this.app.vault.adapter.stat(path);
          if (!stat || this.maxSizeBytes() < stat.size) {
            return;
          }
          const bin = await this.app.vault.adapter.readBinary(path);
          let content;
          try {
            content = new TextDecoder().decode(bin);
          } catch (_e) {
            return;
          }
          const baseContent = await client.getFileRawAtRef(
            owner,
            repo,
            currentCommit,
            path,
          );
          if (baseContent.byteLength > this.maxSizeBytes()) {
            incrementProgress();
            return;
          }
          let baseText;
          try {
            baseText = new TextDecoder().decode(baseContent);
          } catch (_e) {
            return;
          }
          const refContent = await client.getFileRawAtRef(
            owner,
            repo,
            ref,
            path,
          );
          if (refContent.byteLength > this.maxSizeBytes()) {
            incrementProgress();
            return;
          }
          let refText;
          try {
            refText = new TextDecoder().decode(refContent);
          } catch (_e) {
            await saveConflict(refContent);
            return;
          }
          const merged = threeWayMerge(baseText, content, refText);
          if (!merged) {
            await saveConflict(refContent);
            return;
          }
          await this.ensureFolder(path);
          await this.app.vault.adapter.writeBinary(
            path,
            new TextEncoder().encode(merged).buffer,
          );
        }),
      ];
      if ("branch" in params && strategy !== "pull") {
        const headOid = await client.getBranchHeadOid(
          owner,
          repo,
          params.branch,
        );
        this.settings.currentCommit = headOid;
        tasks.push(
          this.commitFiles(
            owner,
            repo,
            params.branch,
            headOid,
            uploads,
            message ??
              `Obsidian sync: ${uploads.length} change(s) at ${new Date().toISOString()}`,
          ),
        );
      } else if ("sha" in params) {
        this.settings.currentCommit = params.sha;
      }

      await Promise.all(tasks);
      this.sideView?.populateCommits();

      logger("info", "sync:", endTimer("sync"), "s");
      this.settings.lastSyncedAt = new Date().toISOString();
      await this.saveSettings();

      this.setStatus(
        `GitHub: ↓${downloads.length} ↑${uploads.length} -${removes.length}`,
      );
    } catch (e: any) {
      console.error(e);
      new Notice(`GitHub Sync failed: ${e?.message ?? e}`);
      this.setStatus("GitHub: failed");
    } finally {
      this.syncInProgress = false;
      this.lastAutoSyncTs = Date.now();
      logger("info", "checkout:", endTimer("checkout"), "s");
    }
  }

  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    headOid: string,
    paths: string[],
    message: string,
  ) {
    if (paths.length === 0) {
      return;
    }
    const additions: { path: string; contents: string }[] = [];
    const deletions: { path: string }[] = [];
    for (const path of paths) {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat) {
        if (stat.size <= this.maxSizeBytes()) {
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
    }

    const client = await this.ensureClient();
    startTimer("push");
    const newOid = await client.createCommitOnBranch(
      owner,
      repo,
      branch,
      headOid,
      additions,
      deletions,
      message,
    );
    logger("info", "push:", endTimer("push"), "s");
    this.settings.currentCommit = newOid;
    await this.saveSettings();
    this.sideView?.populateCommits();
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

  private localFileListCache: FileInfo[] | null = null;
  async listAllLocalFiles(opt?: {
    root?: string;
    include?: "normal" | "includeConfig" | "includeHidden";
  }): Promise<FileInfo[]> {
    if (this.localFileListCache !== null) {
      return this.localFileListCache;
    }

    this.localFileListCache = [];
    const walk = async (folder: string): Promise<FileInfo[]> => {
      const { files, folders } = await this.app.vault.adapter.list(folder);
      let output: FileInfo[] = (
        await Promise.all([
          ...files.map(async (path) => {
            const stat = await this.app.vault.adapter.stat(path);
            // adapter.list returns absolute-like paths from root without leading slash
            if (stat) {
              return [{ path, stat }];
            } else {
              return [];
            }
          }),
          ...folders.map((d) => walk(d)),
        ])
      ).flat();
      return output;
    };

    if (opt?.include === "includeHidden") {
      this.localFileListCache = await walk(opt?.root ?? "");
    } else {
      const data = this.app.vault.getFiles();
      this.localFileListCache = data.map((v) => ({
        path: v.path,
        stat: v.stat,
      }));
      if (opt?.include === "includeConfig") {
        this.localFileListCache = [
          ...this.localFileListCache,
          ...(await walk(this.app.vault.configDir)),
        ];
      }
    }
    window.setTimeout(() => {
      this.localFileListCache = null;
    }, 3000);
    return this.localFileListCache;
  }

  async scanLocalUpdatedSince(
    sinceISO: string | Date | null,
  ): Promise<FileInfo[]> {
    const files = await this.listAllLocalFiles({
      include: this.settings.targetFileType,
    });
    const updated: FileInfo[] = [];
    const since =
      typeof sinceISO === "string"
        ? new Date(sinceISO).getTime()
        : sinceISO?.getTime() || 0;
    let processed = 0;
    for (const file of files) {
      if (await this.ignoreManager().isIgnored(file.path)) {
        processed += 1;
        continue;
      }
      if (since < file.stat.mtime) updated.push(file);
      processed += 1;
      this.setStatus(`Scan ${processed}/${files.length}`);
    }
    return updated;
  }

  setStatus(text: string, timer?: number) {
    try {
      if (this.statusTimerId !== null) {
        clearTimeout(this.statusTimerId);
        this.statusTimerId = null;
      }
      this.statusEl?.setText(text);
      this.statusTimerId = window.setTimeout(() => {
        const lastSyncedAt = this.settings.lastSyncedAt
          ? new Date(this.settings.lastSyncedAt)
          : null;
        if (lastSyncedAt === null) {
          this.statusEl?.setText("GitHub: never synced");
          return;
        }
        const dur = Math.floor(
          (new Date().getTime() - lastSyncedAt.getTime()) / 1000,
        );
        const days = Math.floor(dur / (60 * 60 * 24));
        const hours = Math.floor(dur / (60 * 60));
        const mins = Math.floor(dur / 60);
        if (0 < days) {
          this.setStatus(`GitHub: synced ${days}d ago`);
        } else if (0 < hours) {
          this.setStatus(`GitHub: synced ${hours}h ago`);
        } else if (0 < mins) {
          this.setStatus(`GitHub: synced ${mins}m ago`);
        } else {
          this.setStatus(`GitHub: synced ${dur}s ago`);
        }
      }, timer ?? 5000);
    } catch {
      // ignore rendering failures
    }
  }
}
