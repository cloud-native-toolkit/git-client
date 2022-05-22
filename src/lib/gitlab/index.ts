import {get, post, delete as deleteUrl, Response} from 'superagent';

import {
  CreatePullRequestOptions,
  CreateRepoOptions,
  CreateWebhook, DeleteBranchOptions, GetPullRequestOptions,
  GitApi,
  GitEvent,
  GitHeader, MergePullRequestOptions, PullRequest,
  UnknownWebhookError, UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {GitBase} from '../git.base';
import {TypedGitRepoConfig, Webhook} from '../git.model';
import {isResponseError} from '../../util/superagent-support';
import first from '../../util/first';
import {apiFromConfig} from '../util';

export class GroupNotFoundError extends Error {
  constructor(public readonly groupName) {
    super(`Unable to find group: ${groupName}`);
  }
}

interface GitlabHookData {
  id: string;
  url: string;
  push_events?: boolean;
  enable_ssl_verification?: boolean;
  token?: string;
}

interface GitlabParams {
  owner: string;
  repo: string;
  jenkinsUrl?: string;
  jenkinsUser?: string;
  jenkinsPassword?: string;
  jobName?: string;
  webhookUrl?: string;
}

enum GitlabHeader {
  event = 'X-GitLab-Event'
}

enum GitlabEvent {
  push = 'Push Hook'
}

interface Tree {
  id: string;
  name: string;
  type: 'blob' | 'tree';
  path: string;
  mode: string;
}

interface FileResponse {
  file_name: string;
  file_path: string;
  size: number;
  encoding: 'base64';
  content: string;
  content_sha256: string;
  ref: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
}

interface Branch {
  name: string;
  default: boolean;
}

export class Gitlab extends GitBase implements GitApi {

  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getConfig(): TypedGitRepoConfig {
    return this.config
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v4`
  }

  getRepoUrl(): string {
    return `${this.getBaseUrl()}/projects/${this.config.owner}%2F${this.config.repo}`;
  }

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    throw new Error('Method not implemented: deleteBranch')
  }

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    const response: Response = await get(this.buildUrl(this.getRepoUrl() + '/repository/tree', [this.branchParam(), 'per_page=1000']))
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const treeResponse: Tree[] = response.body;

    return treeResponse
      .filter(tree => tree.type === 'blob')
      .map(tree => ({
        path: tree.path.replace('files/', ''),
        url: this.getRepoUrl() + '/repository/' + tree.path,
      }));
  }

  async getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer> {
    const response: Response = await get(fileDescriptor.url)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const fileResponse: FileResponse = response.body;

    return new Buffer(fileResponse.content, fileResponse.encoding);
  }

  async getPullRequest(options: GetPullRequestOptions): Promise<PullRequest> {

    throw new Error('Method not implemented: getPullRequest')
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {

    throw new Error('Method not implemented: createPullRequest')
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<string> {

    throw new Error('Method not implemented: mergePullRequest')
  }

  async updatePullRequestBranch(options: UpdatePullRequestBranchOptions): Promise<string> {

    throw new Error('Method not implemented: updatePullRequestBranch')
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await get(this.getRepoUrl() + '/repository/branches')
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const branchResponse: Branch[] = response.body;

    return first(branchResponse.filter(branch => branch.default).map(branch => branch.name)).valueOrUndefined();
  }

  private buildUrl(url: string, params: string[] = []): string {
    const paramString: string = params.filter(p => !!p).join('&');

    const values: string[] = [url];
    if (paramString) {
      values.push(paramString);
    }

    return values.join('?');
  }

  private branchParam(): string {
    return this.config.branch ? `ref=${this.config.branch}` : '';
  }

  async createWebhook(options: CreateWebhook): Promise<string> {
    try {
      const response: Response = await post(this.getRepoUrl() + '/hooks')
        .set('Private-Token', this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
        .send(this.buildWebhookData(Object.assign({}, this.config, options)))
        .catch(error => {
          console.log('Error', error)
          throw error;
        });

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

  buildWebhookData({owner, repo, jenkinsUrl = 'https://jenkins.local/', jenkinsUser, jenkinsPassword, jobName, webhookUrl}: GitlabParams): GitlabHookData {
    const urlParts = /(.*):\/\/(.*)\/*/.exec(jenkinsUrl);
    const protocol = urlParts[1];
    const host = urlParts[2];

    const credentials = (jenkinsUser && jenkinsPassword)
      ? `${jenkinsUser}:${jenkinsPassword}@`
      : '';

    const url = webhookUrl
      ? webhookUrl
      : `${protocol}://${credentials}${host}/project/${jobName}`;

    return {
      id: `${this.config.owner}%2F${this.config.repo}`,
      url,
      push_events: true,
      enable_ssl_verification: (protocol === 'https'),
    };
  }

  getRefPath(): string {
    return 'body.ref';
  }

  getRef(): string {
    return `refs/heads/${this.config.branch}`;
  }

  getRevisionPath(): string {
    return 'body.checkout_sha';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.git_http_url';
  }

  getRepositoryNamePath(): string {
    return 'body.project.path_with_namespace'
  }

  getHeader(headerId: GitHeader): string {
    return GitlabHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return GitlabEvent[eventId];
  }

  async createRepo({name, privateRepo = false, autoInit = true}: CreateRepoOptions): Promise<GitApi> {
    const payload = Object.assign({
      name: name,
      visibility: privateRepo ? 'private' : 'public',
      initialize_with_readme: autoInit
    }, autoInit ? {
      default_branch: 'main'
    } : {})

    if (this.config.owner === this.config.username) {
      return post(this.getBaseUrl())
        .set('Private-Token', this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
        .send(payload)
        .then(res => {
          return this.getRepoApi({repo: res.body.name, url: res.body.http_url_to_repo})
        })
    } else {
      const namespaceId: number = await get(this.getBaseUrl() + '/groups?search=' + this.config.owner)
        .set('Private-Token', this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
        .then(res => {
          const groups: Array<{id: number}> = res.body;

          if (groups.length === 0) {
            throw new GroupNotFoundError(this.config.owner)
          }

          return groups[0].id
        })

      return post(this.getBaseUrl() + '/projects')
        .set('Private-Token', this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
        .send(Object.assign({}, payload, {namespace_id: namespaceId}))
        .then(async res => {
          return this.getRepoApi({repo: res.body.name, url: res.body.http_url_to_repo})
        })
    }
  }

  async deleteRepo(): Promise<GitApi> {
    // const repoId: string = await this.getRepoId();

    return deleteUrl(this.getRepoUrl())
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => {
        const url = this.config.url.replace(new RegExp('(.*)/.*', 'g'), '$1');

        return this.getRepoApi({url})
      })
  }

  async getWebhooks(): Promise<Webhook[]> {
    return get(this.getRepoUrl() + '/hooks')
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then<Webhook[]>(res => {
        console.log('Got hooks', res.body)
        return (res.body as any[])
          .map(hook => ({id: hook.id, name: hook.id, active: true, events: [], config: {content_type: 'application/json', url: hook.url, insecure_ssl: hook.enable_ssl_verification ? 1 : 0}}))
      })
  }

  getRepoApi({repo, url}: {repo?: string, url: string}): GitApi {
    const newConfig = Object.assign({}, this.config, {repo, url})

    return apiFromConfig(newConfig)
  }

}
