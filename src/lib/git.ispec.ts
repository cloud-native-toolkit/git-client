import {promises} from 'fs';
import {SimpleGit} from 'simple-git';
import {dump, load} from 'js-yaml';
import * as fs from 'fs-extra';

import {CreateWebhook, GitApi, MergeResolver, PullRequest, SimpleGitWithApi} from './git.api';
import {apiFromUrl} from './util';
import {GitHost, Webhook} from './git.model';
import {join as pathJoin} from 'path';
import {Container} from 'typescript-ioc';
import {Logger, verboseLoggerFactory} from '../util/logger';
import {isString} from '../util/string-util';
import {isError} from '../util/error-util';

const asKey = (name: string, key: string): string => {
  return `${name}_${key}`.toUpperCase()
}

interface CaseConfig {
  name: string;
  baseUrl: string;
  org: string;
  username: string;
  password: string;
  project?: string;
}

const getConfigValues = (name: string): CaseConfig | undefined => {
  const skip = process.env[asKey(name, 'skip')];
  const baseUrl = process.env[asKey(name, 'baseUrl')] || (name === 'github' ? 'https://github.com' : '');
  const org = process.env[asKey(name, 'org')];
  const username = process.env[asKey(name, 'username')];
  const password = process.env[asKey(name, 'password')];
  const project = process.env[asKey(name, 'project')];

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
    password,
    project
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
addTestConfig('azure');

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

describeTestCases('given $name', ({name, baseUrl, org, username, password, project} : CaseConfig) => {
  test('canary verifies test infrastructure', () => {
    expect(true).toBe(true);
  });

  let classUnderTest: GitApi;
  let repo: string;
  let logger: Logger;
  beforeAll(async () => {
    const url = project ? `${baseUrl}/${org}/${project}` : `${baseUrl}/${org}`
    const gitApi: GitApi = await apiFromUrl(url, {username, password})

    Container.bind(Logger).factory(verboseLoggerFactory(false))
    logger = Container.get(Logger)

    repo = `test-${makeId(10)}`
    logger.debug('Creating repo: ', repo)
    return gitApi.createRepo({name: repo, privateRepo: false, autoInit: true})
      .then((result: GitApi) => {
        logger.debug('Got api:', result.getConfig().url)
        classUnderTest = result
      });
  }, 30000)

  afterAll(async () => {
    if (classUnderTest) {
      logger.debug('Deleting repo: ', classUnderTest.getConfig().url)
      await classUnderTest.deleteRepo();
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

        logger.debug('Webhook created: ' + result)

        const webhooks: Webhook[] = await classUnderTest.getWebhooks();
        expect(webhooks.length).toEqual(1);
      }, 10000);
    });
  });

  describe('given createPullRequest()', () => {
    describe('when called', () => {
      const baseDir = process.cwd()

      afterEach(async () => {
        const repo = classUnderTest.getConfig().repo

        await promises.rm(`${baseDir}/${repo}`, {recursive: true})
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

        logger.debug('Pushing branch: ', branchName)
        await simpleGit.push(`origin`, branchName, ['-u'])

        logger.debug('Creating pull request', branchName)
        const {pullNumber} = await classUnderTest.createPullRequest({
          title: 'test',
          sourceBranch: branchName,
          targetBranch: defaultBranch
        })

        logger.debug('Getting pull request', pullNumber)
        const result: PullRequest = await classUnderTest.getPullRequest({pullNumber})

        expect(result.pullNumber).toEqual(pullNumber)

        logger.debug('Merging pull request', pullNumber)
        await classUnderTest.mergePullRequest({pullNumber, method: 'squash', delete_branch_after_merge: true})
      }, 30000);
    });
  });

  describe('given mergePullRequest()', () => {
    describe('when branches conflict', () => {
      const baseDir = process.cwd()

      afterEach(async () => {
        const repo = classUnderTest.getConfig().repo

        await promises.rm(`${baseDir}/${repo}`, {recursive: true})
      })

      test('then it should apply a resolver function', async () => {

        const createPr = async (filename: string, message: string, content: string): Promise<{branchName: string, pullNumber: number}> => {
          const simpleGit: SimpleGit = await classUnderTest.clone(classUnderTest.getConfig().repo, {baseDir, userConfig: {email: 'test@email.com', name: 'test'}})

          const defaultBranch: string = await simpleGit.revparse(['--abbrev-ref', 'HEAD'])

          const branchName = `test-${makeId(10)}`
          await simpleGit.checkoutBranch(branchName, `origin/${defaultBranch}`)

          const fullFilename = `${baseDir}/${classUnderTest.getConfig().repo}/${filename}`
          await promises.writeFile(fullFilename, content)

          await simpleGit.add(filename)

          await simpleGit.commit(message)

          logger.debug('Pushing branch: ', branchName)
          await simpleGit.push(`origin`, branchName, ['-u'])

          logger.debug('Creating pull request for branch: ', branchName)
          const {pullNumber} = await classUnderTest.createPullRequest({
            title: 'test',
            sourceBranch: branchName,
            targetBranch: defaultBranch
          })

          await promises.rm(`${baseDir}/${repo}`, {recursive: true})

          return {branchName, pullNumber}
        }

        const pr1 = await createPr('kustomization.yaml', `Updates kustomization.yaml - resourceA`, dump({resources: ['resourceA']}))
        const pr2 = await createPr('kustomization.yaml', `Updates kustomization.yaml - resourceB`, dump({resources: ['resourceB']}))

        logger.debug('Merging first pull request: ', pr1)
        await classUnderTest.updateAndMergePullRequest({pullNumber: pr1.pullNumber, method: 'squash', delete_branch_after_merge: true, resolver: argocdResolver('resourceA')})

        logger.debug('Merging second pull request: ', pr2)
        await classUnderTest.updateAndMergePullRequest({pullNumber: pr2.pullNumber, method: 'squash', delete_branch_after_merge: true, resolver: argocdResolver('resourceB')})

        await classUnderTest.clone(classUnderTest.getConfig().repo, {baseDir, userConfig: {email: 'test@email.com', name: 'test'}})

        const fileContent: any = await promises
          .readFile(`${baseDir}/${classUnderTest.getConfig().repo}/kustomization.yaml`)
          .then((content: Buffer) => load(content.toString()))

        expect(fileContent.resources).toEqual(['resourceA', 'resourceB'])
      }, 3600000);
    });
  });
})


const argocdResolver = (applicationPath: string): MergeResolver => {
  return async (git: SimpleGitWithApi, conflicts: string[]): Promise<{resolvedConflicts: string[], conflictErrors: Error[]}> => {
    const kustomizeYamls: string[] = conflicts.filter(f => /.*kustomization.yaml/.test(f));

    const logger: Logger = Container.get(Logger)
    logger.debug('Inside argocd resolver', conflicts)

    const processKustomizeYaml = async (kustomizeYaml: string) => {
      // get the file version that is in master
      await git.raw(['checkout', '--ours', kustomizeYaml]);

      // reapply our change on top
      await addKustomizeResource(pathJoin(git.repoDir, kustomizeYaml), applicationPath);

      return kustomizeYaml;
    }

    const result: Array<string | Error> = []
    for (let i = 0; i < kustomizeYamls.length; i++) {
      result.push(await processKustomizeYaml(kustomizeYamls[i]).catch(err => err))
    }

    const resolvedConflicts: string[] = result.filter(isString);
    const conflictErrors: Error[] = result.filter(isError);

    return {resolvedConflicts, conflictErrors};
  }
}

export interface IKustomization {
  resources: string[];
}

export class Kustomization implements IKustomization {
  config: IKustomization;
  resources: string[];
  logger: Logger;

  constructor(config?: IKustomization) {
    Object.assign(
      this as any,
      config && config.resources ? config : {resources: []},
      config ? {config} : {config: {apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization'}}
    );

    this.logger = Container.get(Logger)
  }

  addResource(resource: string): Kustomization {
    if (!this.containsResource(resource)) {
      this.resources.push(resource);
      this.resources.sort()
    } else {
      this.logger.debug('Already contains resource', resource)
    }

    return this;
  }

  removeResource(resource: string): Kustomization {
    if (this.containsResource(resource)) {
      const index = this.resources.indexOf(resource);

      this.resources.splice(index, 1);
      this.resources.sort();
    }

    return this;
  }

  containsResource(resource: string): boolean {
    return this.resources.includes(resource);
  }

  asJson() {
    const resource = Object.assign(
      {},
      this.config,
      {
        resources: this.resources
      }
    );

    return resource;
  }

  asJsonString(): string {
    return JSON.stringify(this.asJson());
  }

  asYamlString(): string {
    return dump(this.asJson());
  }
}

export function isFile(file: File | string): file is File {
  return !!file && !!(file as File).exists && !!(file as File).read && !!(file as File).write;
}

export class File {
  constructor(public filename: string) {}

  async exists(): Promise<boolean> {
    return fileExists(this.filename);
  }

  async read(): Promise<string | Buffer> {
    return fs.readFile(this.filename);
  }

  async readYaml<T = any>(): Promise<T> {
    const content = await this.read();

    return load(content.toString()) as T;
  }

  async readJson<T = any>(): Promise<T> {
    const content = await this.read();

    return JSON.parse(content.toString());
  }

  async write(contents: string): Promise<boolean> {
    return fs.writeFile(this.filename, contents).then(v => true).catch(err => false);
  }

  async contains(contents: string): Promise<boolean> {
    return fileContains(this.filename, contents);
  }

  async delete(): Promise<void> {
    return fs.remove(this.filename);
  }
}

export const fileContains = async (path: string, contents: string): Promise<boolean> => {
  const result: string = await fs.readFile(path).then(v => v.toString()).catch(err => '##error reading file##');

  return result === contents;
}

export const fileExists = async (path: string): Promise<boolean> => {
  return await fs.access(path, fs.constants.R_OK).then(v => true).catch(err => false);
}

export const addKustomizeResource = async (kustomizeFile: string | File, path: string): Promise<boolean> => {

  const logger: Logger = Container.get(Logger)

  const file: File = isFile(kustomizeFile) ? kustomizeFile : new File(kustomizeFile);

  logger.debug('Loading kustomize file', kustomizeFile)

  const kustomize: Kustomization = await loadKustomize(kustomizeFile);

  logger.debug('kustomize resources before', kustomize.resources)

  if (kustomize.containsResource(path)) {
    logger.debug('Already contains resource', path)
    return false;
  }

  kustomize.addResource(path);

  logger.debug('kustomize resources after', {resources: kustomize.resources, yaml: kustomize.asYamlString()})

  return file.write(kustomize.asYamlString()).then(writeResult => {
    logger.debug('Write result: ', {writeResult, filename: file.filename})
    return true
  });
};

export const loadKustomize = async (kustomizeFile: File | string): Promise<Kustomization> => {

  const logger: Logger = Container.get(Logger)

  const file: File = isFile(kustomizeFile) ? kustomizeFile : new File(kustomizeFile);

  logger.debug(`Loading kustomize file: ${file.filename}`)

  if (!await file.exists()) {
    logger.debug(`Kustomize file does not exist: ${file.filename}`)
    return new Kustomization();
  }

  const kustomize: IKustomization = await file.readYaml();

  return new Kustomization(kustomize);
}
