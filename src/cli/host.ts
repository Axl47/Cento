// `pnpm host`: builds the app, then runs the host (`pnpm host:serve`) in the background as a macOS login agent, so
// it doesn't hold the terminal, starts again whenever you log in, and restarts if it crashes. Rerun after pulling
// changes to rebuild and restart it. `pnpm host:stop` stops it until the next login or `pnpm host`.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "../core/config.ts";

const LABEL = "com.axel.cento-host";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = resolve("data/host.log");
const domain = `gui/${userInfo().uid}`;

/** Stops the agent if it's loaded. */
const bootout = () => {
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {
    // not loaded
  }
};

if (process.argv.includes("--stop")) {
  bootout();
  console.log("Host stopped. It starts again at the next login, or with `pnpm host`.");
  process.exit(0);
}

execFileSync("pnpm", ["exec", "vite", "build"], { stdio: "inherit" });

// launchd starts with a bare PATH: give it this node (pnpm's shebang needs it), uv for the audio engine in the daily
// data refresh, and rsync and ssh for backups.
const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
const uv = execFileSync("which", ["uv"], { encoding: "utf8" }).trim();
const path = [dirname(process.execPath), dirname(uv), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${pnpm}</string>
		<string>host:serve</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${process.cwd()}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${path}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${LOG}</string>
	<key>StandardErrorPath</key>
	<string>${LOG}</string>
</dict>
</plist>
`;
await mkdir(dirname(PLIST), { recursive: true });
await writeFile(PLIST, plist);

const before = await readFile(LOG, "utf8").then((s) => s.length).catch(() => 0);
bootout();
// launchd can take a moment to let go of the old agent.
for (let attempt = 0; ; attempt++) {
  try {
    execFileSync("launchctl", ["bootstrap", domain, PLIST], { stdio: "pipe" });
    break;
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await new Promise((r) => setTimeout(r, 3000));
const started = await readFile(LOG, "utf8").then((s) => s.slice(before).trim()).catch(() => "");
console.log(`\nHost running in the background (starts at login): http://127.0.0.1:${config.hostPort}/now`);
if (started) console.log(started);
console.log(`Log: ${LOG} · stop with \`pnpm host:stop\``);
