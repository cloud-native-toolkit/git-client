import {timer} from '../lib/timer';
import first from './first';
import {Logger} from './logger';
import {Container} from 'typescript-ioc';
import {isError} from './error-util';

export function isRetryResult(value: any): value is RetryResult {
  return !!value && (value as RetryResult).retry !== undefined;
}
export interface RetryResult {
  retry: boolean;
  delay?: number;
}
export type EvaluateErrorForRetry = (error: Error) => Promise<RetryResult>;

export function compositeRetryEvaluation(values: EvaluateErrorForRetry[]): EvaluateErrorForRetry {
  const filteredRetryValues: EvaluateErrorForRetry[] = values.filter(v => !!v);

  if (filteredRetryValues.length === 1) {
    return filteredRetryValues[0];
  } else if (filteredRetryValues.length === 0) {
    return async (error: Error): Promise<RetryResult> => ({retry: false});
  }

  return async (error: Error): Promise<RetryResult> => {
    const results: Array<RetryResult | Error> = await Promise.all(
      values
        .map((v: EvaluateErrorForRetry) => v(error))
        .map(p => p.catch(error => error))
    );

    const retryErrors: Error[] = results.filter(isError);
    if (retryErrors.length > 0) {
      const logger = Container.get(Logger);
      logger.log('Error(s) processing retry', retryErrors);
    }

    return first(
      results
        .filter(isRetryResult)
        .filter((v: RetryResult) => v.retry)
    ).valueOr({retry: false});
  };
}

export const retryWithDelay = <T>(f: () => Promise<T>, name: string, retries: number = 10, retryHandler: EvaluateErrorForRetry = () => Promise.resolve({retry: true})) => {
  const logger: Logger = Container.get(Logger);

  return new Promise<T>((resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => {
    logger.debug(name);
    f()
      .then(resolve)
      .catch(async (err) => {
        if (retries > 0) {
          const result: RetryResult | undefined = await retryHandler(err);

          if (result && result.retry) {
            const delay = result.delay || 5000;

            logger.log(`${name}: Retrying after delay of ${Math.round(delay/1000)}s. ${retries} remaining`);
            return timer(delay)
              .then(retryWithDelay.bind(null, f, name, retries - 1, retryHandler))
              .then(resolve as any)
              .catch(reject);
          } else {
            logger.log(`${name}: Error shouldn't be retried: ${err.status}/${err.message}`);
            reject(err);
          }
        } else {
          logger.log(`${name}: Retries exceeded`, {error: err});
          reject(err);
        }
      })
  })

}
