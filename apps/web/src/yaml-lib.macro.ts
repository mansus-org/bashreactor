export function yamlLibrary(): string {
  const run = Bun.spawnSync([process.execPath, "build", `${import.meta.dir}/yaml-entry.js`, "--target=browser", "--format=esm", "--minify"], { stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}
