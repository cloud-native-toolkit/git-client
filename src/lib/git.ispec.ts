import {promises} from 'fs';
import {SimpleGit} from 'simple-git';

import {CreateWebhook, GitApi, PullRequest} from './git.api';
import {apiFromUrl} from './util';
import {GitHost, Webhook} from './git.model';

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
    const gitApi: GitApi = await apiFromUrl(url, {username, password})

    repo = `test-${makeId(10)}`
    console.log('Creating repo: ', repo)
    return gitApi.createRepo({name: repo, privateRepo: false, autoInit: true})
      .then((result: GitApi) => {
        console.log('Got api:', result.getConfig().url)
        classUnderTest = result
      });
  }, 30000)

  afterAll(async () => {
    if (classUnderTest) {
      console.log('Deleting repo: ', classUnderTest.getConfig().url)
      // await classUnderTest.deleteRepo();
    }
  })

  test(`should be ${name} type`, async () => {
    expect(classUnderTest.getType()).toEqual(GitHost[name])
  });

  describe('given createWebhook()', () => {
    describe('when called', () => {
      test('then should create a webhook in the repo', async () => {
        const createWebhookParams: CreateWebhook = {
          webhookUrl: 'https://test.com/webhook'
        }

        const result = await classUnderTest.createWebhook(createWebhookParams)

        console.log('Webhook created')

        const webhooks: Webhook[] = await classUnderTest.getWebhooks();
        expect(webhooks.length).toEqual(1);
      });
    });
  });

  describe('given createPullRequest()', () => {
    describe('when called', () => {
      const baseDir = process.cwd()

      afterEach(async () => {
        const repo = classUnderTest.getConfig().repo

        await promises.rmdir(`${baseDir}/${repo}`, {recursive: true})
      })

      test('then create the pr', async () => {
        const simpleGit: SimpleGit = await classUnderTest.clone(classUnderTest.getConfig().repo, {baseDir, userConfig: {email: 'test@email.com', name: 'test'}})

        const defaultBranch: string = await simpleGit.revparse(['--abbrev-ref', 'HEAD'])

        const branchName = `test-${makeId(8)}`
        await simpleGit.checkoutBranch(branchName, `origin/${defaultBranch}`)

        const filename = `${baseDir}/${classUnderTest.getConfig().repo}/README.md`
        await promises.appendFile(filename, '\ntest')

        await simpleGit.add('README.md')

        await simpleGit.commit('Updates readme')

        console.log('Pushing branch: ', branchName)
        await simpleGit.push(`origin`, branchName, ['-u'])

        console.log('Creating pull request', branchName)
        const {pullNumber} = await classUnderTest.createPullRequest({
          title: 'test',
          sourceBranch: branchName,
          targetBranch: defaultBranch
        })

        console.log('Getting pull request', pullNumber)
        const result: PullRequest = await classUnderTest.getPullRequest({pullNumber})

        expect(result.pullNumber).toEqual(pullNumber)

        console.log('Merging pull request', pullNumber)
        await classUnderTest.mergePullRequest({pullNumber, method: 'squash', delete_branch_after_merge: true})
      }, 30000);
    });
  });
})
