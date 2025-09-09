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
              .map((v) => v.path),
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
          const blob = await client.getBlobAtRef(owner, repo, `${ref}:${path}`);
          if (!blob) {
            incrementProgress();
            return;
          }
          if (blob.byteSize > maxBytes) {
            incrementProgress();
            return;
          }
          await this.ensureFolder(path);
          if (blob.text != null && !blob.isBinary) {
            await this.app.vault.adapter.write(path, blob.text);
          } else {
            const bin = await client.getFileRawAtRef(owner, repo, ref, path);
            const ab = bin.buffer.slice(
              bin.byteOffset,
              bin.byteOffset + bin.byteLength,
            );
            await this.app.vault.adapter.writeBinary(path, ab as ArrayBuffer);
          }
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

  /*
  async syncNow() {
    if (this.syncInProgress) return;
    this.syncInProgress = true;
    try {
      const client = await this.ensureClient();
      startTimer("step1");
      const { owner, repo } = this.getOwnerRepo();
      this.setStatus("Fetching default branch...");
      const { targetBranch, headOid } = await this.getTargetBranch(owner, repo);
      logger("info", "step1:", endTimer("step1"), "s");
      const nowISO = new Date().toISOString();
      // Prepare ignore manager
      this.ignoreMgr = new IgnoreManager(this.app.vault.adapter);

      // Step 2: determine locally updated files since lastSyncedAt
      // Step 2: API calls
      startTimer("step2");
      const lastSyncedAt = this.settings.lastSyncedAt || null;
      this.setStatus("Fetching remote...");
      const [localAll, localUpdates, baseOid, latest] = await Promise.all([
        this.listAllLocalFiles(),
        this.scanLocalUpdatedSince(lastSyncedAt),
        lastSyncedAt
          ? client.getCommitOidBeforeOrAt(
              owner,
              repo,
              targetBranch,
              lastSyncedAt,
            )
          : null,
        client.listAllFilesAtRef(owner, repo, targetBranch),
      ]);
      logger("info", "step2:", endTimer("step2"), "s");

      startTimer("step3");
      let remoteOps: { path: string; action: FileAction }[] = [];
      if (baseOid) {
        this.setStatus("Fetching changes...");
        remoteOps = await client.getFileChangesSince(
          owner,
          repo,
          baseOid,
          headOid,
        );
      } else {
        this.setStatus("Listing repository files...");
        remoteOps = latest.map((p) => ({ path: p, action: FileAction.Create }));
      }
      logger("info", "step3:", endTimer("step3"), "s");

      // Step 4: classify
      startTimer("step4");
      const localAllSet = new Set(localAll);
      const remoteSet = new Set(remoteOps.map((o) => o.path));
      const localSet = new Set(localUpdates);
      const conflicts = [...localSet].filter((p) => remoteSet.has(p));
      const uploadOnly = [...localSet].filter((p) => !remoteSet.has(p));
      const downloadOnly = remoteOps.filter((o) => !localSet.has(o.path));
      // Files that exist on remote (latest) but do not exist locally are local-deletions.
      // We only delete them remotely if they weren't changed remotely since base (i.e., not in remoteSet)
      // and are not ignored by .gitignore rules.
      const deleteRemote: string[] = [];
      const deletedCandidates = latest.filter((p) => !localAllSet.has(p));
      for (const p of deletedCandidates) {
        if (remoteSet.has(p)) continue;
        if (await this.isIgnored(p)) continue;
        deleteRemote.push(p);
      }
      const remoteActionMap = new Map(
        remoteOps.map((o) => [o.path, o.action] as const),
      );
      logger("info", "step4:", endTimer("step4"), "s");

      // Step 5: execute uploads/downloads in parallel (respect operation mode)
      const tasks: Promise<any>[] = [];
      const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;

      // Downloads (create/modify/delete)
      if (this.settings.operationMode !== "push" && 0 < downloadOnly.length) {
        let done = 0;
        const total = downloadOnly.length;
        const dlTasks = downloadOnly.map(async (op) => {
          if (await this.isIgnored(op.path)) {
            done += 1;
            return;
          }
          if (op.action === FileAction.Delete) {
            const exists = await this.app.vault.adapter.exists(op.path);
            if (exists) {
              await this.app.vault.adapter.remove(op.path);
            }
          } else {
            const blob = await client.getBlobAtRef(
              owner,
              repo,
              `${targetBranch}:${op.path}`,
            );
            if (!blob) {
              done += 1;
              return;
            }
            if (blob.byteSize > maxBytes) {
              done += 1;
              return;
            }
            await this.ensureFolder(op.path);
            if (blob.text != null && !blob.isBinary) {
              await this.app.vault.adapter.write(op.path, blob.text);
            } else {
              const bin = await client.getFileRawAtRef(
                owner,
                repo,
                targetBranch,
                op.path,
              );
              const ab = bin.buffer.slice(
                bin.byteOffset,
                bin.byteOffset + bin.byteLength,
              );
              await this.app.vault.adapter.writeBinary(
                op.path,
                ab as ArrayBuffer,
              );
            }
          }
          done += 1;
          this.setStatus(`Pull ${done}/${total}`);
        });
        tasks.push(Promise.allSettled(dlTasks));
      }

      // Uploads (create/modify) and remote deletions
      if (
        this.settings.operationMode !== "pull" &&
        (uploadOnly.length > 0 || deleteRemote.length > 0)
      ) {
        this.setStatus(
          `Preparing ${uploadOnly.length} upload(s) + ${deleteRemote.length} deletion(s)...`,
        );
        const additions: { path: string; contents: string }[] = [];
        let prepared = 0;
        for (const path of uploadOnly) {
          if (await this.isIgnored(path)) {
            prepared += 1;
            continue;
          }
          const stat = await this.app.vault.adapter.stat(path);
          if (!stat) {
            prepared += 1;
            continue;
          }
          let contentB64: string | null = null;
          if (stat.size <= maxBytes) {
            const bin = await this.app.vault.adapter.readBinary(path);
            const u8 =
              bin instanceof Uint8Array
                ? bin
                : new Uint8Array(bin as ArrayBuffer);
            contentB64 = encodeBase64(u8);
          }
          if (contentB64) {
            additions.push({ path, contents: contentB64 });
          }
          prepared += 1;
          this.setStatus(`Prepare ${prepared}/${uploadOnly.length}`);
        }
        if (additions.length > 0 || deleteRemote.length > 0) {
          tasks.push(
            (async () => {
              this.setStatus(
                `Pushing ${additions.length} file(s), deleting ${deleteRemote.length} file(s)...`,
              );
              const newOid = await client.createCommitOnBranch(
                owner,
                repo,
                targetBranch,
                headOid,
                additions,
                deleteRemote.map((path) => ({ path })),
                `Obsidian sync: ${additions.length + deleteRemote.length} change(s) at ${new Date().toISOString()}`,
              );
              this.setStatus(`Successfully committed: ${newOid}`);
            })(),
          );
        }
      }

      // Conflicts: attempt 2-way merge; on failure, save diff
      if (conflicts.length > 0) {
        const ts = nowISO.replace(/[:.]/g, "-");
        const baseDir = `github-api-sync-conflicts/${ts}`;
        let done = 0;
        const total = conflicts.length;
        const cfTasks = conflicts.map(async (p) => {
          if (await this.isIgnored(p)) {
            done += 1;
            return;
          }
          const action = remoteActionMap.get(p);
          const remoteBlob =
            action === FileAction.Delete
              ? null
              : await client.getBlobAtRef(owner, repo, `${targetBranch}:${p}`);
          let remoteText: string | null = null;
          if (remoteBlob) {
            if (remoteBlob.isBinary) {
              done += 1;
              return;
            }
            remoteText = remoteBlob.text;
          }
          let localText = "";
          try {
            localText = await this.app.vault.adapter.read(p);
          } catch {
            done += 1;
            return;
          }
          let merged: string | null = null;
          if (action !== FileAction.Delete && remoteText != null) {
            merged = tryTwoWayMerge(localText, remoteText);
          }
          if (merged != null) {
            await this.ensureFolder(p);
            await this.app.vault.adapter.write(p, merged);
          } else {
            const diffText = createUnifiedDiff(p, localText, remoteText ?? "");
            const outPath = `${baseDir}/${p}.diff`;
            await this.ensureFolder(outPath);
            await this.app.vault.adapter.write(outPath, diffText);
          }
          done += 1;
          this.setStatus(`Conflicts ${done}/${total}`);
        });
        tasks.push(Promise.allSettled(cfTasks));
      }

      startTimer("step5");
      await Promise.all(tasks);
      logger("info", "step5:", endTimer("step5"), "s");

      // Step 7: update sync timestamp
      this.settings.lastSyncedAt = new Date().toISOString();
      await this.saveSettings();
      new Notice(
        `Sync completed. Up: ${this.settings.operationMode !== "pull" ? uploadOnly.length + deleteRemote.length : 0}, Down: ${this.settings.operationMode !== "push" ? downloadOnly.length : 0}, Conflicts: ${conflicts.length}`,
      );
      this.setStatus("Idle");
    } catch (e: any) {
      console.error(e);
      new Notice(`GitHub API Sync failed: ${e?.message ?? e}`);
      this.setStatus("Idle");
    } finally {
      this.syncInProgress = false;
      this.lastAutoSyncTs = Date.now();
    }
  }
  */

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

    if (mode === "interval") {
      // periodic check; trigger only if enough time since last
      this.intervalId = window.setInterval(async () => {
        if (Date.now() - this.lastAutoSyncTs < minMs) return;
        await this.syncAll();
      }, minMs);
    } else if (mode === "onsave") {
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

  async isIgnored(path: string): Promise<boolean> {
    if (!this.ignoreMgr)
      this.ignoreMgr = new IgnoreManager(this.app.vault.adapter);
    return this.ignoreMgr.isIgnored(path);
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
      if (await this.isIgnored(p)) {
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

function createUnifiedDiff(
  filename: string,
  oldStr: string,
  newStr: string,
): string {
  const a = oldStr.split(/\r?\n/);
  const b = newStr.split(/\r?\n/);
  const dp: number[][] = Array(a.length + 1)
    .fill(0)
    .map(() => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  out.push(`--- local:${filename}`);
  out.push(`+++ remote:${filename}`);
  out.push(`@@`);
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

function tryTwoWayMerge(local: string, remote: string): string | null {
  // 2-way line-based merge: if both sides modify the same differing region, return null
  const a = local.split(/\r?\n/);
  const b = remote.split(/\r?\n/);
  const lcs = buildLCS(a, b);
  const res: string[] = [];
  let i = 0,
    j = 0;
  for (const [ai, bj] of lcs) {
    // differing block: a[i..ai), b[j..bj)
    const aBlock = a.slice(i, ai);
    const bBlock = b.slice(j, bj);
    if (aBlock.length > 0 && bBlock.length > 0) {
      return null; // overlapping concurrent edits
    }
    if (aBlock.length > 0) res.push(...aBlock);
    if (bBlock.length > 0) res.push(...bBlock);
    // common line
    res.push(a[ai]);
    i = ai + 1;
    j = bj + 1;
  }
  // tail blocks
  const tailA = a.slice(i);
  const tailB = b.slice(j);
  if (tailA.length > 0 && tailB.length > 0) return null;
  if (tailA.length > 0) res.push(...tailA);
  if (tailB.length > 0) res.push(...tailB);
  return res.join("\n");
}

function buildLCS(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length,
    m = b.length;
  const dp: number[][] = Array(n + 1)
    .fill(0)
    .map(() => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const seq: Array<[number, number]> = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      seq.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return seq;
}
