import { NotImplementedError } from "@bashreactor/core";

export interface CliIo {
  stderr: (line: string) => void;
}

export function runCli(argv: readonly string[], io: CliIo): number {
  const command = argv[0] ?? "the bare command";
  io.stderr(JSON.stringify(new NotImplementedError(`bashreactor: ${command}`).toBody()));
  return 1;
}
