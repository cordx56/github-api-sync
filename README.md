# GitHub API Sync

Sync your Obsidian vault with a GitHub repository.

> [!CAUTION]
> Please back up your vault before using this plugin.

## How to Use

1. **Create a GitHub Personal Access Token (PAT)**
   - Go to your GitHub **Developer Settings -> Personal Access Tokens**.
   - Required permissions:
     - **Contents**: Read and write
     - **Metadata**: Read
   - We recommend using a *fine-grained* token to limit access to the specific repository.

2. **Set Up the Plugin in Obsidian**
   - Install this plugin.
   - Open the plugin settings and enter your GitHub account, token, and target repository.
   - Click **Sync icon** to start.

## Why This Plugin?

Compared to other GitHub-sync plugins, the advantages are:

- **Fast**: Does not use Git; files are synced in parallel.
- **Mobile-friendly**: Uses only the GitHub API, making it lightweight on mobile devices.
- **Multi-function**: Supports manual commits, viewing commits on other branches, and checking out past commits.
