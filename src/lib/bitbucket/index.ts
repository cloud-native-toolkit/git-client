import {delete as deleteUrl, get, post, Request, Response} from 'superagent';

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
import {BadCredentials, GitRepo, RepoNotFound, TypedGitRepoConfig, Webhook} from '../git.model';
import {GitBase} from '../git.base';
import {applyCert, isResponseError} from '../../util/superagent-support';

enum BitbucketHeader {
  event = 'X-Event-Key'
}

enum BitbucketEvent {
  push = 'repo:push'
}

interface BitbucketHookData {
  description: string;
  url: string;
  active: boolean;
  events: BitbucketEvent[],
}

interface TreeEntry {
  path: string;
  type: 'commit_directory' | 'commit_file';
  mimetype?: string;
  size?: number;
  commit?: object;
  links: {
    self: {href: string},
    meta: {href: string}
  };
}

interface SrcResponse {
  page: number;
  next?: string;
  previous?: string;
  pagelen: number;
  values: TreeEntry[];
}

interface BranchResponse {
  id: string;
  displayId: string;
  type: string;
  latestCommit: string;
  latestChangeset: string;
  isDefault: boolean;
}

export class Bitbucket extends GitBase implements GitApi {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://api.bitbucket.org/2.0`;
  }

  getRepoUrl(): string {
    return `${this.getBaseUrl()}/repositories/${this.config.owner}/${this.config.repo}`;
  }

  get(url: string) {
    const req = get(url)
      .auth(this.username, this.password)
      .set('User-Agent', `${this.username} via ibm-garage-cloud cli`)
      .accept('application/json')

    return applyCert(req, this.caCert)
  }

  post(url: string) {
    const req = post(url)
      .auth(this.username, this.password)
      .set('User-Agent', `${this.username} via ibm-garage-cloud cli`)
      .accept('application/json')

    return applyCert(req, this.caCert)
  }

  delete(url: string) {
    const req = deleteUrl(url)
      .auth(this.username, this.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')

    return applyCert(req, this.caCert)
  }

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    return this.delete(`${this.getRepoUrl()}/refs/branches/${branch}`)
      .then(() => 'success')
  }

  async getPullRequest(options: GetPullRequestOptions): Promise<PullRequest> {
    return this.get(`${this.getRepoUrl()}/pullrequests/${options.pullNumber}`)
      .then(res => ({
        pullNumber: res.body.id,
        status: mapPullRequestStatus(res.body.status),
        sourceBranch: res.body.source.branch.name,
        targetBranch: res.body.destination.branch.name
      }))
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {
    return this.post(`${this.getRepoUrl()}/pullrequests`)
      .send({
        title: options.title,
        source: {
          branch: {
            name: options.sourceBranch
          }
        },
        destination: {
          branch: {
            name: options.targetBranch
          }
        }
      })
      .then(res => ({
        pullNumber: res.body.id,
        status: mapPullRequestStatus(res.body.status),
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch
      }))
  }

  async mergePullRequestInternal(options: MergePullRequestOptions): Promise<string> {

    return this.post(`${this.getRepoUrl()}/pullrequests/${options.pullNumber}/merge`)
      .send({
        type: 'git',
        close_source_branch: options.delete_branch_after_merge,
        merge_strategy: options.method === 'merge' ? 'merge_commit' : options.method === 'squash' ? 'squash' : 'fast_forward',
        message: options.message
      })
      .then(() => 'success')
      .catch(err => {
        if (err.response.body.error.message === 'You can\'t merge until you resolve all merge conflicts.') {
          throw new MergeConflict(options.pullNumber)
        }

        throw err
      }) as Promise<string>
  }

  async updatePullRequestBranch(options: UpdatePullRequestBranchOptions): Promise<string> {

    throw new Error('Method not implemented: updatePullRequestBranch')
  }

  async getWebhooks(): Promise<Webhook[]> {

    return this.get(`${this.getRepoUrl()}/hooks`)
      .then(res => {
        return res.body.values.map(value => ({
          id: value.uuid,
          name: value.uuid,
          active: value.active,
          events: value.events,
          config: {
            content_type: 'application/json',
            url: value.url,
            insecure_ssl: 0
          }
        }))
      }) as Promise<Webhook[]>
  }

  async listFiles(): Promise<Array<{ path: string, url?: string }>> {
    const response: Response = await this.get(this.getRepoUrl() + '/src?pagelen=100')

    const fileResponse: SrcResponse = response.body;

    return fileResponse.values
      .filter(s => s.type === 'commit_file')
      .map(s => ({path: s.path, url: s.links.self.href}));
  }

  async getFileContents(fileDescriptor: { path: string, url?: string }): Promise<string | Buffer> {
    const response: Response = await this.get(fileDescriptor.url)
      .accept('text/plain')

    return response.text;
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await this.get(this.getRepoUrl() + '/branches/default')

    const branchResponse: BranchResponse = response.body;

    return branchResponse.displayId;
  }

  async createWebhook(options: CreateWebhook): Promise<string> {
    try {
      const response: Response = await this.post(this.getRepoUrl() + '/hooks')
        .send(this.buildWebhookData(options));

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

  buildWebhookData({webhookUrl}: { webhookUrl?: string }): BitbucketHookData {
    return {
      description: 'Webhook',
      url: webhookUrl,
      active: true,
      events: [BitbucketEvent.push],
    }
  }

  getRefPath(): string {
    return 'body.push.changes[0].new.name';
  }

  getRef(): string {
    return this.config.branch;
  }

  getRevisionPath(): string {
    return 'body.push.changes[0].new.target.hash';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.links.html.href';
  }

  getRepositoryNamePath(): string {
    return 'body.repository.full_name';
  }

  getHeader(headerId: GitHeader): string {
    return BitbucketHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return BitbucketEvent[eventId];
  }

  async createRepo(options: CreateRepoOptions): Promise<GitApi> {

    const name = options.name;
    const privateRepo = options.privateRepo || false;
    const autoInit = options.autoInit || true

    const repoApi: Bitbucket = await this.post(`${this.getBaseUrl()}/repositories/${this.config.owner}/${name}`)
      .set('Content-Type', 'application/json')
      .send({scm: 'git'})
      .then(res => {
        const url = res.body.links.html.href

        return this.getRepoApi({repo: name, url})
      })
      .catch(err => {
        if (/Unauthorized/.test(err.message)) {
          throw new BadCredentials('createRepo', this.config.type, err)
        }

        throw err
      }) as Bitbucket

    if (autoInit) {
      await repoApi.createFile('README.md', `# ${name}`).catch(err => console.log('Error:', err))
    }

    return repoApi;
  }

  async listRepos(): Promise<string[]> {
    const result: string[] = []

    let url = `${this.getBaseUrl()}/repositories/${this.config.owner}`
    while (url) {
      const {next, repos} = await this.get(url)
        .set('Content-Type', 'application/json')
        .then(res => {
          return {
            next: res.body.next,
            repos: res.body.values.map((repo: {links: {html: {href: string}}}) => repo.links.html.href)
          }
        })

      url = next
      result.push(...repos)
    }

    return result
  }

  async createFile(filename: string, contents: string): Promise<GitApi> {
    const filepath = filename.startsWith('/') ? filename : `/${filename}`

    await this.post(`${this.getRepoUrl()}/src`)
      .set('Content-Type', 'multipart/form-data')
      .field(filepath, contents)

    return this;
  }

  deleteRepo(): Promise<GitApi> {
    return this.delete(this.getRepoUrl())
      .then(res => {
        const url = this.config.url.replace(new RegExp('(.*)/.*', 'g'), '$1')

        return this.getRepoApi({url})
      })
      .catch(err => {
        if (/Unauthorized/.test(err.message)) {
          throw new BadCredentials('deleteRepo', this.config.type, err)
        }

        throw err
      }) as Promise<GitApi>
  }

  async getRepoInfo(): Promise<GitRepo> {
    return this.get(this.getRepoUrl())
      .then(res => {
        const gitRepo: GitRepo = {
          id: res.body.id,
          slug: res.body.full_name,
          http_url: res.body.links.html.href,
          name: res.body.name,
          description: res.body.description,
          is_private: res.body.is_private,
          default_branch: res.body.mainbranch.name
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

  async getBranches(): Promise<GitBranch[]> {
    throw new Error('method not implemented: getBranches()')
  }
}

const mapPullRequestStatus = (status: string): PullRequestStatus => {
  switch (status) {
    case 'MERGED':
      return PullRequestStatus.Completed
    case 'SUPERSEDED':
      return PullRequestStatus.Abandoned
    case 'OPEN':
      return PullRequestStatus.Active
    case 'DECLINED':
      return PullRequestStatus.Abandoned
    default:
      return PullRequestStatus.NotSet
  }
}
