import {get, post, delete as deleteUrl, Response} from 'superagent';

import {
  CreatePullRequestOptions, CreateRepoOptions,
  CreateWebhook, DeleteBranchOptions, GetPullRequestOptions,
  GitApi, GitBranch,
  GitEvent,
  GitHeader, MergeConflict, MergePullRequestOptions, PullRequest,
  UnknownWebhookError, UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {BadCredentials, GitRepo, RepoNotFound, TypedGitRepoConfig, Webhook} from '../git.model';
import {GitBase} from '../git.base';
import {isResponseError} from '../../util/superagent-support';
import {apiFromConfig} from '../util';

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

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    return deleteUrl(`${this.getRepoUrl()}/refs/branches/${branch}`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(() => 'success')
  }

  async getPullRequest({pullNumber}: GetPullRequestOptions): Promise<PullRequest> {
    return get(`${this.getRepoUrl()}/pullrequests/${pullNumber}`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => ({
        pullNumber: res.body.id,
        sourceBranch: res.body.source.branch.name,
        targetBranch: res.body.destination.branch.name
      }))
  }

  async createPullRequest({title, sourceBranch, targetBranch}: CreatePullRequestOptions): Promise<PullRequest> {
    return post(`${this.getRepoUrl()}/pullrequests`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .send({
        title,
        source: {
          branch: {
            name: sourceBranch
          }
        },
        destination: {
          branch: {
            name: targetBranch
          }
        }
      })
      .then(res => ({
        pullNumber: res.body.id,
        sourceBranch,
        targetBranch
      }))
  }

  async mergePullRequestInternal({
                           pullNumber,
                           method,
                           message,
                           title,
                           delete_branch_after_merge
                         }: MergePullRequestOptions): Promise<string> {
    return post(`${this.getRepoUrl()}/pullrequests/${pullNumber}/merge`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .send({
        type: 'git',
        close_source_branch: delete_branch_after_merge,
        merge_strategy: method === 'merge' ? 'merge_commit' : method === 'squash' ? 'squash' : 'fast_forward',
        message
      })
      .then(() => 'success')
      .catch(err => {
        if (err.response.body.error.message === 'You can\'t merge until you resolve all merge conflicts.') {
          throw new MergeConflict(pullNumber)
        }

        throw err
      })
  }

  async updatePullRequestBranch(options: UpdatePullRequestBranchOptions): Promise<string> {

    throw new Error('Method not implemented: updatePullRequestBranch')
  }

  async getWebhooks(): Promise<Webhook[]> {

    return get(`${this.getRepoUrl()}/hooks`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
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
      })
  }

  async listFiles(): Promise<Array<{ path: string, url?: string }>> {
    const response: Response = await get(this.getRepoUrl() + '/src?pagelen=100')
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const fileResponse: SrcResponse = response.body;

    return fileResponse.values
      .filter(s => s.type === 'commit_file')
      .map(s => ({path: s.path, url: s.links.self.href}));
  }

  async getFileContents(fileDescriptor: { path: string, url?: string }): Promise<string | Buffer> {
    const response: Response = await get(fileDescriptor.url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`);

    return response.text;
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await get(this.getRepoUrl() + '/branches/default')
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`);

    const branchResponse: BranchResponse = response.body;

    return branchResponse.displayId;
  }

  async createWebhook(options: CreateWebhook): Promise<string> {
    try {
      const response: Response = await post(this.getRepoUrl() + '/hooks')
        .auth(this.config.username, this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
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

  async createRepo({name, privateRepo = false, autoInit = true}: CreateRepoOptions): Promise<GitApi> {
    const repoApi: Bitbucket = await post(`${this.getBaseUrl()}/repositories/${this.config.owner}/${name}`)
      .set('Content-Type', 'application/json')
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
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
      const {next, repos} = await get(url)
        .set('Content-Type', 'application/json')
        .auth(this.config.username, this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
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

    await post(`${this.getRepoUrl()}/src`)
      .set('Content-Type', 'multipart/form-data')
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .field(filepath, contents)

    return this;
  }

  deleteRepo(): Promise<GitApi> {
    return deleteUrl(this.getRepoUrl())
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => {
        const url = this.config.url.replace(new RegExp('(.*)/.*', 'g'), '$1')

        return this.getRepoApi({url})
      })
      .catch(err => {
        if (/Unauthorized/.test(err.message)) {
          throw new BadCredentials('deleteRepo', this.config.type, err)
        }

        throw err
      })
  }

  async getRepoInfo(): Promise<GitRepo> {
    return get(this.getRepoUrl())
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => ({
        id: res.body.id,
        slug: res.body.full_name,
        name: res.body.name,
        description: res.body.description,
        is_private: res.body.is_private
      }))
      .catch(err => {
        if (err.response.status === 404) {
          throw new RepoNotFound(this.config.url)
        }

        throw err
      })
  }

  async getBranches(): Promise<GitBranch[]> {
    throw new Error('method not implemented: getBranches()')
  }
}
