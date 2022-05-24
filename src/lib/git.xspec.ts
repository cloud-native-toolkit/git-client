import {CreateWebhook, GitApi} from './git.api';
import {apiFromUrl} from './util';
import {GitHost, GitRepo, Webhook} from './git.model';

const asKey = (name: string, key: string): string => {
  return `${name}_${key}`.toUpperCase()
}

interface CaseConfig {
  name: string;
  baseUrl: string;
  org: string;
  username: string;
  password: string;
}

const getConfigValues = (name: string): CaseConfig | undefined => {
  const skip = process.env[asKey(name, 'skip')];
  const baseUrl = process.env[asKey(name, 'baseUrl')] || (name === 'github' ? 'https://github.com' : '');
  const org = process.env[asKey(name, 'org')];
  const username = process.env[asKey(name, 'username')];
  const password = process.env[asKey(name, 'password')];

  if (skip === 'true') {
    console.log(`${asKey(name, 'skip')} is set to true. Skipping test...`)
    return
  }

  if (!(baseUrl && org && username && password)) {
    console.log(`${asKey(name, `baseUrl`)}, ${asKey(name, `org`)}, ${asKey(name, `username`)}, and/or ${asKey(name, 'password')} are not configured in .env. Skipping...`)
    return
  }

  return {
    name,
    baseUrl,
    org,
    username,
    password
  }
}


const testConfig: {[name: string]: {baseUrl: string, org: string, username: string, password: string}} = {}
const cases: Array<CaseConfig> = [];

const addTestConfig = (name: string): void => {
  const config: CaseConfig = getConfigValues(name);

  if (!config) {
    return
  }

  cases.push(config)
};

addTestConfig('github');
addTestConfig('ghe');
addTestConfig('gitlab');
addTestConfig('gitea');
addTestConfig('bitbucket');

function makeId(length: number): string {
  const result           = [];
  const characters       = 'abcdefghijklmnopqrstuvwxyz0123456789';

  for (let i = 0; i < length; i++) {
    result.push(characters.charAt(Math.floor(Math.random() *
      characters.length)));
  }

  return result.join('');
}

const describeTestCases = describe.each<CaseConfig>(cases);

describeTestCases('given $name', ({name, baseUrl, org, username, password} : CaseConfig) => {
  test('canary verifies test infrastructure', () => {
    expect(true).toBe(true);
  });

  let classUnderTest: GitApi;
  let repo: string;
  beforeAll(async () => {
    const url = `${baseUrl}/${org}`
    classUnderTest = await apiFromUrl(url, {username, password})

    repo = `test-${makeId(10)}`
  })

  describe('given createRepo()', () => {
    describe('when called', () => {
      test('then should create a repo', async () => {

        let repoApi: GitApi;
        try {
          repoApi = await classUnderTest.createRepo({name: repo, privateRepo: true})

          console.log('Got repo: ', repoApi.getConfig().repo)

          const repoInfo: GitRepo = await repoApi.getRepoInfo()

          expect(repoInfo.name).toEqual(repo)

        } catch (error) {
          console.log('Error: ', error)
          expect(error).toBeUndefined()
        } finally {
          if (repoApi) {
            await repoApi.deleteRepo().catch(err => console.log('Error deleting repo', err));
          }
        }
      }, 30000);
    });
  });
})
