import {delete as httpDelete, get, post, put, Response} from 'superagent';

import {
  CreatePullRequestOptions,
  CreateRepoOptions,
  CreateWebhook,
  DeleteBranchOptions,
  GetPullRequestOptions,
  GitApi,
  GitBranch,
  GitEvent,
  GitHeader,
  MergeConflict,
  MergePullRequestOptions,
  PullRequest,
  PullRequestStatus,
  UnknownWebhookError,
  UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {
  BadCredentials,
  GitHookConfig,
  GitHookContentType,
  GitRepo,
  InsufficientPermissions, MergeBlockedForPullRequest,
  NoCommitsForPullRequest,
  RepoNotFound,
  TypedGitRepoConfig,
  Webhook
} from '../git.model';
import {GitBase} from '../git.base';
import {applyCert, isResponseError, ResponseError} from '../../util/superagent-support';
import {timer} from '../timer';
import {compositeRetryEvaluation, EvaluateErrorForRetry, retryWithDelay} from '../../util/retry-with-delay';
import {Octokit} from '@octokit/core'
import {ThrottledOctokit} from './octokit';
import {Logger} from '../../util/logger';
import {Container} from 'typescript-ioc';

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
      .then(res => {
        this.logger.debug('Pull request: ', {data: res.data})

        const result: PullRequest = ({
          pullNumber: res.data.number,
          status: mapPullRequestStatus(res.data),
          sourceBranch: res.data.head.ref,
          targetBranch: res.data.base.ref
        })

        return result
      })
  }

  async createPullRequest(options: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {
    const title = options.title;
    const sourceBranch = options.sourceBranch;
    const targetBranch = options.targetBranch;
    const maintainer_can_modify = options.maintainer_can_modify;
    const draft = options.draft || false;

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
        status: mapPullRequestStatus(res.data),
        sourceBranch,
        targetBranch
      }))
      .catch(err => {
        if (/No commits between/.test(err.message)) {
          throw new NoCommitsForPullRequest('create', this.getType(), sourceBranch, targetBranch, err)
        } else {
          throw err
        }
      }) as Promise<PullRequest>
  }

  async mergePullRequestInternal(options: MergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {

    const logger: Logger = Container.get(Logger)

    const pullNumber = options.pullNumber
    const title = options.title
    const message = options.message
    const method = options. method
    const delete_branch_after_merge = options.delete_branch_after_merge || false

    const deleteBranch = !delete_branch_after_merge ? async () => undefined : async () => {
      const {sourceBranch} = await this.getPullRequest({pullNumber}).catch(() => ({sourceBranch: ''}));

      if (sourceBranch) {
        await this.deleteBranch({branch: sourceBranch}).catch(() => console.log('Unable to delete branch: ' + sourceBranch))
      }
    }

    logger.debug('Merging pull request: ', pullNumber)

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
        logger.debug('Merge complete!!')
        await deleteBranch()

        logger.debug('Delete complete')

        return res.data.message
      })
      .catch(err => {
        if (err.response.status === 405) {
          if (/approving review is required/.test(err.message)) {
            throw new MergeBlockedForPullRequest('mergePullRequest', this.getType(), pullNumber + '', err)
          } else {
            throw new MergeConflict(pullNumber)
          }
        } else {
          throw err
        }
      })

    logger.debug('Merge complete')

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
      .then(res => res.data.message) as Promise<string>
  }

  async getBranches(): Promise<GitBranch[]> {
    return this.octokit.request(
      'GET /repos/{owner}/{repo}/branches',
      {
        owner: this.config.owner,
        repo: this.config.repo
      })
      .then(res => res.data) as Promise<GitBranch[]>
  }

  async get(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getRepoUrl() + uri;

    const req = get(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');

    return applyCert(req, this.caCert)
  }

  async delete(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getRepoUrl() + uri;

    const req = httpDelete(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');

    return applyCert(req, this.caCert)
  }

  async post(uri: string, data: any): Promise<Response> {
    const req = post(this.getRepoUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);

    return applyCert(req, this.caCert)
  }

  async put(uri: string, data: any = {}): Promise<Response> {
    const req = put(this.getRepoUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);

    return applyCert(req, this.caCert)
  }

  async createRepo(options: CreateRepoOptions): Promise<GitApi> {
    const name = options.name
    const privateRepo = options.privateRepo || false
    const autoInit = options.autoInit || true

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
        .catch(errorHandler) as Promise<GitApi>
    } else {
      return this.octokit
        .request('POST /orgs/{org}/repos', {
          org: this.config.owner,
          name: name,
          auto_init: autoInit,
          private: !!privateRepo
        })
        .then(res => this.getRepoApi({repo: name, url: res.data.clone_url}))
        .catch(errorHandler) as Promise<GitApi>
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
      }) as Promise<GitApi>
  }

  async getRepoInfo(): Promise<GitRepo> {
    return this.octokit
      .request('GET /repos/{owner}/{repo}', {
        owner: this.config.owner,
        repo: this.config.repo
      })
      .then((res: any) => {
        const gitRepo: GitRepo = {
          id: res.data.id,
          slug: res.data.full_name,
          http_url: res.data.clone_url,
          name: res.data.name,
          description: res.data.description,
          is_private: res.data.private,
          default_branch: res.data.default_branch
        }

        return gitRepo
      })
      .catch(err => {
        if (err.response.status === 404) {
          throw new RepoNotFound(this.config.url)
        }

        throw err
      }) as Promise<GitRepo>
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
    const route = this.personalOrg ? 'GET /users/{username}/repos' : 'GET /orgs/{org}/repos'
    const options = this.personalOrg ? {username: this.username} : {org: this.owner}
    const per_page = 100

    const result: string[] = []
    for (let page = 1; true; page++) {
      const pageResult: string[] = await (this.octokit
        .request(
          route,
          Object.assign({per_page, page}, options)
        )
        .then(res => res.data.map(repo => repo.html_url))
        .catch(err => {
          if (/Bad credentials/.test(err.message)) {
            throw new BadCredentials('listRepos', this.config.type, err)
          } else {
            throw err
          }
        }) as Promise<string[]>)

      result.push(...pageResult)

      if (pageResult.length < per_page) {
        break
      }
    }

    return result
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

const mapPullRequestStatus = (pullRequest: {state: 'open' | 'closed', merged: boolean, mergeable: boolean, mergeable_state: string}): PullRequestStatus => {
  switch (pullRequest.state) {
    case 'open':
      if (pullRequest.mergeable_state === 'dirty') {
        return PullRequestStatus.Conflicts
      } else if (pullRequest.mergeable_state === 'blocked') {
        return PullRequestStatus.Blocked
      } else {
        return PullRequestStatus.Active
      }
    case 'closed':
      if (pullRequest.merged) {
        return PullRequestStatus.Completed
      } else {
        return PullRequestStatus.Abandoned
      }
    default:
      return PullRequestStatus.NotSet
  }
}
