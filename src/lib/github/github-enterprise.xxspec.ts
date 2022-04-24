import {GitApi} from '../git.api';
import {apiFromUrl} from '../util';
import {GitHost} from '../git.model';

const skip = process.env.GHE_SKIP
const org = process.env.GHE_ORG
const username = process.env.GHE_USERNAME
const password = process.env.GHE_PASSWORD

const runTest = (): boolean => {
  if (skip === "true") {
    console.log('GHE_SKIP set to true. Skipping test...')
    return false
  }

  if (!(org && username && password)) {
    console.log('GHE_ORG, GHE_USERNAME, and GHE_PASSWORD are not configured in .env. Skipping...')
    return false
  }

  return true
}

function makeId(length: number): string {
  const result           = [];
  const characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let i = 0; i < length; i++) {
    result.push(characters.charAt(Math.floor(Math.random() *
      characters.length)));
  }

  return result.join('');
}

const maybe = runTest() ? describe : describe.skip;

maybe('github-enterprise', () => {
  test('canary verifies test infrastructure', () => {
    expect(true).toBe(true);
  });

  let classUnderTest: GitApi;
  beforeEach(async () => {

    const url = `https://github.ibm.com/${org}`

    classUnderTest = await apiFromUrl(url, {username, password})
  })

  describe('given GitApi', () => {
    test('should be GitHub type', async () => {
      expect(classUnderTest.getType()).toEqual(GitHost.ghe)
    });

    describe('given createRepo()', () => {
      describe('when called with a repo that does not exist' , () => {
        let repo: string;
        beforeEach(() => {
          repo = `test-${makeId(10)}`
        })

        test('then should create the repository', async () => {
          const repoApi: GitApi = await classUnderTest.createRepo({name: repo, private: false})

          const type: GitHost = repoApi.getType()
          expect(type).toEqual(GitHost.ghe)

          // await repoApi.deleteRepo()
          // TODO how to validate?
        });
      });
    })

  })
})
