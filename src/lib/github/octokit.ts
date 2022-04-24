import {Octokit} from '@octokit/core'
import {throttling} from '@octokit/plugin-throttling';
import {retry} from '@octokit/plugin-retry';

export const ThrottledOctokit = Octokit
  .plugin(throttling)
  .plugin(retry)
  .defaults({
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`
        );

        if (options.request.retryCount === 0) {
          // only retries once
          octokit.log.info(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        // does not retry, only logs a warning
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`
        );
      },
    },
    log: {
      debug: console.log,
      info: console.log,
      warn: console.warn,
      error: console.error
    },
  });
