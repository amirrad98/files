import { ZoerPausedError } from './pause';

export const REQUEST_DELAY_SETTING = 'bc_bid_request_delay_seconds';
/** 0 adds nothing: Zoer's shared host gap (a random 4 to 16 seconds for BC Bid) is the only spacing. */
export const DEFAULT_REQUEST_DELAY_SECONDS = 0;

export function requestDelaySeconds(config?: Record<string, unknown>) {
  const value = config?.[REQUEST_DELAY_SETTING] ?? DEFAULT_REQUEST_DELAY_SECONDS;
  if (typeof value !== 'number' || !Number.isInteger(value) || (value !== 0 && (value < 10 || value > 300))) {
    throw new Error('BC Bid request delay must be 0 or a whole number from 10 to 300 seconds. Change it in Settings → Plugins → Procurement → Config.');
  }
  return value;
}

/** Additional spacing above Zoer's shared host floor. Failed attempts are spaced too. */
export function createRequestPacing(options: {
  config?: Record<string, unknown>;
  paused?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let finishedAt: number | undefined;
  return async <T>(url: string, capture: () => Promise<T>): Promise<T> => {
    if (new URL(url).hostname !== 'bcbid.gov.bc.ca') return capture();
    const interval = requestDelaySeconds(options.config) * 1000;
    const checkpoint = () => { if (options.paused?.()) throw new ZoerPausedError(); };
    checkpoint();
    // Short waits notice a maintenance pause without opening another page.
    while (finishedAt !== undefined && now() < finishedAt + interval) {
      await sleep(Math.min(1000, finishedAt + interval - now()));
      checkpoint();
    }
    checkpoint();
    try { return await capture(); }
    finally { finishedAt = now(); }
  };
}
