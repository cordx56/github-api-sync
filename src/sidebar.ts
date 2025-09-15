import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import GithubApiSyncPlugin from "./main";
import { GitHubClient } from "./github";
import { AutoSyncMode, AutoSyncModeValues } from "./types";

export const VIEW_TYPE_GITHUB_SYNC = "github-api-sync-sidebar";

export class GithubSyncView extends ItemView {
  plugin: GithubApiSyncPlugin;
  private branchSelectEl?: HTMLSelectElement;
  private listEl?: HTMLElement;
  private actionsEl?: HTMLElement;
  private selected: Set<string> = new Set();
  private commits: Array<{ sha: string; message: string; htmlUrl: string }> =
    [];

  constructor(leaf: WorkspaceLeaf, plugin: GithubApiSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_GITHUB_SYNC;
  }
  getDisplayText(): string {
    return "GitHub API Sync";
  }
  getIcon(): string {
    return "git-branch";
  }

  async onOpen() {
    const container = this.containerEl;
    container.empty();
    container.classList.add("github-api-sync-container");

    const controls = container.createDiv({ cls: "github-api-sync-controls" });

    const syncSelect = controls
      .createDiv({ cls: "github-api-sync-sync-mode" })
      .createEl("label", { text: "Auto sync: " })
      .createEl("select", { cls: "github-api-sync-sync-select" });
    for (const value of AutoSyncModeValues) {
      const select = syncSelect.createEl("option", { text: value, value });
      select.selected = this.plugin.settings.autoSyncMode === value;
    }
    syncSelect.addEventListener("change", async (v: any) => {
      if (v.target?.value) {
        this.plugin.settings.autoSyncMode = v.target.value as AutoSyncMode;
        await this.plugin.saveSettings();
      }
    });

    const commitEl = container.createDiv({ cls: "github-api-sync-commit" });
    const commitMessageEl = commitEl.createEl("textarea", {
      cls: "github-api-sync-commit-message",
    });
    commitEl
      .createEl("button", {
        cls: "github-api-sync-commit-button",
        text: "Commit & Push",
      })
      .addEventListener("click", async () => {
        const message = commitMessageEl.value;
        await this.commitAll(message);
        commitMessageEl.setText("");
      });

    const branch = container.createDiv({ cls: "github-api-sync-branch" });
    this.branchSelectEl = branch
      .createEl("label", { text: "Branch: " })
      .createEl("select");
    this.branchSelectEl.addEventListener("change", () =>
      this.populateCommits(),
    );
    branch
      .createEl("button", { text: "Refresh" })
      .addEventListener("click", () => this.refresh());

    this.actionsEl = container.createDiv({ cls: "github-api-sync-actions" });
    this.actionsEl
      .createEl("button", { text: "Checkout" })
      .addEventListener("click", () => this.checkoutSelected());

    /* not checked
    const revertBtn = this.actionsEl.createEl("button", { text: "Revert" });
    const squashBtn = this.actionsEl.createEl("button", { text: "Squash" });
    revertBtn.addEventListener("click", () => this.revertSelected());
    squashBtn.addEventListener("click", () => this.squashSelected());
    */

    this.listEl = container.createDiv({ cls: "github-api-sync-list" });

    (async () => {
      await this.refresh();
      this.updateActionsState();
    })();
  }

  async onClose() {}

  private client(): GitHubClient {
    if (!this.plugin.settings.githubToken)
      throw new Error("GitHub token not set");
    return new GitHubClient(this.plugin.settings.githubToken);
  }

  reloadConfig() {
    const syncMode = document
      .getElementsByClassName("github-api-sync-sync-mode")
      .item(0);
    if (syncMode) {
      for (const opt of Array.from(syncMode.getElementsByTagName("option"))) {
        if (this.plugin.settings.autoSyncMode === opt.value) {
          opt.selected = true;
        } else {
          opt.selected = false;
        }
      }
    }
  }

  async populateBranches() {
    const sel = this.branchSelectEl!;
    sel.empty();
    const client = this.client();
    const { owner, repo } = this.plugin.getOwnerRepo();
    const branches = await client.listBranches(owner, repo);
    let target = this.plugin.settings.targetBranch;
    if (!target) {
      try {
        const d = await client.getDefaultBranch(owner, repo);
        target = d.defaultBranch;
      } catch {
        /* ignore */
      }
    }
    branches.forEach((b) => {
      const opt = sel.createEl("option", { text: b.name, value: b.name });
      if (b.name === target) opt.selected = true;
    });
    sel.addEventListener("change", () => this.populateCommits());
  }

  async populateCommits() {
    if (!this.listEl || !this.branchSelectEl) return;
    const branch = this.branchSelectEl.value;
    const client = this.client();
    const { owner, repo } = this.plugin.getOwnerRepo();
    const commits = await client.listCommits(owner, repo, branch, 50);
    this.commits = commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      htmlUrl: c.htmlUrl,
    }));
    this.selected.clear();
    this.listEl.empty();
    for (const c of this.commits) {
      const row = this.listEl.createDiv({ cls: "github-api-sync-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.addEventListener("change", () => {
        if (cb.checked) {
          this.selected.add(c.sha);
        } else {
          this.selected.delete(c.sha);
        }
        this.updateActionsState();
      });
      const headline = c.message.split("\n")[0] || "";
      const link = row.createEl("a", {
        text: c.sha.substring(0, 7),
      });
      link.href = c.htmlUrl;
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        window.open(c.htmlUrl, "_blank");
      });
      row.createDiv({
        text: headline,
        cls: "github-api-message",
      });
    }
    this.updateActionsState();
  }

  private updateActionsState() {
    const count = this.selected.size;
    if (!this.actionsEl) return;
    const [checkoutBtn, revertBtn, squashBtn] = Array.from(
      this.actionsEl.getElementsByTagName("button"),
    );
    if (checkoutBtn) checkoutBtn.toggleAttribute("disabled", count !== 1);
    if (revertBtn) revertBtn.toggleAttribute("disabled", count !== 1);
    if (squashBtn) squashBtn.toggleAttribute("disabled", count < 2);
  }

  private async refresh() {
    await Promise.all([this.populateBranches(), this.populateCommits()]);
  }

  private async commitAll(message: string) {
    if (message.length === 0) {
      new Notice("Specify commit message");
      return;
    }
    await this.plugin.checkout({
      branch: this.branchSelectEl!.value,
      strategy: "push",
      message,
    });
  }

  private async checkoutSelected() {
    this.plugin.settings.autoSyncMode = "disable";
    await this.plugin.saveSettings();
    if (this.selected.size !== 1) return;
    const sha = Array.from(this.selected)[0];
    try {
      this.plugin.settings.autoSyncMode = "disable";
      await this.plugin.checkout({ sha, strategy: "pull" });
      new Notice(`Checked out ${sha.substring(0, 7)}`);
      await this.populateCommits();
    } catch (e: any) {
      new Notice(`Checkout failed: ${e?.message ?? e}`);
    }
  }

  // not checked
  private async revertSelected() {
    if (this.selected.size !== 1) return;
    const sha = Array.from(this.selected)[0];
    const branch = this.branchSelectEl!.value;
    const { owner, repo } = this.plugin.getOwnerRepo();
    try {
      const oid = await this.client().revertSingleCommitOnBranch(
        owner,
        repo,
        branch,
        sha,
      );
      new Notice(`Reverted ${sha.substring(0, 7)} -> ${oid.substring(0, 7)}`);
      await this.populateCommits();
    } catch (e: any) {
      new Notice(`Revert failed: ${e?.message ?? e}`);
    }
  }

  // not checked
  private async squashSelected() {
    if (this.selected.size < 2) return;
    const selectedOrder = this.commits.filter((c) => this.selected.has(c.sha));
    if (selectedOrder.length < 2) return;
    // oldest is the last in list if commits are newest-first
    const oldest = selectedOrder[selectedOrder.length - 1].sha;
    const latest = selectedOrder[0].sha;
    const { owner, repo } = this.plugin.getOwnerRepo();
    const client = this.client();
    try {
      const parentInfo = await client.getCommit(owner, repo, oldest);
      const base = parentInfo.parents?.[0]?.sha;
      if (!base) throw new Error("Cannot determine base for squash.");
      const branch = this.branchSelectEl!.value;
      const oid = await client.squashRangeToSingleCommit(
        owner,
        repo,
        branch,
        base,
        latest,
      );
      new Notice(
        `Squashed ${this.selected.size} commits -> ${oid.substring(0, 7)}`,
      );
      await this.populateCommits();
    } catch (e: any) {
      new Notice(`Squash failed: ${e?.message ?? e}`);
    }
  }
}
