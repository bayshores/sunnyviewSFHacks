import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import puppeteer from "puppeteer-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");

const STRUCTURIZR_OUT_DIR = path.join(REPO_ROOT, "structurizr", "out");
const DIAGRAMS_OUT_DIR = path.join(REPO_ROOT, "structurizr", "diagrams");
const LOGO_PATH = path.join(REPO_ROOT, "sunnyviewlogo.svg");

function windowsBrowserCandidates(programFilesDir, fallbackDir) {
  const base = programFilesDir || fallbackDir;
  return [
    path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
}

// Common browser locations, checked in order when CHROME_BIN is not set.
const BROWSER_CANDIDATES = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  // Windows
  ...windowsBrowserCandidates(process.env.ProgramFiles, "C:\\Program Files"),
  ...windowsBrowserCandidates(process.env["ProgramFiles(x86)"], "C:\\Program Files (x86)"),
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** CHROME_BIN wins; otherwise the first installed candidate, or null when none exists. */
function resolveChromeBin() {
  const fromEnv = process.env.CHROME_BIN?.trim();
  if (fromEnv) return fromEnv;
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

const CHROME_BIN = resolveChromeBin();

const OUTPUT_WIDTH = Number.parseInt(process.env.DIAGRAM_WIDTH ?? "1920", 10);
const OUTPUT_HEIGHT = Number.parseInt(process.env.DIAGRAM_HEIGHT ?? "1080", 10);
const OUTPUT_DPR = Number.parseFloat(process.env.DIAGRAM_DPR ?? "1");

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function startStaticServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const requestPath = decodeURIComponent(url.pathname);
      const safePath = requestPath.replace(/^\/+/, "");
      const absolutePath = path.resolve(rootDir, safePath.length ? safePath : "index.html");

      if (!absolutePath.startsWith(path.resolve(rootDir))) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
      }

      const data = await fs.readFile(absolutePath);
      res.writeHead(200, { "content-type": contentTypeFor(absolutePath) });
      res.end(data);
    } catch (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start static server");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await pathExists(STRUCTURIZR_OUT_DIR))) {
    throw new Error(
      `Missing static export at ${STRUCTURIZR_OUT_DIR}. Run: bash structurizr/bin/structurizr-cli/structurizr.sh export -w structurizr/workspace.dsl -f static -o structurizr/out`
    );
  }

  if (!CHROME_BIN) {
    throw new Error(
      "Chrome, Chromium, or Microsoft Edge not found. Install one of them or set CHROME_BIN to the browser executable path."
    );
  }

  if (!(await pathExists(CHROME_BIN))) {
    throw new Error(
      `Chrome not found at ${CHROME_BIN}. Set CHROME_BIN to your Chrome executable path.`
    );
  }

  await fs.mkdir(DIAGRAMS_OUT_DIR, { recursive: true });

  const logoSvg = await fs.readFile(LOGO_PATH, "utf8");
  const logoDataUrl = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString("base64")}`;

  const { baseUrl, close } = await startStaticServer(STRUCTURIZR_OUT_DIR);

  const browser = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

    // 16:9 output frame (default 3840x2160).
    await page.setViewport({
      width: OUTPUT_WIDTH,
      height: OUTPUT_HEIGHT,
      deviceScaleFactor: OUTPUT_DPR,
    });

    // Prevent the intro modal from showing.
    await page.setCookie({
      name: "structurizr.static.introductionModal",
      value: "false",
      url: baseUrl,
    });

    // Force light mode for deterministic exports.
    await page.setCookie({
      name: "structurizr.renderingMode",
      value: "light",
      url: baseUrl,
    });

    await page.goto(`${baseUrl}/index.html#general-architecture`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    await page.waitForFunction(
      () =>
        typeof window !== "undefined" &&
        window.structurizr &&
        structurizr.diagram &&
        structurizr.diagram.getCurrentViewOrFilter &&
        structurizr.diagram.getCurrentViewOrFilter().key,
      { timeout: 60000 }
    );

    const diagrams = [
      {
        key: "general-architecture",
        fileBase: "general-architecture",
        title: "SUNNYVIEW / GENERAL ARCHITECTURE",
        subtitle: "Containers, optional services, and external integrations",
      },
      {
        key: "main-feature",
        fileBase: "main-feature",
        title: "SUNNYVIEW / MAIN FEATURE",
        subtitle: "Trace roof -> layout -> estimate flow",
      },
    ];

    for (const diagram of diagrams) {
      const outPath = path.join(DIAGRAMS_OUT_DIR, `${diagram.fileBase}.png`);

      await page.evaluate(
        async ({ viewKey, title, subtitle, logo, outputWidth, outputHeight }) => {
          // The Structurizr static export produced by the CLI doesn't bundle CryptoJS,
          // but some versions of structurizr-util.js expect it for base64 encoding.
          // Patch in btoa/atob helpers so exportCurrentDiagramToPNG works.
          if (
            typeof CryptoJS === "undefined" &&
            typeof structurizr !== "undefined" &&
            structurizr.util
          ) {
            structurizr.util.btoa = function (plain) {
              const bytes = new TextEncoder().encode(String(plain));
              let bin = "";
              for (let i = 0; i < bytes.length; i++) {
                bin += String.fromCharCode(bytes[i]);
              }
              return btoa(bin);
            };

            structurizr.util.atob = function (encoded) {
              const bin = atob(String(encoded));
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) {
                bytes[i] = bin.charCodeAt(i);
              }
              return new TextDecoder().decode(bytes);
            };
          }

          function sleep(ms) {
            return new Promise((r) => setTimeout(r, ms));
          }

          function waitForImage(img) {
            return new Promise((resolve, reject) => {
              if (img.complete && img.naturalWidth > 0) {
                resolve();
                return;
              }
              img.onload = () => resolve();
              img.onerror = (e) => reject(e);
            });
          }

          // Clear any previous render root.
          const existing = document.getElementById("opencode-export-root");
          if (existing) existing.remove();

          await new Promise((resolve) => {
            structurizr.diagram.changeView(viewKey, () => resolve());
          });

          // Let autolayout settle.
          await sleep(250);

          // Export the diagram as SVG and crop it client-side.
          // This avoids canvas taint issues that can happen with SVG->PNG conversion.
          const rawSvg = structurizr.diagram.exportCurrentDiagramToSVG(false);
          const BG = "#05060A";
          const pad = Math.max(30, Math.round(outputWidth * 0.028));
          const headerH = Math.max(140, Math.round(outputHeight * 0.13));
          const cropMargin = Math.max(44, Math.round(outputWidth * 0.016));
          const titleSize = Math.max(34, Math.round(outputHeight * 0.040));
          const subtitleSize = Math.max(17, Math.round(outputHeight * 0.017));
          const logoH = Math.max(68, Math.round(outputHeight * 0.062));

          const root = document.createElement("div");
          root.id = "opencode-export-root";
          root.style.cssText =
            `position: fixed; left: 0; top: 0; width: ${outputWidth}px; height: ${outputHeight}px;` +
            ` z-index: 2147483647; overflow: hidden; display: flex; flex-direction: column;` +
            ` background: ${BG}; color: #F8FAFC;` +
            ' font-family: "Space Grotesk", ui-sans-serif, system-ui, -apple-system, sans-serif;';

          const header = document.createElement("div");
          header.style.cssText =
            `height: ${headerH}px; padding: ${Math.round(headerH * 0.18)}px ${pad}px ${Math.round(
              headerH * 0.14
            )}px ${pad}px;` +
            " display: flex; align-items: center; justify-content: flex-start; gap: 28px;" +
            ` background: radial-gradient(1100px 260px at 0% 0%, rgba(56,189,248,0.16) 0%, rgba(5,6,10,0) 55%),` +
            ` radial-gradient(900px 240px at 100% 0%, rgba(245,158,11,0.12) 0%, rgba(5,6,10,0) 60%), ${BG};` +
            " border-bottom: 1px solid rgba(148,163,184,0.18);" +
            " position: relative;";

          const accent = document.createElement("div");
          accent.style.cssText =
            "position: absolute; left: 0; bottom: 0; height: 4px; width: 100%;" +
            " background: linear-gradient(90deg, #38BDF8 0%, #0F766E 45%, #F59E0B 100%);";
          header.appendChild(accent);

          const brand = document.createElement("div");
          brand.style.cssText = "display: flex; align-items: center; gap: 22px; min-width: 0;";

          const logoImg = document.createElement("img");
          logoImg.src = logo;
          logoImg.alt = "Sunnyview";
          logoImg.style.cssText =
            `height: ${logoH}px; width: auto; flex: 0 0 auto;` +
            " filter: invert(1) brightness(1.08); opacity: 0.95;";

          const left = document.createElement("div");
          left.style.cssText = "display: flex; flex-direction: column; min-width: 0;";

          const h1 = document.createElement("div");
          h1.textContent = title;
          h1.style.cssText =
            `font-size: ${titleSize}px; font-weight: 750; line-height: 1.02; letter-spacing: 0.6px;` +
            " color: #F8FAFC; text-transform: uppercase;";
          left.appendChild(h1);

          if (subtitle && subtitle.trim().length) {
            const h2 = document.createElement("div");
            h2.textContent = subtitle;
            h2.style.cssText =
              `margin-top: 10px; font-size: ${subtitleSize}px; font-weight: 500; line-height: 1.25;` +
              " color: #94A3B8;";
            left.appendChild(h2);
          }

          brand.appendChild(logoImg);
          brand.appendChild(left);
          header.appendChild(brand);

          const body = document.createElement("div");
          body.style.cssText =
            `flex: 1 1 auto; padding: ${pad}px; background: ${BG};` +
            " display: flex; align-items: center; justify-content: center;";

          const frame = document.createElement("div");
          frame.style.cssText = "width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;";

          const svgSizer = document.createElement("div");
          svgSizer.style.cssText =
            "position: relative; overflow: hidden;" +
            " background: #05060A;";

          const svgWrap = document.createElement("div");
          svgWrap.style.cssText = "display: inline-block; transform-origin: top left;";
          svgWrap.innerHTML = rawSvg;

          const svg = svgWrap.querySelector("svg");
          if (!svg) throw new Error("Failed to find exported SVG");
          svg.style.display = "block";
          svg.style.maxWidth = "none";
          svg.style.background = BG;

          // Relationship label boxes are rendered using the diagram canvas colour
          // (white in light mode). The exported SVG has its class attributes stripped,
          // so we detect "white" rect fills and re-skin them.
          svg.querySelectorAll("rect").forEach((rect) => {
            const fill = (rect.getAttribute("fill") ?? "").replace(/\s+/g, "").toLowerCase();
            const isWhite =
              fill === "#fff" ||
              fill === "#ffffff" ||
              fill === "white" ||
              fill === "rgb(255,255,255)" ||
              fill === "rgba(255,255,255,1)";

            if (!isWhite) return;

            rect.setAttribute("fill", BG);
            rect.setAttribute("fill-opacity", "0.92");
            rect.setAttribute("stroke", "rgba(148,163,184,0.18)");
            rect.setAttribute("stroke-width", "1");
            rect.setAttribute("rx", "10");
            rect.setAttribute("ry", "10");
          });

          // Remove Structurizr-generated boundary boxes (software system/group frames)
          // so exports only show nodes + connectors.
          svg.querySelectorAll(".structurizrBoundary").forEach((boundary) => {
            const group = boundary.closest("g");
            if (group) {
              group.setAttribute("display", "none");
              group.style.display = "none";
            } else {
              boundary.setAttribute("display", "none");
              boundary.style.display = "none";
            }
          });

          // Fallback for exports where boundary class names are stripped.
          // Hide very large dark rectangles that act as frame/boundary boxes.
          const rawW = Number.parseFloat(svg.getAttribute("width") ?? "0");
          const rawH = Number.parseFloat(svg.getAttribute("height") ?? "0");
          svg.querySelectorAll("rect").forEach((rect) => {
            const w = Number.parseFloat(rect.getAttribute("width") ?? "0");
            const h = Number.parseFloat(rect.getAttribute("height") ?? "0");
            if (!rawW || !rawH) return;
            if (w < rawW * 0.55 || h < rawH * 0.35) return;

            const fill = (rect.getAttribute("fill") ?? "").replace(/\s+/g, "").toLowerCase();
            const darkFill =
              fill === "#05060a" ||
              fill === "#0b1220" ||
              fill === "rgb(5,6,10)" ||
              fill === "rgb(11,18,32)";

            if (darkFill) {
              const group = rect.closest("g");
              if (group) {
                group.setAttribute("display", "none");
                group.style.display = "none";
              } else {
                rect.setAttribute("display", "none");
                rect.style.display = "none";
              }
            }
          });

          // Hide relationship text labels in exported README images to avoid clutter
          // and tiny overlapping text around dense connector areas.
          svg.querySelectorAll("g.label").forEach((g) => {
            g.setAttribute("display", "none");
            g.style.display = "none";
          });

          // Hide any diagram metadata that may have been exported (title/description/logo).
          svg.querySelectorAll(".structurizrMetadata").forEach((el) => {
            el.setAttribute("display", "none");
            // Also cover cases where display is controlled via CSS.
            el.style.display = "none";
          });

          svgSizer.appendChild(svgWrap);
          frame.appendChild(svgSizer);
          body.appendChild(frame);

          root.appendChild(header);
          root.appendChild(body);
          document.body.appendChild(root);

          await waitForImage(logoImg);
          await sleep(50);

          const bbox = svg.getBBox();
          const x = bbox.x - cropMargin;
          const y = bbox.y - cropMargin;
          const w = bbox.width + cropMargin * 2;
          const h = bbox.height + cropMargin * 2;

          svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
          svg.setAttribute("width", String(Math.ceil(w)));
          svg.setAttribute("height", String(Math.ceil(h)));
          svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

          const availableW = outputWidth - pad * 2;
          const availableH = outputHeight - headerH - pad * 2;
          const scale = Math.min(availableW / w, availableH / h);

          const scaledW = Math.floor(w * scale);
          const scaledH = Math.floor(h * scale);

          svgSizer.style.width = `${scaledW}px`;
          svgSizer.style.height = `${scaledH}px`;
          svgWrap.style.transform = `scale(${scale})`;

          await sleep(50);
        },
        {
          viewKey: diagram.key,
          title: diagram.title,
          subtitle: diagram.subtitle,
          logo: logoDataUrl,
          outputWidth: OUTPUT_WIDTH,
          outputHeight: OUTPUT_HEIGHT,
        }
      );

      const element = await page.waitForSelector("#opencode-export-root", { timeout: 60000 });
      if (!element) {
        throw new Error("Render root not found");
      }

      await element.screenshot({
        path: outPath,
        captureBeyondViewport: true,
      });

      await page.evaluate(() => {
        document.getElementById("opencode-export-root")?.remove();
      });

      console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);
    }
  } finally {
    await browser.close();
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
