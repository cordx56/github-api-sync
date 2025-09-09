import { FileChangeOp } from "./types";
import { ghGraphql, ghRest, ghRestRaw, encodeBase64 } from "./utils";

export class GitHubClient {
  private token: string;
  constructor(token: string) {
    this.token = token;
  }

  async listBranches(
    owner: string,
    name: string,
  ): Promise<{ name: string; sha: string }[]> {
    const branches = await ghRest<any[]>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/branches`,
      { per_page: 100 },
    );
    return (branches || []).map((b: any) => ({
      name: b.name,
      sha: b.commit?.sha,
    }));
  }

  async listCommits(
    owner: string,
    name: string,
    branch: string,
    perPage = 50,
  ): Promise<
    Array<{
      sha: string;
      message: string;
      author?: { name?: string };
      htmlUrl: string;
    }>
  > {
    const commits = await ghRest<any[]>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/commits`,
      { sha: branch, per_page: perPage },
    );
    return (commits || []).map((c: any) => ({
      sha: c.sha,
      message: c.commit?.message || c.sha,
      author: { name: c.commit?.author?.name },
      htmlUrl:
        c.html_url || `https://github.com/${owner}/${name}/commit/${c.sha}`,
    }));
  }

  async updateBranchRef(
    owner: string,
    name: string,
    branch: string,
    sha: string,
    force = true,
  ): Promise<void> {
    const ref = encodeURIComponent(`heads/${branch}`);
    await ghRest(
      this.token,
      "PATCH",
      `/repos/${owner}/${name}/git/refs/${ref}`,
      { sha, force },
    );
  }

  async getCommit(
    owner: string,
    name: string,
    sha: string,
  ): Promise<{ parents: { sha: string }[] }> {
    const d = await ghRest<any>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/commits/${sha}`,
    );
    return { parents: (d.parents || []).map((p: any) => ({ sha: p.sha })) };
  }

  async compareRange(
    owner: string,
    name: string,
    base: string,
    head: string,
  ): Promise<{ files: any[] }> {
    const d = await ghRest<any>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/compare/${base}...${head}`,
    );
    return { files: d.files || [] };
  }

  async getAllFilesAt(owner: string, name: string, ref: string) {
    const resp = await ghRest<{
      tree: {
        path: string;
        type: "blob" | "tree";
        sha: string;
        size: number;
        url: string;
      }[];
    }>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/git/trees/${ref}?recursive=1`,
    );
    return resp.tree.filter((v) => v.type === "blob");
  }

  async revertSingleCommitOnBranch(
    owner: string,
    name: string,
    branch: string,
    commitSha: string,
  ): Promise<string> {
    const commit = await this.getCommit(owner, name, commitSha);
    const parent = commit.parents?.[0]?.sha;
    if (!parent) throw new Error("Commit has no parent to revert against.");
    const { files } = await this.compareRange(owner, name, parent, commitSha);
    const additions: { path: string; contents: string }[] = [];
    const deletions: { path: string }[] = [];
    for (const f of files) {
      const status = f.status as string;
      if (status === "added") {
        // file was added by the commit -> delete to revert
        deletions.push({ path: f.filename });
      } else if (status === "removed") {
        // file was removed -> restore from parent
        const blob = await this.getBlobAtRef(
          owner,
          name,
          `${parent}:${f.filename}`,
        );
        if (blob && blob.text != null && !blob.isBinary) {
          const enc = new TextEncoder().encode(blob.text);
          additions.push({ path: f.filename, contents: encodeBase64(enc) });
        }
      } else if (status === "modified") {
        // restore previous version
        const blob = await this.getBlobAtRef(
          owner,
          name,
          `${parent}:${f.filename}`,
        );
        if (blob && blob.text != null && !blob.isBinary) {
          const enc = new TextEncoder().encode(blob.text);
          additions.push({ path: f.filename, contents: encodeBase64(enc) });
        }
      } else if (status === "renamed") {
        // delete new filename and restore previous filename
        if (f.filename) deletions.push({ path: f.filename });
        if (f.previous_filename) {
          const blob = await this.getBlobAtRef(
            owner,
            name,
            `${parent}:${f.previous_filename}`,
          );
          if (blob && blob.text != null && !blob.isBinary) {
            const enc = new TextEncoder().encode(blob.text);
            additions.push({
              path: f.previous_filename,
              contents: encodeBase64(enc),
            });
          }
        }
      }
    }
    // Create a new commit on current branch head that reverts the changes
    const headOid = await this.getBranchHeadOid(owner, name, branch);
    const oid = await this.createCommitOnBranch(
      owner,
      name,
      branch,
      headOid,
      additions,
      deletions,
      `Revert ${commitSha.substring(0, 7)}`,
    );
    return oid;
  }

  async squashRangeToSingleCommit(
    owner: string,
    name: string,
    branch: string,
    baseSha: string,
    headSha: string,
  ): Promise<string> {
    const { files } = await this.compareRange(owner, name, baseSha, headSha);
    const additions: { path: string; contents: string }[] = [];
    const deletions: { path: string }[] = [];
    for (const f of files) {
      const status = f.status as string;
      if (status === "removed") {
        deletions.push({ path: f.filename });
      } else if (status === "added" || status === "modified") {
        const expr = `${headSha}:${f.filename}`;
        const blob = await this.getBlobAtRef(owner, name, expr);
        if (blob && blob.text != null && !blob.isBinary) {
          const enc = new TextEncoder().encode(blob.text);
          additions.push({ path: f.filename, contents: encodeBase64(enc) });
        }
      } else if (status === "renamed") {
        if (f.previous_filename) deletions.push({ path: f.previous_filename });
        const expr = `${headSha}:${f.filename}`;
        const blob = await this.getBlobAtRef(owner, name, expr);
        if (blob && blob.text != null && !blob.isBinary) {
          const enc = new TextEncoder().encode(blob.text);
          additions.push({ path: f.filename, contents: encodeBase64(enc) });
        }
      }
    }
    // Move branch to base, then create one commit aggregating changes
    await this.updateBranchRef(owner, name, branch, baseSha, true);
    const oid = await this.createCommitOnBranch(
      owner,
      name,
      branch,
      baseSha,
      additions,
      deletions,
      `Squash commits into one`,
    );
    return oid;
  }
  private async graphql<T>(
    query: string,
    variables: Record<string, any>,
  ): Promise<T> {
    return ghGraphql<T>(this.token, query, variables);
  }

  async getBranchHeadOid(
    owner: string,
    name: string,
    branch: string,
  ): Promise<string> {
    const q = `
      query($owner: String!, $name: String!, $branch: String!) {
        repository(owner: $owner, name: $name) {
          ref(qualifiedName: $branch) {
            target {
              oid
            }
          }
        }
      }
    `;
    const r = await this.graphql<{
      repository: { ref: { target: { oid: string } } };
    }>(q, { owner, name, branch });
    if (!r?.repository?.ref?.target?.oid) {
      throw new Error("Target branch not found");
    }
    return r.repository.ref.target.oid;
  }

  async getDefaultBranch(
    owner: string,
    name: string,
  ): Promise<{ defaultBranch: string; headOid: string }> {
    const q = `
      query($owner:String!, $name:String!) {
        repository(owner:$owner, name:$name) {
          defaultBranchRef { name target { ... on Commit { oid } } }
        }
      }
    `;
    const d = await this.graphql<{
      repository: {
        defaultBranchRef: { name: string; target: { oid: string } };
      };
    }>(q, {
      owner,
      name,
    });
    const repo = d.repository;
    if (!repo?.defaultBranchRef) {
      throw new Error("Repository or default branch not found.");
    }
    return {
      defaultBranch: repo.defaultBranchRef.name,
      headOid: repo.defaultBranchRef.target.oid,
    };
  }

  async getFileChangesSince(
    owner: string,
    name: string,
    baseOid: string,
    headOid: string,
  ): Promise<FileChangeOp[]> {
    // Use REST comparison API to accumulate file changes between two commits.
    const compared = await ghRest<any>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/compare/${baseOid}...${headOid}`,
    );
    const files = compared.files || [];
    const ops: FileChangeOp[] = [];

    for (const file of files) {
      if (file.status === "added") {
        ops.push({ path: file.filename, action: "added" });
      } else if (file.status === "removed") {
        ops.push({ path: file.filename, action: "removed" });
      } else if (file.status === "modified" || file.status === "changed") {
        ops.push({ path: file.filename, action: "modified" });
      } else if (file.status === "renamed") {
        if (file.previous_filename) {
          ops.push({ path: file.previous_filename, action: "removed" });
        }
        ops.push({ path: file.filename, action: "added" });
      }
    }

    // Only keep the final action per path (last wins: delete overrides create/modify)
    const finalMap = new Map<string, FileChangeOp["action"]>();
    for (const op of ops) {
      finalMap.set(op.path, op.action);
    }
    return Array.from(finalMap.entries()).map(([path, action]) => ({
      path,
      action,
    }));
  }

  async getBlobAtRef(
    owner: string,
    name: string,
    expression: string,
  ): Promise<{
    text: string | null;
    byteSize: number;
    isBinary: boolean;
  } | null> {
    const q = `
      query($owner:String!, $name:String!, $expr:String!) {
        repository(owner:$owner, name:$name) {
          object(expression:$expr) {
            __typename
            ... on Blob { text byteSize isBinary }
          }
        }
      }
    `;
    type BlobResp = {
      repository: {
        object: null | {
          __typename: string;
          text?: string | null;
          byteSize?: number;
          isBinary?: boolean;
        };
      };
    };
    const d = await this.graphql<BlobResp>(q, {
      owner,
      name,
      expr: expression,
    });
    const obj = d.repository?.object as any;
    if (!obj || obj.__typename !== "Blob") return null;
    return { text: obj.text, byteSize: obj.byteSize, isBinary: !!obj.isBinary };
  }

  async getFileRawAtRef(
    owner: string,
    name: string,
    branch: string,
    path: string,
  ): Promise<Uint8Array> {
    // Use Contents API with raw Accept header to fetch bytes, supports private repos with token
    const apiPath = `/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`;
    const data = await ghRestRaw(this.token, apiPath, { ref: branch });
    return data;
  }

  async getCommitOidBeforeOrAt(
    owner: string,
    name: string,
    branch: string,
    isoDate: string,
  ): Promise<string | null> {
    const data = await ghRest<any[]>(
      this.token,
      "GET",
      `/repos/${owner}/${name}/commits`,
      {
        sha: branch,
        until: isoDate,
        per_page: 1,
      },
    );
    const sha = Array.isArray(data) && (data[0] as any)?.sha;
    return (sha as string) || null;
  }

  async listAllFilesAtRef(
    owner: string,
    name: string,
    branch: string,
  ): Promise<string[]> {
    const out: string[] = [];
    const walk = async (prefix: string) => {
      const expr = `${branch}:${prefix}`;
      const q = `
        query($owner:String!, $name:String!, $expr:String!) {
          repository(owner:$owner, name:$name) {
            object(expression:$expr) { ... on Tree { entries { name type } } }
          }
        }
      `;
      type TreeResp = {
        repository: {
          object: null | {
            __typename: string;
            entries?: { name: string; type: string }[];
          };
        };
      };
      const d = await this.graphql<TreeResp>(q, { owner, name, expr });
      const obj = d.repository?.object as any;
      if (!obj) return;
      const walkList = [];
      for (const e of obj.entries ?? []) {
        if (e.type === "blob") {
          out.push(prefix ? `${prefix}${e.name}` : e.name);
        } else if (e.type === "tree") {
          walkList.push(walk(prefix ? `${prefix}${e.name}/` : `${e.name}/`));
        }
      }
      await Promise.allSettled(walkList);
    };
    await walk("");
    return out;
  }

  async listAllFilesWithOidAtRef(
    owner: string,
    name: string,
    branch: string,
  ): Promise<Array<{ path: string; oid: string }>> {
    const out: Array<{ path: string; oid: string }> = [];
    const walk = async (prefix: string) => {
      const expr = `${branch}:${prefix}`;
      const q = `
        query($owner:String!, $name:String!, $expr:String!) {
          repository(owner:$owner, name:$name) {
            object(expression:$expr) {
              ... on Tree {
                entries { name type object { oid } }
              }
            }
          }
        }
      `;
      type TreeResp = {
        repository: {
          object: null | {
            __typename: string;
            entries?: {
              name: string;
              type: string;
              object?: { oid?: string } | null;
            }[];
          };
        };
      };
      const d = await this.graphql<TreeResp>(q, { owner, name, expr });
      const obj = d.repository?.object as any;
      if (!obj) return;
      const walkList: Promise<void>[] = [];
      for (const e of obj.entries ?? []) {
        if (e.type === "blob") {
          const path = prefix ? `${prefix}${e.name}` : e.name;
          const oid = (e.object && e.object.oid) || "";
          if (oid) out.push({ path, oid });
        } else if (e.type === "tree") {
          walkList.push(walk(prefix ? `${prefix}${e.name}/` : `${e.name}/`));
        }
      }
      await Promise.allSettled(walkList);
    };
    await walk("");
    return out;
  }

  async getLatestCommitDateForPath(
    owner: string,
    name: string,
    branch: string,
    path: string,
    sinceISO?: string,
  ): Promise<{ oid: string; committedDate: string } | null> {
    const q = `
      query($owner:String!, $name:String!, $qualified:String!, $path:String!) {
        repository(owner:$owner, name:$name) {
          ref(qualifiedName:$qualified) {
            target { ... on Commit { history(first: 1, path: $path, since: ${sinceISO ? "$since" : "null"}) { nodes { oid committedDate } } } }
          }
        }
      }
    `;
    const qualified = `refs/heads/${branch}`;
    type Resp = {
      repository: {
        ref: null | {
          target: {
            history: { nodes: { oid: string; committedDate: string }[] };
          };
        };
      };
    };
    const vars: any = { owner, name, qualified, path };
    if (sinceISO) vars.since = sinceISO;
    const d = await this.graphql<Resp>(q, vars);
    const nodes = d.repository?.ref?.target?.history?.nodes ?? [];
    if (!nodes.length) return null;
    return nodes[0];
  }

  async getCommitDate(
    owner: string,
    name: string,
    oid: string,
  ): Promise<string> {
    const q = `
      query($owner:String!, $name:String!, $oid:GitObjectID!) {
        repository(owner:$owner, name:$name) {
          object(oid:$oid) { ... on Commit { committedDate } }
        }
      }
    `;
    type Resp = { repository: { object: null | { committedDate?: string } } };
    const d = await this.graphql<Resp>(q, { owner, name, oid });
    const date = d.repository?.object?.committedDate;
    if (!date) throw new Error("Commit not found for OID");
    return date;
  }

  async createCommitOnBranch(
    owner: string,
    name: string,
    branch: string,
    expectedHeadOid: string,
    additions: { path: string; contents: string }[],
    deletions: { path: string }[] = [],
    headline = "Obsidian sync",
  ): Promise<string> {
    const q = `
      mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }
    `;
    const input = {
      branch: {
        repositoryNameWithOwner: `${owner}/${name}`,
        branchName: branch,
      },
      message: { headline },
      expectedHeadOid,
      fileChanges: { additions, deletions },
    };
    type Resp = { createCommitOnBranch: { commit: { oid: string } } };
    const d = await this.graphql<Resp>(q, { input });
    return d.createCommitOnBranch.commit.oid;
  }
}
