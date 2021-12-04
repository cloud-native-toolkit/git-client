import {Container} from 'typescript-ioc';

import {
  LocalGitConfig,
  GitApi,
  GitEvent,
  GitHeader,
  WebhookParams,
  CreatePullRequestOptions,
  PullRequest, MergePullRequestOptions, UpdateAndMergePullRequestOptions, GitUserConfig, MergeResolver, SimpleGitWithApi
} from './git.api';
import {GitHost, TypedGitRepoConfig} from './git.model';
import {Logger} from '../util/logger';
import simpleGit, {SimpleGit, SimpleGitOptions, StatusResult} from 'simple-git';
import {timer} from './timer';
import {RetryResult, retryWithDelay} from '../util/retry-with-delay';
import {isResponseError} from '../util/superagent-support';

export abstract class GitBase extends GitApi {
  logger: Logger;

  protected constructor(public config: TypedGitRepoConfig) {
    super();

    this.logger = Container.get(Logger);
  }

  async clone(repoDir: string, input: LocalGitConfig): Promise<SimpleGitWithApi> {
    const gitOptions: Partial<SimpleGitOptions> = this.buildGitOptions(input);

    const git: SimpleGit & {gitApi?: GitApi} = simpleGit(gitOptions);

    // clone into repo dir
    await git.clone(`https://${this.credentials()}@${this.config.host}/${this.config.owner}/${this.config.repo}`, repoDir);

    await git.cwd({path: repoDir, root: true});

    if (input.userConfig) {
      await git.addConfig('user.email', input.userConfig.email, true, 'local');
      await git.addConfig('user.name', input.userConfig.name, true, 'local');
    }

    git.gitApi = this;

    return git as SimpleGitWithApi;
  }

  async rebaseBranch(config: {sourceBranch: string, targetBranch: string, resolver: MergeResolver}, options: {userConfig?: GitUserConfig} = {}): Promise<boolean> {

    const suffix = Math.random().toString(36).replace(/[^a-z0-9]+/g, '').substr(0, 5);
    const repoDir = `/tmp/repo/rebase-${suffix}`;
    const resolver = config.resolver || (() => false);

    const git: SimpleGitWithApi = await this.clone(repoDir, {userConfig: options.userConfig});

    await git.checkoutBranch(config.sourceBranch, `origin/${config.sourceBranch}`);

    // TODO need to loop through all commits
    git.rebase([config.targetBranch]);

    const status: StatusResult = await git.status();
    if (status.staged.length === 0 && status.created.length === 0 && status.deleted.length === 0) {
      return false;
    }

    if (status.conflicted.length > 0) {
      if (!await resolver(git, status.conflicted)) {
        throw new Error('Unable to resolve conflicts: ' + status.conflicted);
      }

      git.add('.');
    }

    git.rebase(['--continue']);
    await git.push('origin', config.sourceBranch, ['--force-with-lease']);

    return true;
  }

  async updateAndMergePullRequest(options: UpdateAndMergePullRequestOptions): Promise<string> {
    const retryCount: number = options.retryCount !== undefined ? options.retryCount : 10;

    const _updateAndMergePullRequest = async (): Promise<string> => {
      if (options.rateLimit) {
        await timer(1000);
      }
      return await this.mergePullRequest(options);
    }

    const baseOutOfDateRegEx = /Base branch was modified/g;
    const pullRequestNotMergableRegEx = /Pull Request is not mergeable/g;
    const mergeConflictRegEx = /merge conflict between base and head/g;
    const retryTest = async (error: Error): Promise<RetryResult> => {
      const delay = 5000 + Math.random() * 5000;

      // if (isResponseError(error) && error.status === 405 && baseOutOfDateRegEx.test(error.response.text)) {
      //
      //   this.logger.log('Base branch was modified. Rebasing branch and trying again.');
      //
      //   const pr: PullRequest = await this.getPullRequest(options.pullNumber);
      //   await this.rebaseBranch(Object.assign({}, pr, {resolver: options.resolver}), {userConfig: options.userConfig});
      //
      //   return {retry: true, delay};
      // } else if (isResponseError(error) && error.status === 405 && pullRequestNotMergableRegEx.test(error.response.text)) {
      //
      //   this.logger.log('Pull request is not mergeable. Rebasing branch and trying again.');
      //
      //   const pr: PullRequest = await this.getPullRequest(options.pullNumber);
      //   await this.rebaseBranch(Object.assign({}, pr, {resolver: options.resolver}), {userConfig: options.userConfig});
      //
      //   return {retry: true, delay};
      // } else if (isResponseError(error) && error.status === 422 && mergeConflictRegEx.test(error.response.text)) {
      //
      //   this.logger.log('Merge conflict between base and head. Rebasing branch and trying again.');
      //
      //   const pr: PullRequest = await this.getPullRequest(options.pullNumber);
      //   await this.rebaseBranch(Object.assign({}, pr, {resolver: options.resolver}), {userConfig: options.userConfig});
      //
      //   return {retry: true, delay};
      // } else if (isResponseError(error) && error.status === 409) {
      //
      //   this.logger.log('Base branch was modified. Rebasing branch and trying again.');
      //
      //   const pr: PullRequest = await this.getPullRequest(options.pullNumber);
      //   await this.rebaseBranch(Object.assign({}, pr, {resolver: options.resolver}), {userConfig: options.userConfig});
      //
      //   return {retry: true, delay};
      // } else {
      //   return {retry: false};
      // }

      return {retry: true, delay};
    }

    return retryWithDelay(_updateAndMergePullRequest, 'updateAndMergePullRequest', retryCount, retryTest);
  }

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
      return `${this.config.username}:${this.config.password}`;
    }

    return this.config.password;
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

