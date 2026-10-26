declare module 'diff' {
  export interface Change { value: string; added?: boolean; removed?: boolean }
  export function diffLines(before: string, after: string, options?: { timeout?: number }): Change[] | undefined;
}
