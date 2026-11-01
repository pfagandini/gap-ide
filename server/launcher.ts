import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * How to start GAP on this machine. Everything platform-specific lives here as
 * data, so the session code (gap.ts) is the same everywhere:
 *
 * - native: a `gap` executable (Linux, macOS, or any explicit path).
 * - cygwin: the official Windows installer, which ships GAP inside its own
 *   Cygwin runtime (`<install>\runtime\bin\bash.exe`, GAP in /opt/gap-*).
 * - wsl:    GAP installed inside the Windows Subsystem for Linux.
 *
 * For cygwin and wsl GAP runs behind a wrapper process, so Node's
 * child.kill("SIGINT") cannot reach it. The wrapper prints GAP's own PID first
 * ("@@pid N"), and interrupts are sent with that environment's `kill`.
 */
export interface GapLauncher {
  kind: "native" | "cygwin" | "wsl";
  /** Shown to the user (status bar, /api/info). */
  description: string;
  command: string;
  /** Full argument list for the given GAP arguments. */
  args: (gapArgs: string[]) => string[];
  env?: Record<string, string>;
  /** True if the wrapper prints "@@pid N" before GAP starts. */
  reportsPid: boolean;
  /** Command + args that send a signal to GAP's PID; absent = signal the child. */
  signalCommand?: (pid: string, signal: "INT" | "KILL") => { command: string; args: string[] };
  /** Converts a host path into one GAP can Read(). */
  toGapPath: (hostPath: string) => string;
}

export interface GapSetting {
  /** "auto" finds GAP; the others force a kind. */
  mode: "auto" | "native" | "cygwin" | "wsl";
  /** Executable (native) or GAP install folder (cygwin). */
  path?: string;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const windowsDrivePath = (hostPath: string, prefix: string) => {
  const resolved = path.win32.resolve(hostPath);
  const match = resolved.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return resolved.replace(/\\/g, "/");
  return `${prefix}/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
};

export function nativeLauncher(gapPath: string): GapLauncher {
  return {
    kind: "native",
    description: gapPath,
    command: gapPath,
    args: (gapArgs) => gapArgs,
    reportsPid: false,
    toGapPath: (hostPath) => hostPath
  };
}

/** `installDir` is the folder the Windows installer created, e.g. C:\Program Files\GAP-4.16.0. */
export function cygwinLauncher(installDir: string): GapLauncher {
  const bin = path.win32.join(installDir, "runtime", "bin");
  const bash = path.win32.join(bin, "bash.exe");
  return {
    kind: "cygwin",
    description: `${installDir} (Cygwin)`,
    command: bash,
    // --login sets up PATH like the installer's own shortcut; CHERE_INVOKING
    // keeps the working directory instead of jumping to $HOME.
    args: (gapArgs) => [
      "--login",
      "-c",
      // No double quotes in this script: Windows passes it to Cygwin as one
      // quoted command-line argument.
      `echo @@pid $$; for g in /opt/gap-*/gap; do exec $g ${gapArgs
        .map(shellQuote)
        .join(" ")}; done; echo GAP not found in /opt >&2; exit 127`
    ],
    env: { CHERE_INVOKING: "1", TERM: "dumb" },
    reportsPid: true,
    signalCommand: (pid, signal) => ({
      command: bash,
      args: ["--login", "-c", `kill -${signal} ${pid}`]
    }),
    toGapPath: (hostPath) => windowsDrivePath(hostPath, "/cygdrive")
  };
}

export function wslLauncher(): GapLauncher {
  return {
    kind: "wsl",
    description: "gap in WSL",
    command: "wsl.exe",
    args: (gapArgs) => [
      "-e",
      "bash",
      "-lc",
      `echo @@pid $$; exec gap ${gapArgs.map(shellQuote).join(" ")}`
    ],
    reportsPid: true,
    signalCommand: (pid, signal) => ({
      command: "wsl.exe",
      args: ["-e", "kill", `-${signal}`, pid]
    }),
    toGapPath: (hostPath) => windowsDrivePath(hostPath, "/mnt")
  };
}

// ---- Discovery ---------------------------------------------------------------

const isExecutable = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** `gap` on PATH or in the usual install places (GUI apps on macOS get a short PATH). */
function findNativeGap(): string | null {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/opt/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin")
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "gap");
    if (isExecutable(candidate)) return candidate;
  }
  // Last resort on macOS/Linux: ask a login shell, which reads the user's profile.
  if (process.platform !== "win32") {
    try {
      const shell = process.env.SHELL || "/bin/sh";
      const found = execFileSync(shell, ["-lc", "command -v gap"], {
        encoding: "utf8",
        timeout: 5000
      }).trim();
      if (found && isExecutable(found)) return found;
    } catch {
      // not found
    }
  }
  return null;
}

const versionKey = (name: string) =>
  (name.match(/\d+/g) ?? []).map((part) => part.padStart(5, "0")).join(".");

/** Newest GAP-x.y.z folder from the official Windows installer. */
function findCygwinGap(): string | null {
  const bases = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && path.win32.join(process.env.LOCALAPPDATA, "Programs"),
    "C:\\"
  ].filter((value): value is string => !!value);
  const found: string[] = [];
  for (const base of bases) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^gap[-_ ]?\d/i.test(name)) continue;
      const dir = path.win32.join(base, name);
      if (fs.existsSync(path.win32.join(dir, "runtime", "bin", "bash.exe"))) found.push(dir);
    }
  }
  found.sort((a, b) => versionKey(path.win32.basename(b)).localeCompare(versionKey(path.win32.basename(a))));
  return found[0] ?? null;
}

function wslHasGap(): boolean {
  try {
    execFileSync("wsl.exe", ["-e", "bash", "-lc", "command -v gap"], {
      timeout: 15000,
      stdio: "ignore",
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

/** The launcher for a setting, or an explanation of why GAP was not found. */
export function resolveLauncher(setting: GapSetting): GapLauncher | { error: string } {
  const win = process.platform === "win32";
  if (setting.mode === "native" && setting.path) return nativeLauncher(setting.path);
  if (setting.mode === "cygwin") {
    const dir = setting.path ?? findCygwinGap();
    return dir ? cygwinLauncher(dir) : { error: "No GAP installation found (GAP-x.y.z folder)." };
  }
  if (setting.mode === "wsl") return wslLauncher();

  // auto
  if (setting.path) {
    if (win && fs.existsSync(path.win32.join(setting.path, "runtime", "bin", "bash.exe"))) {
      return cygwinLauncher(setting.path);
    }
    return nativeLauncher(setting.path);
  }
  if (win) {
    const dir = findCygwinGap();
    if (dir) return cygwinLauncher(dir);
    if (wslHasGap()) return wslLauncher();
    return {
      error:
        "GAP was not found. Install it from https://www.gap-system.org/install/windows/ " +
        "(or inside WSL), then restart, or choose its folder in Settings → Locate GAP…"
    };
  }
  const gap = findNativeGap();
  if (gap) return nativeLauncher(gap);
  return {
    error:
      process.platform === "darwin"
        ? "GAP was not found. Install it with Homebrew (brew install gap-system/gap/gap) " +
          "or see https://www.gap-system.org/install/mac/, then restart, " +
          "or choose the gap executable in Settings → Locate GAP…"
        : "GAP was not found on PATH. Install it (e.g. your package manager or " +
          "https://www.gap-system.org/install/), or choose the gap executable in Settings → Locate GAP…"
  };
}
