import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  logger[level as Level]({ ...extra }, msg);
