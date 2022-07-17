import {timeTextToMilliseconds} from './string-util'

describe('string-util', () => {
  test('canary verifies test infrastructure', () => {
    expect(true).toBe(true);
  });

  describe('given timeTextToMilliseconds()', () => {
    describe('when called with 1h', () => {
      test('then should return 3600000', async () => {
        const actual: number = timeTextToMilliseconds('1h')

        expect(actual).toEqual(1 * 60 * 60 * 1000)
      });
    });
    describe('when called with 10m', () => {
      test('then should return 600000', async () => {
        const actual: number = timeTextToMilliseconds('10m')

        expect(actual).toEqual(10 * 60 * 1000)
      });
    });
    describe('when called with 30s', () => {
      test('then should return 30000', async () => {
        const actual: number = timeTextToMilliseconds('30s')

        expect(actual).toEqual(30 * 1000)
      });
    });
    describe('when called with 8h8m8s', () => {
      test('then should return 29288000', async () => {
        const actual: number = timeTextToMilliseconds('8h8m8s')

        expect(actual).toEqual(((8 * 60 * 60) + (8 * 60) + 8) * 1000)
      });
    });
    describe('when called with 8h 8m 8s', () => {
      test('then should return 29288000', async () => {
        const actual: number = timeTextToMilliseconds('8h 8m 8s')

        expect(actual).toEqual(((8 * 60 * 60) + (8 * 60) + 8) * 1000)
      });
    });
    describe('when called with undefined', () => {
      test('then should return 0', async () => {
        const actual: number = timeTextToMilliseconds(undefined)

        expect(actual).toEqual(0)
      });
    });
    describe('when called with empty string', () => {
      test('then should return 0', async () => {
        const actual: number = timeTextToMilliseconds('')

        expect(actual).toEqual(0)
      });
    });
    describe('when called with random string', () => {
      test('then should return 0', async () => {
        const actual: number = timeTextToMilliseconds('test value')

        expect(actual).toEqual(0)
      });
    });
  });
})
