import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/** Read-only checks of host state, so waits are decided by facts that survive an OpenCode restart. */
export interface Probe {
  /** Identity of the running OpenCode server process; changes on restart. */
  serverID(): string;
  exists(path: string): boolean;
  /** File size in bytes, or undefined when missing. */
  size(path: string): number | undefined;
  /** Up to `bytes` read from `from` (default: the last `bytes` of the file). */
  read(path: string, bytes: number, from?: number): string;
  /** Kernel start time of `pid`, or undefined when it is not running. */
  processStart(pid: number): string | undefined;
  /** systemd --user ActiveState, or undefined when it cannot be queried. */
  unitState(unit: string): Promise<string | undefined>;
}

function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return psStart(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime) follows the parenthesised command, which may contain spaces.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** No /proc (macOS, BSD): `ps` start time, normalised the same way as bin/oc-job's pidfile. */
function psStart(pid: number): string | undefined {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, LC_ALL: "C" }, timeout: 5000,
    });
    const start = proc.stdout.toString().trim().replace(/\s+/g, " ");
    return proc.exitCode === 0 && start ? start : undefined;
  } catch {
    return undefined;
  }
}

export const hostProbe: Probe = {
  serverID: () => `${process.pid}:${processStart(process.pid) ?? "?"}`,
  exists: (path) => existsSync(path),
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  },
  read(path, bytes, from) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = statSync(path).size;
      const start = from ?? Math.max(0, size - bytes);
      const buffer = Buffer.alloc(Math.max(0, Math.min(bytes, size - start)));
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } catch {
      return "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  processStart,
  async unitState(unit) {
    try {
      const proc = Bun.spawn(["systemctl", "--user", "show", "-p", "ActiveState", "--value", "--", unit], {
        stdout: "pipe", stderr: "ignore", stdin: "ignore", signal: AbortSignal.timeout(5000),
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 && out.trim() ? out.trim() : undefined;
    } catch {
      return undefined;
    }
  },
};
