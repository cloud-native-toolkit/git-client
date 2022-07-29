import {promises, readFileSync} from 'fs';
import {Optional} from 'optional-typescript';
import simpleGit, {BranchSummary, SimpleGit, SimpleGitOptions, StatusResult} from 'simple-git';
import {Container} from 'typescript-ioc';

import {
  ConflictErrors,
  GitApi,
  GitEvent,
  GitHeader,
  GitUserConfig,
  isMergeConflict,
  LocalGitConfig,
  MergePullRequestOptions,
  MergeResolver,
  PullRequest,
  PullRequestStatus,
  SimpleGitWithApi,
  UnresolvedConflictsError,
  UpdateAndMergePullRequestOptions,
  WebhookParams
} from './git.api';
import {GitHost, MergeBlockedForPullRequest, TypedGitRepoConfig} from './git.model';
import sleep from '../util/sleep';
import first from '../util/first';
import {isResponseError, ResponseError} from '../util/superagent-support';
import {Logger} from '../util/logger';
import {compositeRetryEvaluation, EvaluateErrorForRetry, noRetry, RetryResult} from '../util/retry-with-delay';
import {minutesInMilliseconds, timeTextToMilliseconds} from '../util/string-util';

export function isMergeError(error: Error): error is ResponseError {

  const logger: Logger = this.logger || Container.get(Logger);

  const baseOutOfDateRegEx = /Base branch was modified/g;
  const pullRequestNotMergableRegEx = /Pull Request is not mergeable/g;
  const mergeConflictRegEx = /merge conflict between base and head/g;

  if (isResponseError(error) && error.status === 405 && baseOutOfDateRegEx.test(error.response.text)) {

    logger.log(`Base branch was modified.`);

    return true;
  } else if (isResponseError(error) && error.status === 405 && pullRequestNotMergableRegEx.test(error.response.text)) {

    logger.log(`Pull request is not mergeable.`);

    return true;
  } else if (isResponseError(error) && error.status === 422 && mergeConflictRegEx.test(error.response.text)) {

    logger.log(`Merge conflict between base and head.`);

    return true;
  } else if (isResponseError(error) && error.status === 409) {

    logger.log(`Base branch was modified.`);

    return true;
  }

  return false;
}

const stripGitFromUrl = (url: string): string => {
  return url.replace(/[.]git$/, '')
}

const urlWithCredentials = (url: string, credentials: string): string => {
  if (!credentials) {
    return stripGitFromUrl(url)
  }

  const urlWithCredentials = new RegExp('(.*://).+@(.*)')
  const basicUrl = new RegExp('(.*://)(.*)')

  const result: Optional<string> = first(
    [urlWithCredentials, basicUrl]
      .filter(regex => regex.test(url))
      .map(regex => {
        const result = regex.exec(url)

        return `${result[1]}${credentials}@${result[2]}`
      })
  )

  return stripGitFromUrl(result.valueOr(url))
}

export abstract class GitBase<T extends TypedGitRepoConfig = TypedGitRepoConfig> extends GitApi<T> {
  logger: Logger;

  protected constructor(public config: T) {
    super();

    this.logger = Container.get(Logger);
  }

  getConfig(): T {
    return Object.assign({}, this.config)
  }

  get repo() {
    return this.config.repo
  }

  get host() {
    return this.config.host
  }

  get url() {
    return this.config.url
  }

  get owner() {
    return this.config.owner
  }

  get username() {
    return this.config.username
  }

  get password() {
    return this.config.password
  }

  get branch() {
    return this.config.branch
  }

  get caCert(): {cert: string, certFile: string} | undefined {
    return this.config.caCert
  }

  get personalOrg() {
    return !this.owner || ((this.owner || "").toLocaleLowerCase() === (this.username || "").toLocaleLowerCase())
  }

  getRepoApi({repo, url}: { repo?: string, url: string }): GitApi {
    const newConfig = Object.assign({}, this.config, {repo, url})

    return new (Object.getPrototypeOf(this).constructor)(newConfig)
  }

  async clone(repoDir: string, input: LocalGitConfig): Promise<SimpleGitWithApi> {
    const gitOptions: Partial<SimpleGitOptions> = this.buildGitOptions(input);

    const git: SimpleGit & {gitApi?: GitApi, repoDir?: string} = simpleGit(gitOptions);

    const url = urlWithCredentials(this.config.url, this.credentials())

    await git.clone(url, repoDir);

    await git.cwd({path: repoDir, root: true});

    const branches: BranchSummary = (await git.branch() as any);
    await git.pull('origin', branches.current);

    await addGitConfig(git, input)

    git.gitApi = this;
    git.repoDir = repoDir;

    return git as SimpleGitWithApi;
  }

  async rebaseBranch(config: {sourceBranch: string, targetBranch: string, resolver?: MergeResolver}, options: {userConfig?: GitUserConfig} = {}): Promise<boolean> {

    const suffix = Math.random().toString(36).replace(/[^a-z0-9]+/g, '').substr(0, 5);
    const repoDir = `/tmp/repo/${config.sourceBranch}/rebase-${suffix}`;
    const resolver: MergeResolver = config.resolver || (() => Promise.resolve({resolvedConflicts: []}));

    try {
      this.logger.debug(`Cloning ${this.url} repo into ${repoDir}`)

      const git: SimpleGitWithApi = await this.clone(repoDir, {userConfig: getUserConfig(options.userConfig)});

      this.logger.debug(`Checking out branch - ${config.sourceBranch}`);

      await git.checkoutBranch(config.sourceBranch, `origin/${config.sourceBranch}`);

      this.logger.debug(`Rebasing ${config.sourceBranch} branch on ${config.targetBranch}`);

      try {
        await git.rebase([config.targetBranch]);
      } catch (err) {
        this.logger.debug('Error during rebase', err);
      }

      let status: StatusResult;
      do {
        status = await (git.status() as Promise<StatusResult>);
        this.logger.debug(`Status after rebase:`, {status});

        if (status.not_added.length === 0 && status.deleted.length === 0 && status.conflicted.length === 0 && status.staged.length === 0) {
          break;
        }

        if (status.conflicted.length > 0) {
          this.logger.debug('  Resolving rebase conflicts');

          try {
            const {resolvedConflicts, conflictErrors} = await resolver(git, status.conflicted);
            if (conflictErrors && conflictErrors.length > 0) {
              this.logger.debug('  Errors resolving conflicts:', conflictErrors);
              throw new ConflictErrors(conflictErrors);
            }

            const unresolvedConflicts: string[] = status.conflicted.filter(conflict => !resolvedConflicts.includes(conflict));
            if (unresolvedConflicts.length > 0) {
              this.logger.debug('  Unresolved conflicts:', unresolvedConflicts);
              throw new UnresolvedConflictsError(unresolvedConflicts);
            }

            this.logger.debug('Adding resolved conflicts after rebase: ', resolvedConflicts);
            await Promise.all(resolvedConflicts.map(async (file: string) => {
              await git.add(file)
              await git.commit(`Resolves conflict with ${file}`)
              return file
            }));
          } catch (error) {
            this.logger.error('Error resolving conflicts', {error});
          }
        }

        this.logger.debug('Continuing rebase');
        const rebaseResult: string = await (git.rebase(['--continue']) as Promise<string>);
        if (/No changes - did you forget to use 'git add'/.test(rebaseResult)) {
          this.logger.debug('No changes after rebase. Skipping commit.')
          await git.rebase(['--skip'])
        }
      } while (true);

      if (status.ahead === 0 && status.behind === 0) {
        this.logger.debug('No changes resulted from rebase.')
        return false;
      }

      this.logger.debug(`Pushing changes to ${config.sourceBranch} force-with-lease`)
      await git.push('origin', config.sourceBranch, ['--force-with-lease']);

    } finally {
      await promises.rm(repoDir, {recursive: true, force: true}).catch(ignoreError => ignoreError)
    }

    return true;
  }

  async updateAndMergePullRequest(options: UpdateAndMergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {
    const logger = this.logger.child('updateAndMergePullRequest');
    const _isMergeError: (error: Error) => error is ResponseError = isMergeError.bind({logger});

    const mergeConflictHandler = async (error: Error): Promise<RetryResult> => {

      if (_isMergeError(error) || isMergeConflict(error)) {
        const delay = 1000 + Math.random() * 5000;

        logger.debug('Rebasing branch and trying again.')

        const pr: PullRequest = await this.getPullRequest(options);
        const retry: boolean = await this.rebaseBranch(Object.assign({}, pr, {resolver: options.resolver}), {userConfig: options.userConfig});

        return {retry, delay};
      } else {
        logger.debug(`Error shouldn't be retried. ${error.message}/${isResponseError(error) ? error.status : '???'}/${isResponseError(error) ? error.response?.text : '?'}`);

        return {retry: false};
      }
    }

    return await this.mergePullRequest(
      options,
      compositeRetryEvaluation([mergeConflictHandler, retryHandler])
    );
  }

  async mergePullRequest(options: MergePullRequestOptions, retryHandler: EvaluateErrorForRetry = noRetry): Promise<string> {
    const waitInMilliseconds: number = timeTextToMilliseconds(options.waitForBlocked)

    let totalWaitTime: number = 0
    return new Promise<string>(async (resolve, reject) => {
      while (true) {
        try {
          this.logger.debug('Merging pull request: ', options)

          const pr: PullRequest = await this.getPullRequest(options)
          if (pr.status === PullRequestStatus.Conflicts) {
            await this.rebaseBranch(Object.assign({}, pr, {resolver: options.resolver}), {userConfig: options.userConfig})
            continue
          }

          if (pr.status === PullRequestStatus.Blocked && totalWaitTime < waitInMilliseconds) {
            const waitMinutes = 5;
            this.logger.debug(`  Pull request is blocked. Waiting ${waitMinutes} minutes`)

            totalWaitTime += minutesInMilliseconds(waitMinutes)
            await sleep(minutesInMilliseconds(waitMinutes))

            continue
          } else if (pr.status === PullRequestStatus.Blocked) {
            throw new MergeBlockedForPullRequest('updateAndMergePullRequest', this.getType(), options.pullNumber + '')
          }

          const result = await this.mergePullRequestInternal(options)

          resolve(result)
          break
        } catch (err) {
          const {retry, delay} = await retryHandler(err)

          this.logger.debug('Retry handler complete: ', {retry, delay})

          if (retry && delay) {
            this.logger.debug('Sleeping: ', delay)
            await sleep(delay)
            this.logger.debug('Done sleeping: ', delay)
          } else if (!retry) {
            reject(err)
            break
          }
        }
      }
    })
  }

  abstract mergePullRequestInternal(options: MergePullRequestOptions): Promise<string>;

  private buildGitOptions(input: LocalGitConfig): Partial<SimpleGitOptions> {
    return Object
      .keys(input)
      .reduce((result: Partial<SimpleGitOptions>, currentKey: keyof LocalGitConfig) => {

        if (currentKey === 'config') {
          result.config = Object.keys(input.config).map(key => `${key}=${input.config[key]}`);
        } else if (currentKey !== 'userConfig') {
          result[currentKey] = input[currentKey];
        }

        return result;
      }, {});
  }

  credentials(): string {
    if (this.config.username) {
      return `${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password)}`;
    }

    return encodeURIComponent(this.config.password);
  }

  getType(): GitHost {
    return this.config.type;
  }

  buildWebhookParams(eventId: GitEvent): WebhookParams {
    return {
      revisionPath: this.getRevisionPath(),
      repositoryUrlPath: this.getRepositoryUrlPath(),
      headerName: this.getHeader(GitHeader.EVENT),
      eventName: this.getEventName(eventId),
      branchName: this.config.branch,
      repositoryNamePath: 'body.repository.full_name',
      repositoryName: `${this.config.owner}/${this.config.repo}`,
      refPath: this.getRefPath(),
      ref: this.getRef(),
    }
  }

  abstract getRefPath(): string;

  abstract getRef(): string;

  abstract getRevisionPath(): string;

  abstract getRepositoryUrlPath(): string;

  abstract getRepositoryNamePath(): string;

  abstract getHeader(headerId: GitHeader): string;

  abstract getEventName(eventId: GitEvent): string;
}

const getUserConfig = (userConfig?: GitUserConfig): GitUserConfig => {
  if (userConfig && userConfig.name && userConfig.email) {
    return userConfig
  }

  return {
    name: 'Cloud-Native Toolkit',
    email: 'cloudnativetoolkit@gmail.com'
  }
}

const SSL_CA_INFO = 'http.sslCAInfo'

const addGitConfig = async (git: SimpleGit, {userConfig, config}: LocalGitConfig) => {

  if (userConfig) {
    await git.addConfig('user.email', userConfig.email, true, 'local');
    await git.addConfig('user.name', userConfig.name, true, 'local');
  }

  if (Object.keys(config).includes(SSL_CA_INFO)) {
    await git.addConfig(SSL_CA_INFO, config[SSL_CA_INFO], true, 'local')
  }

}
