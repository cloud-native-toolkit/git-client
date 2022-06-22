import {delete as httpDelete, get, post, put, Response} from 'superagent';

import {
  CreatePullRequestOptions, CreateRepoOptions,
  CreateWebhook, DeleteBranchOptions, GetPullRequestOptions,
  GitApi, GitBranch,
  GitEvent,
  GitHeader, MergeConflict,
  MergePullRequestOptions,
  PullRequest,
  UnknownWebhookError, UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {
  BadCredentials,
  GitHookConfig,
  GitHookContentType, GitRepo,
  InsufficientPermissions, RepoNotFound,
  TypedGitRepoConfig,
  Webhook
} from '../git.model';
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
    return this.octokit.request(
      'DELETE /repos/{owner}/{repo}/git/refs/{ref}',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        ref: `heads/${branch}`
      })
      .then(res => 'success')
    // return await this.delete(`/git/refs/heads/${branch}`)
    //   .then(res => 'success')
  }

  async getPullRequest(options: GetPullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {
    return this.octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        pull_number: options.pullNumber
      })
      .then(res => ({
        pullNumber: res.data.number,
        sourceBranch: res.data.head.ref,
        targetBranch: res.data.base.ref
      }))
  }

  async createPullRequest({title, sourceBranch, targetBranch, maintainer_can_modify, draft = false, rateLimit}: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {

    return this.octokit.request(
      'POST /repos/{owner}/{repo}/pulls',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        title,
        head: sourceBranch,
        base: targetBranch,
        maintainer_can_modify,
        draft
      })
      .then(res => ({
        pullNumber: res.data.number,
        sourceBranch,
        targetBranch
      }))
  }

  async mergePullRequestInternal({pullNumber, title, message, method, rateLimit, delete_branch_after_merge = false}: MergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {
    const deleteBranch = !delete_branch_after_merge ? async () => undefined : async () => {
      const {sourceBranch} = await this.getPullRequest({pullNumber}).catch(() => ({sourceBranch: ''}));

      if (sourceBranch) {
        await this.deleteBranch({branch: sourceBranch}).catch(() => console.log('Unable to delete branch: ' + sourceBranch))
      }
    }

    const result: string = await this.octokit.request(
      'PUT /repos/{owner}/{repo}/pulls/{pullNumber}/merge',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        pullNumber,
        commit_title: title,
        commit_message: message,
        merge_method: method
      })
      .then(async res => {
        console.log('Merge complete!!')
        await deleteBranch()

        console.log('Delete complete')

        return res.data.message
      })
      .catch(err => {
        if (err.response.status === 405) {
          console.log('Merge conflict: ', err)
          throw new MergeConflict(pullNumber)
        } else {
          throw err
        }
      })

    console.log('Merge complete')

    return result;
  }

  async updatePullRequestBranch({pullNumber}: UpdatePullRequestBranchOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {
    return this.octokit.request(
      'PUT /repos/{owner}/{repo}/pulls/{pullNumber}/update-branch',
      {
        owner: this.config.owner,
        repo: this.config.repo,
        pullNumber
      })
      .then(res => res.data.message)
  }

  async getBranches(): Promise<GitBranch[]> {
    return this.octokit.request(
      'GET /repos/{owner}/{repo}/branches',
      {
        owner: this.config.owner,
        repo: this.config.repo
      })
      .then(res => res.data)
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

  async createRepo({name, privateRepo = false, autoInit = true}: CreateRepoOptions): Promise<GitApi> {
    const errorHandler = (err) => {
      if (/Bad credentials/.test(err.message)) {
        throw new BadCredentials('createRepo', this.config.type, err)
      } else {
        throw err;
      }
    }

    if (this.personalOrg) {
      return this.octokit
        .request('POST /user/repos', {
          name: name,
          auto_init: autoInit,
          private: !!privateRepo
        })
        .then(res => this.getRepoApi({repo: name, url: res.data.clone_url}))
        .catch(errorHandler)
    } else {
      return this.octokit
        .request('POST /orgs/{org}/repos', {
          org: this.config.owner,
          name: name,
          auto_init: autoInit,
          private: !!privateRepo
        })
        .then(res => this.getRepoApi({repo: name, url: res.data.clone_url}))
        .catch(errorHandler)
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
      .catch(err => {
        if (/Must have admin rights to Repository/.test(err.message)) {
          throw new InsufficientPermissions('deleteRepo', this.config.type, err)
        } else if (/Bad credentials/.test(err.message)) {
          throw new BadCredentials('deleteRepo', this.config.type, err)
        } else {
          throw err;
        }
      })
  }

  async getRepoInfo(): Promise<GitRepo> {
    return this.octokit
      .request('GET /repos/{owner}/{repo}', {
        owner: this.config.owner,
        repo: this.config.repo
      })
      .then((res: any) => {
        return ({
          id: res.data.id,
          slug: res.data.full_name,
          name: res.data.name,
          description: res.data.description,
          is_private: res.data.private
        })
      })
      .catch(err => {
        if (err.response.status === 404) {
          throw new RepoNotFound(this.config.url)
        }

        throw err
      })
  }

  async createWebhook(options: CreateWebhook): Promise<string> {

    try {
      return await this.octokit.request(
        'POST /repos/{owner}/{repo}/hooks',
          Object.assign({}, {owner: this.config.owner, repo: this.config.repo}, this.buildWebhookData(options)) as any
        )
        .then(res => 'test')
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

  async listRepos(): Promise<string[]> {
    if (this.personalOrg) {
      return this.octokit
        .request(
          'GET /users/{username}/repos',
          {
            username: this.username
          }
        )
        .then(res => res.data.map(repo => repo.html_url))
        .catch(err => {
          if (/Bad credentials/.test(err.message)) {
            throw new BadCredentials('listRepos', this.config.type, err)
          } else {
            throw err
          }
        })
    } else {
      return this.octokit
        .request(
          'GET /orgs/{org}/repos',
          {
            org: this.owner
          }
        )
        .then(res => res.data.map(repo => repo.html_url))
        .catch(err => {
          if (/Bad credentials/.test(err.message)) {
            throw new BadCredentials('listRepos', this.config.type, err)
          } else {
            throw err
          }
        })
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
