import {Octokit} from '@octokit/core'
import {throttling} from '@octokit/plugin-throttling';
import {retry} from '@octokit/plugin-retry';

export const ThrottledOctokit = Octokit
  .plugin(throttling)
  .plugin(retry)
  .defaults({
    request: { retries: 10 },
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}. Retrying after ${retryAfter} seconds!`);

        return true
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);

        return true
      },
    },
    log: {
      debug: console.log,
      info: console.log,
      warn: console.warn,
      error: console.error
    },
  });
