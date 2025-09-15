import { App, PluginSettingTab, Setting } from "obsidian";
import GithubApiSyncPlugin from "./main";
import { OperationMode, AutoSyncMode, PluginSettings } from "./types";

export class GithubApiSyncSettingTab extends PluginSettingTab {
  plugin: GithubApiSyncPlugin;

  constructor(app: App, plugin: GithubApiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "GitHub API Sync" });

    new Setting(containerEl)
      .setName("GitHub Username")
      .setDesc("Your GitHub account username.")
      .addText((text) =>
        text
          .setPlaceholder("octocat")
          .setValue(this.plugin.settings.githubUsername)
          .onChange(async (value) => {
            this.plugin.settings.githubUsername = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("GitHub Token (PAT)")
      .setDesc("Stored locally in Obsidian's plugin data.")
      .addText((text) => {
        text
          .setPlaceholder("github_pat_...")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (value) => {
            this.plugin.settings.githubToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Repository Path")
      .setDesc("Format: owner/repo (e.g., octocat/hello-world)")
      .addText((text) =>
        text
          .setPlaceholder("owner/repo")
          .setValue(this.plugin.settings.repositoryPath)
          .onChange(async (value) => {
            this.plugin.settings.repositoryPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max File Size (MB)")
      .setDesc("Skip downloads larger than this size.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.maxFileSizeMB))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.maxFileSizeMB =
              Number.isFinite(n) && n > 0 ? n : 5;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync Target File Type")
      .setDesc("Target file types to sync")
      .addDropdown((dd) => {
        dd.addOption("normal", "Normal");
        dd.addOption("includeConfig", "Include config files");
        dd.addOption("includeHidden", "Include all hidden files");
        dd.setValue(this.plugin.settings.targetFileType);
        dd.onChange(async (value: PluginSettings["targetFileType"]) => {
          this.plugin.settings.targetFileType = value;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Auto Sync" });

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch to synchronize (default branch if blank)")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.targetBranch)
          .onChange(async (value) => {
            this.plugin.settings.targetBranch = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Allowed Operation")
      .setDesc("Choose Pull only, Push only, or Bidirectional.")
      .addDropdown((dd) => {
        dd.addOption("pull", "Pull only");
        dd.addOption("push", "Push only");
        dd.addOption("bidirectional", "Bidirectional");
        dd.setValue(this.plugin.settings.operationMode);
        dd.onChange(async (value: OperationMode) => {
          this.plugin.settings.operationMode = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto Sync Mode")
      .setDesc("Disable, run on interval, or on file save.")
      .addDropdown((dd) => {
        dd.addOption("disable", "Disable");
        dd.addOption("interval", "Interval");
        dd.addOption("onsave", "On Save");
        dd.setValue(this.plugin.settings.autoSyncMode);
        dd.onChange(async (value: AutoSyncMode) => {
          this.plugin.settings.autoSyncMode = value;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSyncHooks();
        });
      });

    new Setting(containerEl)
      .setName("Min Interval (minutes)")
      .setDesc("Minimum time gap for auto-sync triggers.")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.autoSyncMinIntervalMin))
          .onChange(async (value) => {
            const n = Number(value);
            this.plugin.settings.autoSyncMinIntervalMin =
              Number.isFinite(n) && n > 0 ? n : 5;
            await this.plugin.saveSettings();
            this.plugin.setupAutoSyncHooks();
          }),
      );

    containerEl.createEl("h3", { text: "Miscellaneous" });

    new Setting(containerEl)
      .setName("Log Level")
      .setDesc("You can view the logs in Developer Tools")
      .addDropdown((dd) => {
        dd.addOption("none", "None");
        dd.addOption("error", "Error");
        dd.addOption("warn", "Warning");
        dd.addOption("info", "Information");
        dd.addOption("debug", "debug");
        dd.setValue(this.plugin.settings.logLevel ?? "none");
        dd.onChange(async (value: PluginSettings["logLevel"]) => {
          this.plugin.settings.logLevel = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
