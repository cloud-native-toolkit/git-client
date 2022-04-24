import {delete as httpDelete, get, post, put, Response} from 'superagent';

import {
  CreatePullRequestOptions, CreateRepoOptions,
  CreateWebhook, DeleteBranchOptions, GetPullRequestOptions,
  GitApi,
  GitEvent,
  GitHeader,
  MergePullRequestOptions,
  PullRequest,
  UnknownWebhookError, UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {GitHookConfig, GitHookContentType, TypedGitRepoConfig, Webhook} from '../git.model';
import {GitBase} from '../git.base';
import {isResponseError, ResponseError} from '../../util/superagent-support';
import {timer} from '../timer';
import {
  compositeRetryEvaluation,
  EvaluateErrorForRetry,
  retryWithDelay
} from '../../util/retry-with-delay';
import {apiFromConfig} from '../util';
import {Octokit} from '@octokit/core'
import {ThrottledOctokit} from './octokit';

export interface GitHookData {
  name: 'web';
  active: boolean;
  events: GithubEvent[];
  config: GitHookConfig;
}

enum GithubHeader {
  event = 'X-GitHub-Event'
}

enum GithubEvent {
  push = 'push',
  pullRequest = 'pull_request'
}

enum GitHookUrlVerification {
  performed = '0',
  notPerformed = '1'
}

interface Tree {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
  url: string;
}

interface TreeResponse {
  sha: string;
  url: string;
  tree: Tree[];
  truncated?: boolean;
}

interface FileResponse {
  content: string;
  encoding: 'base64';
  url: string;
  sha: string;
  size: number;
  node_id: string;
}

interface RepoResponse {
  default_branch: string;
}

function isSecondaryRateLimitError(err: Error): err is ResponseError {
  const rateLimitRegex = /.*secondary rate limit.*/g;

  return isResponseError(err) && err.status === 403 && rateLimitRegex.test(err.response.text);
}

abstract class GithubCommon extends GitBase implements GitApi {
  octokit: Octokit;

  protected constructor(config: TypedGitRepoConfig) {
    super(config);

    this.octokit = new ThrottledOctokit({
      auth: config.password,
      baseUrl: this.getBaseUrl(),
    })
  }

  abstract getBaseUrl(): string;

  abstract getRepoUri(): string;

  abstract getRepoUrl(): string;

  getRepoApi({repo, url}: {repo?: string, url: string}): GitApi {
    const newConfig = Object.assign({}, this.config, {repo, url})

    return apiFromConfig(newConfig)
  }

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    const response: Response = await this.get(`/git/trees/${this.config.branch}`);

    const treeResponse: TreeResponse = response.body;

    return treeResponse.tree.filter(tree => tree.type === 'blob');
  }

  async getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer> {
    const response: Response = await this.get(fileDescriptor.url || '/contents/' + fileDescriptor.path);

    const fileResponse: FileResponse = response.body;

    return new Buffer(fileResponse.content, fileResponse.encoding);
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await this.get();

    const treeResponse: RepoResponse = response.body;

    return treeResponse.default_branch;
  }

  async exec<T>(f: () => Promise<T>, name: string, {retries = 10, retryHandler, rateLimit = false}: {retries?: number, retryHandler?: EvaluateErrorForRetry, rateLimit?: boolean} = {}): Promise<T> {

    const logger = this.logger.child(name);

    const retryOnSecondaryRateLimit = async (err: any) => {
      if (isSecondaryRateLimitError(err)) {
        const retryAfter = err.response.header['Retry-After'] || (30 + 20 * Math.random());

        logger.log(`Got secondary rate limit error. Waiting ${Math.round(retryAfter)}s before retry.`)
        return {retry: true, delay: retryAfter * 1000};
      } else {
        logger.log(`Error calling api`, {status: err.status, text: err.response?.text, isSecondaryRateLimitError: isSecondaryRateLimitError(err)});
        return {retry: false};
      }
    }

    if (rateLimit) {
      await timer(1000);
    }
    return retryWithDelay(f, name, retries, compositeRetryEvaluation([retryOnSecondaryRateLimit, retryHandler]));
  }

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    return await this.delete(`/git/refs/heads/${branch}`)
      .then(res => 'success')
  }

  async getPullRequest(options: GetPullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {

    const f = async (): Promise<PullRequest> => {
      const response: Response = await this.get(`/pulls/${options.pullNumber}`);

      return {
        pullNumber: response.body.number,
        sourceBranch: response.body.head.ref,
        targetBranch: response.body.base.ref,
      };
    };

    return this.exec(f, 'getPullRequest', {retryHandler, rateLimit: options.rateLimit});
  }

  async createPullRequest(options: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {

    const f = async (): Promise<PullRequest> => {
      const response: Response = await this.post('/pulls', {
        title: options.title,
        head: options.sourceBranch,
        base: options.targetBranch,
        maintainer_can_modify: options.maintainer_can_modify,
        draft: options.draft || false,
      });

      return {
        pullNumber: response.body.number,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
      };
    };

    return this.exec(f, 'createPullRequest', {retryHandler, rateLimit: options.rateLimit});
  }

  async mergePullRequest(options: MergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {

    const f = async (): Promise<string> => {
      const response: Response = await this.put(`/pulls/${options.pullNumber}/merge`, {
        commit_title: options.title,
        commit_message: options.message,
        merge_method: options.method,
      });

      return response.body.message;
    }

    return this.exec(f, 'mergePullRequest', {retryHandler, rateLimit: options.rateLimit});
  }

  async updatePullRequestBranch(options: UpdatePullRequestBranchOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {

    const f = async (): Promise<string> => {
      const response: Response = await this.put(`/pulls/${options.pullNumber}/update-branch`);

      return response.body.message;
    }

    return this.exec(f, 'updatePullRequestBranch', {retryHandler, rateLimit: options.rateLimit});
  }

  async get(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getRepoUrl() + uri;

    return get(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');
  }

  async delete(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getRepoUrl() + uri;

    return httpDelete(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');
  }

  async post(uri: string, data: any): Promise<Response> {
    return post(this.getRepoUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
  }

  async put(uri: string, data: any = {}): Promise<Response> {
    return put(this.getRepoUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
  }

  async createRepo(options: CreateRepoOptions): Promise<GitApi> {
    console.log(`Creating repo: ${this.config.owner}/${options.name}`)

    if (this.config.owner === this.config.username) {
      return this.octokit
        .request('POST /user/repos', {
          name: options.name,
          private: !!options.private
        })
        .then(res => this.getRepoApi({repo: options.name, url: res.url}))
    } else {
      return this.octokit
        .request('POST /orgs/{org}/repos', {
          org: this.config.owner,
          name: options.name,
          private: !!options.private
        })
        .then(res => this.getRepoApi({repo: options.name, url: res.url}))
    }
  }

  async deleteRepo(): Promise<GitApi> {
    return this.octokit
      .request('DELETE /repos/{owner}/{repo}', {
        owner: this.config.owner,
        repo: this.config.repo
      })
      .then(res => {
        const url = this.config.url.replace(new RegExp('(.*)/.*', 'g'), '$1')

        return this.getRepoApi({url})
      })
  }

  async createWebhook(options: CreateWebhook): Promise<string> {

    try {
      const response: Response = await this.post('/hooks', this.buildWebhookData(options));

      return response.body.id;
    } catch (err) {
      if (isResponseError(err)) {
        if (err.response.text.match(/Hook already exists/)) {
          throw new WebhookAlreadyExists('Webhook already exists on repository', err);
        } else {
          throw new UnknownWebhookError('Unknown error creating webhook', err);
        }
      } else {
        throw new UnknownWebhookError(err.message, err);
      }
    }
  }

  async getWebhooks(): Promise<Webhook[]> {
    return this.octokit.request(`GET ${this.getRepoUri()}/hooks`)
      .then(res => res.data) as Promise<any>
  }

  buildWebhookData({jenkinsUrl, webhookUrl}: {jenkinsUrl?: string, webhookUrl?: string}): GitHookData {
    const url: string = webhookUrl ? webhookUrl : `${jenkinsUrl}/github-webhook/`;

    const config: GitHookConfig = {
      url,
      content_type: GitHookContentType.json,
      insecure_ssl: GitHookUrlVerification.performed as any,
    };

    const pushGitHook: GitHookData = {
      name: 'web',
      events: [GithubEvent.push],
      active: true,
      config,
    };

    return pushGitHook;
  }

  getRefPath(): string {
    return 'body.ref';
  }

  getRef(): string {
    return `refs/heads/${this.config.branch}`;
  }

  getRevisionPath(): string {
    return 'body.head_commit.id';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.url';
  }

  getRepositoryNamePath(): string {
    return 'body.repository.full_name';
  }

  getHeader(headerId: GitHeader): string {
    return GithubHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return GithubEvent[eventId];
  }

  getConfig(): TypedGitRepoConfig {
    return this.config
  }
}

export class Github extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `https://api.github.com`;
  }

  getRepoUri(): string {
    return `/repos/${this.config.owner}/${this.config.repo}`;
  }

  getRepoUrl(): string {
    return `${this.getBaseUrl()}${this.getRepoUri()}`;
  }
}

export class GithubEnterprise extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v3`;
  }

  getRepoUri(): string {
    return `/repos/${this.config.owner}/${this.config.repo}`;
  }

  getRepoUrl(): string {
    return `${this.getBaseUrl()}${this.getRepoUri()}`;
  }
}
