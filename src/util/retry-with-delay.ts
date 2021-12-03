import {timer} from '../lib/timer';
import first from './first';
import {Logger} from './logger';
import {Container} from 'typescript-ioc';

export interface RetryResult {
  retry: boolean;
  delay?: number;
}
export type EvaluateErrorForRetry = (error: Error) => Promise<RetryResult>;

export function compositeRetryEvaluation(values: EvaluateErrorForRetry[]): EvaluateErrorForRetry {
  return async (error: Error): Promise<RetryResult> => {
    const results: RetryResult[] = await Promise.all(values.map((v: EvaluateErrorForRetry) => v(error)));

    const retryResult = first(results.filter((v: RetryResult) => v.retry));

    if (retryResult) {
      return retryResult;
    }

    return {retry: false};
  };
}

export const retryWithDelay = <T>(f: () => Promise<T>, name: string, retries: number = 10, retryHandler: EvaluateErrorForRetry = () => Promise.resolve({retry: true})) => {
  const logger: Logger = Container.get(Logger);

  return new Promise<T>((resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => {
    return f()
      .then(resolve)
      .catch(async (err) => {
        if (retries > 0) {
          const result: RetryResult = await retryHandler(err);

          if (result.retry) {
            const delay = result.delay || 5000;

            logger.log(`${name}: Retrying after delay of ${Math.round(delay/1000)}s. ${retries} remaining`);
            return timer(delay)
              .then(retryWithDelay.bind(null, f, name, retries - 1, retryHandler))
              .then(resolve as any)
              .catch(reject);
          } else {
            reject(err);
          }
        } else {
          logger.log(`${name}: Retries exceeded`, {error: err});
          reject(err);
        }
      })
  })

}
