// Tiny fixture used by parse_typescript integration tests.

import { readFile } from "node:fs/promises";

export function greet(name: string): string {
  return `hello ${name}`;
}

export class Greeter {
  hello(name: string): string {
    return greet(name);
  }

  shout(name: string): string {
    return this.hello(name).toUpperCase();
  }
}

export async function main(): Promise<string> {
  const g = new Greeter();
  await readFile("/dev/null");
  return g.shout("world");
}
