import {parseGitUrl} from './util';

describe('util', () => {
  describe('given parseGitUrl()', () => {
    describe('when url is https', () => {
      const protocol = 'https';
      const host = 'host';
      const owner = 'owner';

      test('then return repo config', async () => {
        const repo = 'repo';
        const url = `${protocol}://${host}/${owner}/${repo}`;

        expect(parseGitUrl(url)).toEqual({
          protocol,
          host,
          owner,
          repo,
          url: url + '.git',
        });
      });

      describe('and when url just contains the org', () => {
        test('then return repo config', async () => {
          const repo = null;
          const url = `${protocol}://${host}/${owner}`;

          expect(parseGitUrl(url)).toEqual({
            protocol,
            host,
            owner,
            url: url,
          });
        });
      })
    });
    describe('when url has a branch', () => {
      const protocol = 'https';
      const host = 'host';
      const owner = 'owner';
      const repo = 'repo';
      const branch = 'branch';
      const url = `${protocol}://${host}/${owner}/${repo}`;

      test('then return repo config', async () => {
        expect(parseGitUrl(url + '#' + branch)).toEqual({
          protocol,
          host,
          owner,
          repo,
          url: url + '.git',
          branch,
        });
      });
    });
    describe('when url has a username and password', () => {
      const protocol = 'https';
      const host = 'host';
      const owner = 'owner';
      const repo = 'repo';
      const username = 'username';
      const password = 'password';
      const url = `${protocol}://${username}:${password}@${host}/${owner}/${repo}`;

      test('then return repo config', async () => {
        expect(parseGitUrl(url)).toEqual({
          protocol,
          host,
          owner,
          repo,
          url: `${protocol}://${host}/${owner}/${repo}.git`,
          username,
          password,
        });
      });
    });
    describe('when url has just a username', () => {
      const protocol = 'https';
      const host = 'host';
      const owner = 'owner';
      const repo = 'repo';
      const username = 'username';
      const url = `${protocol}://${username}@${host}/${owner}/${repo}`;

      test('then return repo config', async () => {
        expect(parseGitUrl(url)).toEqual({
          protocol,
          host,
          owner,
          repo,
          url: `${protocol}://${host}/${owner}/${repo}.git`,
          username,
        });
      });
    });
  });
});
