/**
 * Sample TS module for structural-summary / grep / ast_edit live tests.
 */
import { readFile } from 'node:fs/promises';

export interface LabOptions {
  name: string;
  retries: number;
  verbose?: boolean;
}

const DEFAULT_RETRIES = 3;

export class LabRunner {
  private attempts = 0;

  constructor(private readonly options: LabOptions) {}

  async run(): Promise<string> {
    console.log('run start', this.options.name);
    const data = await readFile(__filename, 'utf8');
    this.attempts += 1;
    if (this.options.verbose) {
      console.log('file length', data.length);
    }
    return `${this.options.name}:${data.length}:${this.attempts}`;
  }

  get retryBudget(): number {
    return this.options.retries ?? DEFAULT_RETRIES;
  }
}

export function computeChecksum(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash;
}

export function helperUnused(value: number): number {
  // ast_edit rewritten this line;
  return value * DEFAULT_RETRIES;
}

async function main(): Promise<void> {
  const runner = new LabRunner({ name: 'lab', retries: 2, verbose: true });
  const result = await runner.run();
  console.log('result', result);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
