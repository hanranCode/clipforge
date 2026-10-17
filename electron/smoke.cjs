const http = require("http");
const { execFileSync } = require("child_process");
const { createRequire } = require("module");

async function verifyDesktopRuntime({ url, serverEntry, ffmpegPath, ffprobePath, window }) {
  const projects = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/project`, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || !Array.isArray(data)) throw new Error(`Database probe failed (${response.statusCode})`);
          resolve(data);
        } catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error("Database probe timed out")));
    request.on("error", reject);
  });
  for (const binary of [ffmpegPath, ffprobePath]) {
    if (!binary) throw new Error("Bundled media tool not found");
    execFileSync(binary, ["-version"], { timeout: 15_000, windowsHide: true, stdio: "pipe" });
  }
  const native = createRequire(serverEntry)("sherpa-onnx-node");
  if (typeof native.OfflineRecognizer !== "function") throw new Error("Local SenseVoice runtime is unavailable");
  await window.loadURL(`${url}/start`);
  const appearance = await window.webContents.executeJavaScript(`({
    dark: document.documentElement.classList.contains('dark'),
    background: getComputedStyle(document.body).backgroundColor,
    startBackground: document.querySelector('.cf-root') ? getComputedStyle(document.querySelector('.cf-root')).backgroundColor : null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    hasApp: document.body.textContent.includes('ClipForge')
  })`);
  if (appearance.dark || appearance.prefersDark || appearance.background !== "rgb(248, 250, 252)" || appearance.startBackground !== "rgb(248, 250, 252)" || !appearance.colorScheme.includes("light") || !appearance.hasApp) {
    throw new Error(`Light interface probe failed: ${JSON.stringify(appearance)}`);
  }
  return { database: true, projects: projects.length, mediaTools: true, senseVoice: true, appearance };
}

module.exports = { verifyDesktopRuntime };
