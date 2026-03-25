import { createServer } from "node:http";
import { exec } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SC_LOG = "/tmp/agentbridge.log";
function scLog(msg: string) {
  try { appendFileSync(SC_LOG, `[${new Date().toISOString()}] [SessionConfig] ${msg}\n`); } catch {}
}

export const CONFIG_FILENAME = ".agentbridge.json";

export interface KnowledgeAuth {
  type: "token" | "basic" | "jupyter-password";
  /** Name of the env var that holds the Bearer token (for type="token") */
  envToken?: string;
  /** Name of the env var that holds the password (for type="basic" or "jupyter-password") */
  envPassword?: string;
  /** Username for basic auth (can be plain text, not a secret) */
  username?: string;
  /**
   * If the required env var is unset, open a browser popup asking the user
   * to enter the credential. The value is stored in process.env for the
   * lifetime of this bridge process (not written to disk).
   */
  promptOnMissing?: boolean;
}

export interface KnowledgePath {
  path: string;
  priority?: number;
  /** Auth config for HTTP/HTTPS paths. Credentials are read from env vars, never stored here. */
  auth?: KnowledgeAuth;
}

export interface SessionConfig {
  knowledge?: KnowledgePath[];
  contextPreamble?: string;
  roles?: {
    claude?: string;
    codex?: string;
  };
  notificationFilter?: {
    minLevel?: "debug" | "info" | "warn" | "error";
    markers?: string[];
  };
  deliveryMode?: "push" | "pull";
  /**
   * Knowledge sync mode:
   *   "master" — Claude (Master) fetches knowledge and shares it with Codex (Slave).
   *   "peer"   — Both agents independently fetch their own knowledge on startup.
   * Defaults to "peer".
   */
  syncMode?: "master" | "peer";
}

/**
 * Resolve the config directory from (in priority order):
 *   1. --config-dir <path>  CLI argument passed to bridge.ts
 *   2. AGENTBRIDGE_CONFIG_DIR  environment variable
 *   3. process.cwd()  (default: walk up from working directory)
 */
export function resolveConfigDir(): string {
  // 1. CLI arg: bun run bridge.ts --config-dir /some/path
  const argIdx = process.argv.indexOf("--config-dir");
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const p = process.argv[argIdx + 1];
    return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  }

  // 2. Env var
  const envDir = process.env.AGENTBRIDGE_CONFIG_DIR;
  if (envDir) {
    return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
  }

  // 3. Default: cwd
  return process.cwd();
}

/**
 * Walk up from startDir toward home, looking for .agentbridge.json.
 * Returns the parsed config and the directory it was found in, or null.
 */
export function loadSessionConfig(
  startDir: string = resolveConfigDir(),
): { config: SessionConfig; configDir: string } | null {
  let dir = startDir;
  const home = homedir();

  for (;;) {
    const configPath = join(dir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw) as SessionConfig;
        return { config, configDir: dir };
      } catch {
        return null; // malformed JSON — skip silently
      }
    }
    // If startDir was explicitly provided (not cwd), don't walk up
    if (dir === startDir && startDir !== process.cwd()) break;
    if (dir === home || dir === "/") break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Browser credential prompt ──────────────────────────────────────────────

const PROMPT_HTML = (label: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AgentBridge 认证</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; }
    h2  { margin-bottom: 8px; }
    p   { color: #555; font-size: 14px; margin-bottom: 16px; word-break: break-all; }
    input  { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ccc;
             border-radius: 6px; box-sizing: border-box; margin-bottom: 12px; }
    button { padding: 10px 28px; background: #0066cc; color: #fff; border: none;
             border-radius: 6px; font-size: 14px; cursor: pointer; }
    button:hover { background: #0052a3; }
  </style>
</head>
<body>
  <h2>🔐 AgentBridge 知识库认证</h2>
  <p>${label}</p>
  <form method="POST">
    <input type="password" name="value" placeholder="请输入 Token / 密码" autofocus />
    <button type="submit">确认</button>
  </form>
</body>
</html>`;

const DONE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>AgentBridge</title></head>
<body style="font-family:sans-serif;text-align:center;margin-top:80px">
  <h2>✅ 已收到，可以关闭此窗口</h2>
  <script>setTimeout(()=>window.close(),1500)</script>
</body>
</html>`;

/**
 * Open a browser popup to collect a secret (token / password).
 * Resolves with the entered value, or rejects after 2 minutes.
 */
function promptViaBrowser(label: string): Promise<string> {
  scLog(`promptViaBrowser starting: label=${label}`);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const value = new URLSearchParams(body).get("value") ?? "";
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(DONE_HTML);
          server.close();
          resolve(value);
        });
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PROMPT_HTML(label));
      }
    });

    server.on("error", (err) => {
      reject(new Error(`AgentBridge: 无法启动认证页面服务: ${err.message}`));
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      scLog(`promptViaBrowser server listening on port ${port}, opening browser...`);
      exec(`open "http://127.0.0.1:${port}"`, (execErr) => {
        if (execErr) {
          server.close();
          reject(new Error(`AgentBridge: 无法打开浏览器: ${execErr.message}`));
        }
      });
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("AgentBridge: 等待 Token 输入超时（2分钟）"));
    }, 120_000);
  });
}

// ── Auth resolution ────────────────────────────────────────────────────────

/**
 * Resolve auth headers from an auth config.
 * If the required credential is missing and promptOnMissing is true,
 * opens a browser popup and caches the result in process.env.
 * Returns null if the credential cannot be obtained.
 */
async function resolveAuthHeaders(auth: KnowledgeAuth): Promise<Record<string, string> | null> {
  scLog(`resolveAuthHeaders called: type=${auth.type} promptOnMissing=${auth.promptOnMissing}`);

  if (auth.type === "token") {
    let token = auth.envToken ? process.env[auth.envToken] : undefined;
    scLog(`token from env: ${token ? "(set)" : "(not set)"}`);
    if (!token && auth.promptOnMissing) {
      scLog("Calling promptViaBrowser for token...");
      token = await promptViaBrowser(`请输入访问知识库所需的 Token（JupyterLab）`);
      scLog(`promptViaBrowser returned: ${token ? "(got value)" : "(empty)"}`);
      if (token && auth.envToken) process.env[auth.envToken] = token;
    }
    if (!token) return null;
    return { Authorization: `token ${token}` };
  }

  if (auth.type === "basic") {
    let password = auth.envPassword ? process.env[auth.envPassword] : undefined;
    if (!password && auth.promptOnMissing) {
      const user = auth.username ?? "user";
      password = await promptViaBrowser(`请输入 ${user} 的密码`);
      if (password && auth.envPassword) process.env[auth.envPassword] = password;
    }
    if (!password) return null;
    const username = auth.username ?? "";
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }

  if (auth.type === "jupyter-password") {
    // Check for cached session cookie from a previous login
    const cachedCookie = process.env.__JUPYTER_SESSION_COOKIE;
    if (cachedCookie) {
      scLog("Using cached Jupyter session cookie");
      return { Cookie: cachedCookie };
    }

    let password = auth.envPassword ? process.env[auth.envPassword] : undefined;
    scLog(`jupyter password from env: ${password ? "(set)" : "(not set)"}`);
    if (!password && auth.promptOnMissing) {
      scLog("Calling promptViaBrowser for Jupyter password...");
      password = await promptViaBrowser(`请输入 JupyterLab 的登录密码`);
      scLog(`promptViaBrowser returned: ${password ? "(got value)" : "(empty)"}`);
      if (password && auth.envPassword) process.env[auth.envPassword] = password;
    }
    if (!password) return null;
    // Will be resolved to cookies via jupyterPasswordLogin() in fetchRemotePath
    return { __jupyter_password: password };
  }

  return null;
}

/**
 * Perform JupyterLab password login and return session cookies.
 * Flow: GET /login → extract _xsrf cookie → POST /login with password → extract session cookies
 */
async function jupyterPasswordLogin(
  baseUrl: string,
  password: string,
): Promise<Record<string, string> | null> {
  try {
    scLog(`jupyterPasswordLogin: logging in to ${baseUrl}`);

    // Step 1: GET /login to obtain _xsrf cookie
    const loginPageRes = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    const setCookies1 = loginPageRes.headers.getSetCookie?.() ?? [];
    scLog(`jupyterPasswordLogin: GET /login status=${loginPageRes.status} cookies=${setCookies1.length}`);

    let xsrf = "";
    const cookieJar: string[] = [];
    for (const sc of setCookies1) {
      const pair = sc.split(";")[0];
      cookieJar.push(pair);
      if (pair.startsWith("_xsrf=")) {
        xsrf = pair.split("=")[1];
      }
    }

    // Step 2: POST /login with password (+ _xsrf if present)
    const formBody = new URLSearchParams({ password });
    if (xsrf) formBody.set("_xsrf", xsrf);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (cookieJar.length > 0) headers["Cookie"] = cookieJar.join("; ");
    if (xsrf) headers["X-XSRFToken"] = xsrf;

    scLog(`jupyterPasswordLogin: POST /login xsrf=${xsrf ? "yes" : "no"}`);
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers,
      body: formBody.toString(),
      redirect: "manual",
    });

    scLog(`jupyterPasswordLogin: POST /login status=${loginRes.status}`);

    // Collect all cookies from the login response
    const setCookies2 = loginRes.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies2) {
      const pair = sc.split(";")[0];
      // Replace existing cookie with same name, or add new
      const name = pair.split("=")[0];
      const idx = cookieJar.findIndex((c) => c.startsWith(`${name}=`));
      if (idx >= 0) cookieJar[idx] = pair;
      else cookieJar.push(pair);
    }

    // Login succeeds with 302 redirect (to /) or 200
    if (loginRes.status !== 302 && loginRes.status !== 200) {
      const body = await loginRes.text().catch(() => "");
      scLog(`jupyterPasswordLogin: login failed — ${loginRes.status} ${body.slice(0, 200)}`);
      return null;
    }

    const cookieStr = cookieJar.join("; ");
    scLog(`jupyterPasswordLogin: success, cookies=${cookieJar.length}`);

    // Cache for reuse within this process
    process.env.__JUPYTER_SESSION_COOKIE = cookieStr;

    return { Cookie: cookieStr };
  } catch (err) {
    scLog(`jupyterPasswordLogin: error — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Remote fetch (JupyterLab Contents API aware) ───────────────────────────

interface JupyterContentsEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "notebook";
}

interface JupyterContentsResponse {
  type?: "file" | "directory" | "notebook";
  content?: string | JupyterContentsEntry[];
  format?: string;
}

/**
 * Fetch one URL with auth headers. Returns raw text or null on failure.
 */
async function fetchWithAuth(
  url: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  try {
    scLog(`fetchWithAuth: GET ${url} headers=${JSON.stringify(Object.keys(headers))}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      scLog(`fetchWithAuth: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
      return null;
    }
    scLog(`fetchWithAuth: ${res.status} OK`);
    return res;
  } catch (err) {
    scLog(`fetchWithAuth: error — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Fetch a remote knowledge path.
 * Handles:
 *   - Plain text / markdown files
 *   - JupyterLab Contents API single files  (type="file")
 *   - JupyterLab Contents API directories   (type="directory") — fetches .md/.txt entries
 */
async function fetchRemotePath(
  url: string,
  auth?: KnowledgeAuth,
): Promise<Array<{ sourcePath: string; content: string }>> {
  scLog(`fetchRemotePath called: url=${url} auth=${auth ? "yes" : "no"}`);
  const headers: Record<string, string> = {};

  if (auth) {
    const authHeaders = await resolveAuthHeaders(auth);
    scLog(`resolveAuthHeaders result: ${authHeaders ? Object.keys(authHeaders).join(",") : "null"}`);

    if (authHeaders) {
      // Handle jupyter-password: need to do cookie-based login first
      if (authHeaders.__jupyter_password) {
        const baseUrl = url.replace(/\/api\/contents.*$/, "");
        const cookieHeaders = await jupyterPasswordLogin(baseUrl, authHeaders.__jupyter_password);
        if (cookieHeaders) {
          Object.assign(headers, cookieHeaders);
        } else {
          scLog("jupyterPasswordLogin failed, proceeding without auth");
        }
      } else {
        Object.assign(headers, authHeaders);
      }
    }
  }

  const res = await fetchWithAuth(url, headers);
  scLog(`fetchWithAuth result: ${res ? `status=${res.status}` : "null"}`);
  if (!res) return [];

  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    // Plain text / markdown
    const text = await res.text();
    return text.trim() ? [{ sourcePath: url, content: text }] : [];
  }

  // JupyterLab Contents API JSON
  const json = (await res.json()) as JupyterContentsResponse;

  if (json.type === "file" && typeof json.content === "string" && json.content.trim()) {
    return [{ sourcePath: url, content: json.content }];
  }

  if (json.type === "directory" && Array.isArray(json.content)) {
    // Determine base URL for the Jupyter server (strip /api/contents/... path)
    const apiBase = url.replace(/\/api\/contents.*$/, "");
    const results: Array<{ sourcePath: string; content: string }> = [];

    for (const entry of json.content as JupyterContentsEntry[]) {
      if (entry.type !== "file") continue;
      if (!entry.name.endsWith(".md") && !entry.name.endsWith(".txt")) continue;

      const fileUrl = `${apiBase}/api/contents/${entry.path}`;
      const fileRes = await fetchWithAuth(fileUrl, headers);
      if (!fileRes) continue;

      try {
        const fileJson = (await fileRes.json()) as JupyterContentsResponse;
        if (typeof fileJson.content === "string" && fileJson.content.trim()) {
          results.push({ sourcePath: fileUrl, content: fileJson.content });
        }
      } catch {
        // skip
      }
    }
    return results;
  }

  return [];
}

// ── Local path reader ──────────────────────────────────────────────────────

function readLocalPath(
  rawPath: string,
  baseDir: string,
): Array<{ sourcePath: string; content: string }> {
  const resolved = rawPath.startsWith("/")
    ? rawPath
    : rawPath.startsWith("~/")
      ? join(homedir(), rawPath.slice(2))
      : resolve(baseDir, rawPath);

  if (!existsSync(resolved)) return [];

  const stat = statSync(resolved);

  if (stat.isFile()) {
    try {
      return [{ sourcePath: resolved, content: readFileSync(resolved, "utf-8") }];
    } catch {
      return [];
    }
  }

  if (stat.isDirectory()) {
    const results: Array<{ sourcePath: string; content: string }> = [];
    try {
      for (const name of readdirSync(resolved).sort()) {
        if (!name.endsWith(".md") && !name.endsWith(".txt")) continue;
        const filePath = join(resolved, name);
        try {
          results.push({ sourcePath: filePath, content: readFileSync(filePath, "utf-8") });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // skip unreadable directory
    }
    return results;
  }

  return [];
}

// ── Context builder ────────────────────────────────────────────────────────

/**
 * Build the context string to inject into Claude at session start.
 * Returns null if the config produces no meaningful context.
 * Must be async because remote knowledge paths require HTTP fetches.
 */
export async function buildContextMessage(
  config: SessionConfig,
  configDir: string,
): Promise<string | null> {
  const sections: string[] = [];

  if (config.contextPreamble?.trim()) {
    sections.push(config.contextPreamble.trim());
  }

  if (config.roles) {
    const lines: string[] = [];
    if (config.roles.claude) lines.push(`- Claude: ${config.roles.claude}`);
    if (config.roles.codex) lines.push(`- Codex: ${config.roles.codex}`);
    if (lines.length > 0) {
      sections.push(`## Role Assignments (from .agentbridge.json)\n\n${lines.join("\n")}`);
    }
  }

  if (config.knowledge && config.knowledge.length > 0) {
    const sorted = [...config.knowledge].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    for (const entry of sorted) {
      const isRemote = entry.path.startsWith("http://") || entry.path.startsWith("https://");

      try {
        const files = isRemote
          ? await fetchRemotePath(entry.path, entry.auth)
          : readLocalPath(entry.path, configDir);

        for (const { sourcePath, content } of files) {
          if (content.trim()) {
            sections.push(`## Knowledge: ${sourcePath}\n\n${content.trim()}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        scLog(`Knowledge entry failed: ${entry.path} — ${msg}`);
        sections.push(`## Knowledge: ${entry.path}\n\n⚠️ 加载失败: ${msg}`);
      }
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

// ── Workspace initialiser ──────────────────────────────────────────────────

const WORKSPACE_TEMPLATE: SessionConfig = {
  contextPreamble: "Describe your workspace context here. This text is injected into Claude at session start.",
  roles: {
    claude: "Reviewer, Planner, Decision-maker",
    codex: "Implementer, Executor, Verifier",
  },
  knowledge: [
    {
      path: "./docs",
      priority: 1,
    },
  ],
  deliveryMode: "pull",
  syncMode: "peer",
};

/**
 * Generate a .agentbridge.json template in targetDir.
 * Returns the path of the created file, or throws if it already exists.
 */
export function initWorkspace(targetDir: string = resolveConfigDir()): string {
  const configPath = join(targetDir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    throw new Error(`${configPath} already exists. Edit it directly or delete it first.`);
  }

  const content = JSON.stringify(WORKSPACE_TEMPLATE, null, 2) + "\n";
  writeFileSync(configPath, content, "utf-8");
  return configPath;
}

/**
 * Update the syncMode field in the existing .agentbridge.json.
 * Returns the path of the updated config file.
 */
export function updateSyncMode(mode: "master" | "peer"): string {
  const result = loadSessionConfig();
  if (!result) {
    throw new Error("No .agentbridge.json found in current or parent directories.");
  }
  const { config, configDir } = result;
  config.syncMode = mode;
  const configPath = join(configDir, CONFIG_FILENAME);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  scLog(`syncMode updated to "${mode}" in ${configPath}`);
  return configPath;
}
