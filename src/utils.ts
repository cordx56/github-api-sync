import { requestUrl } from "obsidian";
// @ts-ignore
import * as gitignoreParser from "gitignore-parser";

const GITHUB_API = "https://api.github.com";

export const ghGraphql = async <T>(
  token: string,
  query: string,
  variables: Record<string, any>,
): Promise<T> => {
  const res = await requestUrl({
    url: `${GITHUB_API}/graphql`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = res.json as any;
  if (data?.errors?.length) {
    throw new Error(data.errors.map((e: any) => e.message).join(", "));
  }
  return data.data as T;
};

export const ghRest = async <T = any>(
  token: string,
  method: string,
  path: string,
  query?: Record<string, any>,
): Promise<T> => {
  const url = new URL(`${GITHUB_API}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await requestUrl({
    url: url.toString(),
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  return res.json as unknown as T;
};

export const ghRestRaw = async (
  token: string,
  path: string,
  query?: Record<string, any>,
): Promise<Uint8Array> => {
  const url = new URL(`${GITHUB_API}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await requestUrl({
    url: url.toString(),
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
    },
  });
  return new Uint8Array(res.arrayBuffer);
};

export const fetchArrayBuffer = async (url: string): Promise<Uint8Array> => {
  const res = await requestUrl({ url, method: "GET" });
  const ab = res.arrayBuffer;
  return new Uint8Array(ab);
};

export const textRequest = async (url: string): Promise<string> => {
  const res = await requestUrl({ url, method: "GET" });
  return res.text;
};

export const binRequest = async (url: string): Promise<Uint8Array> => {
  return fetchArrayBuffer(url);
};

export const encodeBase64 = (data: ArrayBuffer | Uint8Array): string => {
  try {
    // Prefer Buffer when available (desktop)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof Buffer !== "undefined") {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return Buffer.from(
        data instanceof Uint8Array ? data : new Uint8Array(data),
      ).toString("base64");
    }
  } catch {
    /* ignore */
  }
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(sub) as any);
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return typeof btoa !== "undefined" ? btoa(binary) : "";
};

export class IgnoreManager {
  private adapter: any;
  private cache = new Map<string, any | null>();
  constructor(adapter: any) {
    this.adapter = adapter;
  }
  private async getParser(dir: string): Promise<any | null> {
    if (this.cache.has(dir)) return this.cache.get(dir) ?? null;
    const giPath = dir ? `${dir}/.gitignore` : ".gitignore";
    const exists = await this.adapter.exists(giPath).catch(() => false);
    if (!exists) {
      this.cache.set(dir, null);
      return null;
    }
    try {
      const content = await this.adapter.read(giPath);
      const parser = gitignoreParser.compile(content);
      this.cache.set(dir, parser);
      return parser;
    } catch {
      this.cache.set(dir, null);
      return null;
    }
  }
  async isIgnored(path: string): Promise<boolean> {
    const parts = path.split("/");
    if (parts.contains(".git")) {
      return true;
    }
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const rel = parts.slice(i).join("/");
      const parser = await this.getParser(dir);
      if (parser && parser.denies(rel)) return true;
    }
    return false;
  }

  async ignoreFilter(paths: string[]): Promise<string[]> {
    return (
      await Promise.all(
        paths.map(async (path) => ({
          path,
          ignored: await this.isIgnored(path),
        })),
      )
    )
      .filter((v) => !v.ignored)
      .map((v) => v.path);
  }
}

export const normalizePathNFC = (p: string): string => {
  if (!p) {
    return "";
  }
  const posix = p.replace(/\\/g, "/");
  try {
    return posix.normalize("NFC");
  } catch {
    return posix;
  }
};


const timers: Record<string, number> = {};
export const startTimer = (name: string) => {
  timers[name] = new Date().getTime();
};
export const endTimer = (name: string): number => {
  return (new Date().getTime() - timers[name]) / 1000;
};

/**
 * Logging
 */
const logClass = {
  debug: 40,
  info: 30,
  warn: 20,
  error: 10,
};
let logLevel: number = 0;
export const setLogLevel = (
  level: "debug" | "info" | "warn" | "error" | null,
) => {
  logLevel = level ? logClass[level] : 0;
};
export const logger = (
  level: "debug" | "info" | "warn" | "error",
  ...content: any[]
) => {
  if (logClass[level] <= logLevel) {
    console.log(`github-api-sync: [${level}]`, ...content);
  }
};
