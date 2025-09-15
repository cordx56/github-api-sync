import type { DataAdapter } from "obsidian";
import { GitHubClient } from "./github";

export type MerkleGenericNode<C> = {
  path: string;
  hash: string;
  children: C;
};
export type MerkleNode = MerkleDirNode | MerkleFileNode;
export type MerkleDirNode = MerkleGenericNode<
  (MerkleDirNode | MerkleFileNode)[]
>;
export type MerkleFileNode = MerkleGenericNode<null>;

export interface Differences {
  left: string[];
  both: string[];
  right: string[];
}

export interface LocalConfig {
  adapter: DataAdapter;
  /** Root prefix within the vault (optional). Use "" for full vault. */
  root?: string;
}

export interface RemoteConfig {
  client: GitHubClient;
  owner: string;
  repo: string;
  ref: string;
}

export const sha1Hex = async (input: Uint8Array | string): Promise<string> => {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest(
    "SHA-1",
    data.buffer as ArrayBuffer,
  );
  const u8 = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < u8.length; i++)
    out += u8[i].toString(16).padStart(2, "0");
  return out;
};

export const gitBlobSha1Hex = async (
  input: Uint8Array | string,
): Promise<string> => {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const header = `blob ${data.byteLength}\x00`;
  const enc = new TextEncoder().encode(header);
  const buf = new Uint8Array(enc.length + data.length);
  buf.set(enc, 0);
  buf.set(data, enc.length);
  return sha1Hex(buf);
};

export class MerkleTreeBuilder {
  /**
   * Compute a directory hash from children hashes (stable order).
   */
  static async calcDirHash(node: MerkleDirNode): Promise<string> {
    const items = node.children
      .concat()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((c) => `${c.path}:${c.hash}`)
      .join("|");
    return sha1Hex(items);
  }

  static async buildTree(
    files: string[],
    getHashFunc: (path: string) => Promise<string> | string,
  ): Promise<MerkleDirNode> {
    const dirDepthSorted = files.sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );

    const appendChild = async (path: string, node: MerkleDirNode) => {
      const splitted = path.split("/");
      const basename = splitted.last();
      const currentDirPath = 0 < node.path.length ? `${node.path}/` : "";

      if (splitted.length === 1) {
        const filePath = `${currentDirPath}${basename}`;
        node.children.push({
          path: filePath,
          hash: "",
          children: null,
        });
        return;
      }

      // Compare using full path at this depth (not just the segment name)
      const childFullPath = `${currentDirPath}${splitted[0]}`;
      let found = node.children.find((v) => v.path === childFullPath);
      if (!found || found.children === null) {
        found = {
          path: childFullPath,
          hash: "",
          children: [],
        };
        node.children.push(found);
      }
      await appendChild(splitted.slice(1).join("/"), found);
    };
    const tree: MerkleDirNode = { path: "", hash: "", children: [] };
    await Promise.all(dirDepthSorted.map((path) => appendChild(path, tree)));

    const calcHashRecursive = async (node: MerkleNode) => {
      if (node.children === null) {
        if (node.hash.length === 0) {
          node.hash = await getHashFunc(node.path);
        }
      } else {
        node.children.sort((a, b) => a.path.localeCompare(b.path));
        await Promise.all(node.children.map((v) => calcHashRecursive(v)));
        node.hash = await MerkleTreeBuilder.calcDirHash(node);
      }
    };
    await calcHashRecursive(tree);

    return tree;
  }
}

export class MerkleDiff {
  static findDifferences(left: MerkleNode, right: MerkleNode): Differences {
    const differences: Differences = { left: [], both: [], right: [] };

    const compareRecursive = (
      leftChildren: MerkleNode[],
      rightChildren: MerkleNode[],
    ) => {
      const compared = new Set();
      for (const leftChild of leftChildren) {
        compared.add(leftChild.path);
        const found = rightChildren.find((v) => leftChild.path === v.path);
        if (!found) {
          if (leftChild.children !== null) {
            compareRecursive(leftChild.children, []);
          } else {
            differences.left.push(leftChild.path);
          }
          continue;
        }
        if (leftChild.hash === found.hash) {
          continue;
        }
        if (leftChild.children === null || found.children === null) {
          differences.both.push(leftChild.path);
        }
        compareRecursive(leftChild.children || [], found.children || []);
      }
      for (const rightChild of rightChildren) {
        if (compared.has(rightChild.path)) {
          continue;
        }
        const found = leftChildren.find((v) => rightChild.path === v.path);
        if (!found) {
          if (rightChild.children !== null) {
            compareRecursive([], rightChild.children);
          } else {
            differences.right.push(rightChild.path);
          }
          continue;
        }
        if (rightChild.hash === found.hash) {
          continue;
        }
        if (rightChild.children === null || found.children === null) {
          differences.both.push(rightChild.path);
        }
        compareRecursive(found.children || [], rightChild.children || []);
      }
    };

    compareRecursive([left], [right]);

    return differences;
  }
}

export default {
  MerkleTreeBuilder,
  MerkleDiff,
};
