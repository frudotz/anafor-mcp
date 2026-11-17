export interface GuardFile {
  path: string;
  added: { n: number; text: string }[];
  binary: boolean;
  deleted: boolean;
  isNew: boolean;
}
export interface GuardFinding {
  code: string;
  severity: 'block' | 'review';
  message: string;
  file: string;
  line?: number;
}
export interface GuardResult {
  pass: boolean;
  trusted: boolean;
  approved: boolean;
  blocks: GuardFinding[];
  reviews: GuardFinding[];
  findings: GuardFinding[];
}
export const ALLOWED_HOSTS: string[];
export function parseDiff(diff: string): GuardFile[];
export function packageFindings(
  oldPkg: unknown,
  newPkg: unknown,
): [string, string, string, string][];
export function lockFindings(
  oldLock: unknown,
  newLock: unknown,
): [string, string, string, string][];
export function analyze(
  input: {
    files: GuardFile[];
    pkg?: { old: unknown; new: unknown } | null;
    lock?: { old: unknown; new: unknown } | null;
  },
  opts?: { trusted?: boolean; approved?: boolean },
): GuardResult;
export function report(r: GuardResult): string;
