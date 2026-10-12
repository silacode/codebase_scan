export const SHORT_COMMIT_LENGTH = 12;

export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const folder = (dir?: string) => (!dir || dir === '.' ? 'Repository root' : dir);
export const date = (value?: string) =>
  value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
