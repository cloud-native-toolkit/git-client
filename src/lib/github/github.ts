import {get, post, put, Response} from 'superagent';

import {
  CreatePullRequestOptions,
  CreateWebhook, GetPullRequestOptions,
  GitApi,
  GitEvent,
  GitHeader,
  MergePullRequestOptions,
  PullRequest,
  UnknownWebhookError, UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {GitHookConfig, GitHookContentType, TypedGitRepoConfig} from '../git.model';
import {GitBase} from '../git.base';
import {isResponseError, ResponseError} from '../../util/superagent-support';
import {timer} from '../timer';
import {
  compositeRetryEvaluation,
  EvaluateErrorForRetry,
  retryWithDelay
} from '../../util/retry-with-delay';

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
  protected constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  abstract getBaseUrl(): string;

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

  async get(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getBaseUrl() + uri;

    return get(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');
  }

  async post(uri: string, data: any): Promise<Response> {
    return post(this.getBaseUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
  }

  async put(uri: string, data: any = {}): Promise<Response> {
    return put(this.getBaseUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
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
}

export class Github extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`;
  }
}

export class GithubEnterprise extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v3/repos/${this.config.owner}/${this.config.repo}`;
  }
}
