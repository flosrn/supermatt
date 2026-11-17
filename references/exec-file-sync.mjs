import { spawnSync } from "node:child_process";

export function execFileSyncWithStderr(file, args, options = {}) {
  const result = spawnSync(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  // Match Node's default execFileSync relay, before either returning or throwing.
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw Object.assign(result.error, result);
  if (result.status !== 0) {
    let message = `Command failed: ${[options.argv0 || file, ...args].join(" ")}`;
    if (result.stderr?.length) message += `\n${result.stderr.toString()}`;
    throw Object.assign(new Error(message), result);
  }
  return result.stdout;
}
