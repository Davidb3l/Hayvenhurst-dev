// Fixture for the TypeScript imports test. File-level imports should
// anchor against the synthetic `module` node, not the file path.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

export function main(): string {
  return path.join("a", "b");
}
