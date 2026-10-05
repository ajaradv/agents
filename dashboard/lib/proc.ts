export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  ms: number;
};

function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

/** Spawn a command with a hard timeout; kill the process group on expiry. */
export async function spawnTimed(
  cmd: string[],
  opts: {
    timeoutMs: number;
    env?: Record<string, string | undefined>;
    stdin?: string;
    cwd?: string;
  },
): Promise<SpawnResult> {
  const started = Date.now();
  const hasStdin = opts.stdin !== undefined;
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: hasStdin ? "pipe" : "ignore",
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  if (hasStdin && proc.stdin) {
    proc.stdin.write(opts.stdin!);
    proc.stdin.end();
  }
  const pid = proc.pid;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (pid) killTree(pid);
  }, opts.timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    timedOut,
    ms: Date.now() - started,
  };
}
