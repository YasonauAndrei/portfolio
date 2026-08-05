#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const width = Number(args.width ?? 320);
const height = Number(args.height ?? 640);
const waitMs = Number(args.waitMs ?? args["wait-ms"] ?? 30000);
const force = Boolean(args.force);
const ids = new Set(String(args.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean));
const chromePath = args.chromePath ?? args["chrome-path"] ?? findChrome();

if (!chromePath) {
  throw new Error("Chrome or Edge executable was not found. Pass --chrome-path=... .");
}

const indexHtml = await readFile(path.join(root, "index.html"), "utf8");
const match = indexHtml.match(/const projects = (\[.*?\]);/s);
if (!match) throw new Error("Could not find projects array in index.html.");
let projects = JSON.parse(match[1]);
if (ids.size) projects = projects.filter((project) => ids.has(project.id));
if (!projects.length) throw new Error("No matching projects found.");

const previewDir = path.join(root, "previews");
const profileDir = path.join(root, ".tmp", "chrome-preview-profile");
await mkdir(previewDir, { recursive: true });
await mkdir(profileDir, { recursive: true });

const port = 42000 + Math.floor(Math.random() * 10000);
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  `--window-size=${width},${height}`,
  "--force-device-scale-factor=1",
  "--hide-scrollbars",
  "--allow-file-access-from-files",
  "--enable-webgl",
  "--ignore-gpu-blocklist",
  "--use-angle=swiftshader",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

try {
  await waitForChrome(port, 20000);
  const pageWsUrl = await createPage(port);
  const cdp = await connectCdp(pageWsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: width,
    screenHeight: height,
  });

  for (const project of projects) {
    const sourcePath = path.join(root, project.file);
    const outPath = path.join(previewDir, `${project.id}.png`);
    if (!existsSync(sourcePath)) {
      console.warn(`missing ${project.file}`);
      continue;
    }
    if (existsSync(outPath) && !force) {
      console.log(`skip ${project.id}`);
      continue;
    }

    console.log(`capture ${project.id}: load + ${waitMs}ms`);
    await navigateAndWait(cdp, pathToFileURL(sourcePath).href);
    await delay(waitMs);
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.documentElement.style.margin = '0';
        document.body.style.margin = '0';
        document.body.style.overflow = 'hidden';
        window.scrollTo(0, 0);
      })();`,
      awaitPromise: false,
    });
    await cdp.send("Page.bringToFront");
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(outPath, Buffer.from(result.data, "base64"));
  }

  await cdp.close();
} finally {
  chrome.kill("SIGTERM");
}

console.log(`done: ${previewDir}`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      parsed.force = true;
    } else if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        parsed[body.slice(0, equals)] = body.slice(equals + 1);
      } else {
        parsed[body] = argv[i + 1];
        i++;
      }
    }
  }
  return parsed;
}

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForChrome(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("Chrome DevTools endpoint did not become ready.");
}

async function createPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const page = await response.json();
  if (!page.webSocketDebuggerUrl) throw new Error("Chrome did not return a page websocket URL.");
  return page.webSocketDebuggerUrl;
}

function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const callbacks = new Map();
  const listeners = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && callbacks.has(message.id)) {
      const { resolve, reject } = callbacks.get(message.id);
      callbacks.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result ?? {});
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) listener(message.params ?? {});
    }
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
      },
      once(method) {
        return new Promise((resolve) => {
          const listener = (params) => {
            listeners.set(method, (listeners.get(method) ?? []).filter((entry) => entry !== listener));
            resolve(params);
          };
          listeners.set(method, [...(listeners.get(method) ?? []), listener]);
        });
      },
      close() {
        socket.close();
      },
    }));
    socket.addEventListener("error", reject);
  });
}

async function navigateAndWait(cdp, url) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
