import Mock = jest.Mock;
import {Github} from './github';
import {ResponseError} from '../../util/superagent-support';

const buildSecondaryRateLimitError = (): ResponseError => {
  const error = new Error('secondary rate limit') as ResponseError;

  error.status = 403;
  error.response = {
    text: 'You have hit a secondary rate limit error',
    status: 403,
    statusCode: 403,
    header: {
      'Retry-After': 1,
    },
    req: {},
  };

  return error;
}

jest.setTimeout(60000);

describe('github', () => {
  test('canary verifies test infrastructure', () => {
    expect(true).toBe(true);
  });

  let classUnderTest: Github;
  beforeEach(() => {
    classUnderTest = new Github({} as any);
  })

  describe('given exec()', () => {
    let testFunction: Mock;
    beforeEach(() => {
      testFunction = jest.fn();
    });

    describe('when function is successful', () => {
      const expected = {value: true};
      beforeEach(() => {
        testFunction.mockResolvedValue(expected);
      });

      test('then return reply without delay', async () => {
        const actual = await classUnderTest.exec(testFunction, 'test');

        expect(actual).toEqual(expected);
      });
    });

    describe('when call fails multiple times with secondary rate limit error', () => {
      const expected = {value: true};
      beforeEach(() => {
        testFunction.mockRejectedValueOnce(buildSecondaryRateLimitError());
        testFunction.mockRejectedValueOnce(buildSecondaryRateLimitError());
        testFunction.mockRejectedValueOnce(buildSecondaryRateLimitError());
        testFunction.mockRejectedValueOnce(buildSecondaryRateLimitError());
        testFunction.mockResolvedValue(expected);
      });

      test('then return reply after delay and retries', async () => {
        const actual = await classUnderTest.exec(testFunction, 'test');

        expect(actual).toEqual(expected);
      });
    });
  });
});
