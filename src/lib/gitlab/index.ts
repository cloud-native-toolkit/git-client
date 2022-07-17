import {delete as deleteUrl, get, post, put, Response} from 'superagent';

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
import {GitBase} from '../git.base';
import {GitRepo, RepoNotFound, TypedGitRepoConfig, Webhook} from '../git.model';
import {isResponseError} from '../../util/superagent-support';
import first from '../../util/first';
import sleep from '../../util/sleep';

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

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v4`
  }

  getRepoUrl(): string {
    return `${this.getBaseUrl()}/projects/${this.config.owner}%2F${this.config.repo}`;
  }

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    return deleteUrl(`${this.getRepoUrl()}/repository/branches/${branch}`)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(() => 'success')
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

  async getPullRequest({pullNumber}: GetPullRequestOptions): Promise<PullRequest> {
    return get(`${this.getRepoUrl()}/merge_requests/${pullNumber}`)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => ({
        pullNumber: res.body.iid,
        sourceBranch: res.body.source_branch,
        targetBranch: res.body.target_branch,
        mergeStatus: res.body.merge_status,
        hasConflicts: res.body.has_conflicts,
        status: mapPullRequestStatus(res.body),
      }))
  }

  async createPullRequest({sourceBranch, targetBranch, title = 'pr', draft, issue, maintainer_can_modify}: CreatePullRequestOptions): Promise<PullRequest> {
    return post(`${this.getRepoUrl()}/merge_requests`)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .send({
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        allow_collaboration: maintainer_can_modify
      })
      .then(res => ({
        pullNumber: res.body.iid,
        status: mapPullRequestStatus(res.body),
        sourceBranch,
        targetBranch
      })) as Promise<PullRequest>
  }

  async mergePullRequestInternal(options: MergePullRequestOptions): Promise<string> {

    const pullNumber = options.pullNumber
    const method = options.method
    const delete_branch_after_merge = options.delete_branch_after_merge || false
    const message = options.message
    const title = options.title

    let status: string = ''
    let conflicts: boolean = false
    while (true) {
      const {mergeStatus, hasConflicts} = await this.getPullRequest({pullNumber})

      status = mergeStatus;
      conflicts = hasConflicts;

      if (status !== 'checking') {
        break
      }

      console.log('PR is not yet ready to merge. Sleeping 3s...')
      await sleep(3000)
    }

    if (status !== 'can_be_merged' && conflicts) {
      throw new MergeConflict(pullNumber)
    }

    if (status !== 'can_be_merged') {
      throw new Error('Pull request cannot be merged: ' + status)
    }

    const mergeMessage = `${title}\n${!message ? '' : message}`

    return put(`${this.getRepoUrl()}/merge_requests/${pullNumber}/merge`)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .send(
        Object.assign({
          should_remove_source_branch: delete_branch_after_merge,
          squash: method === 'squash'
        },
          method === 'squash' ? {squash_commit_message: mergeMessage} : {},
          method !== 'squash' ? {merge_commit_message: mergeMessage} : {}
        )
      )
      .then(() => 'success')
  }

  async updatePullRequestBranch({pullNumber, rateLimit}: UpdatePullRequestBranchOptions): Promise<string> {
    return put(`${this.getRepoUrl()}/merge_requests/${pullNumber}/rebase`)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(() => 'success')
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
      const response: Response = await (post(this.getRepoUrl() + '/hooks')
        .set('Private-Token', this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
        .send(this.buildWebhookData(Object.assign({}, this.config, options)))
        .catch(error => {
          console.log('Error', error)
          throw error;
        }) as Promise<Response>)

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

    if (this.personalOrg) {
      return post(`${this.getBaseUrl()}/projects`)
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

  async listRepos(): Promise<string[]> {
    const url: string = this.personalOrg ? `${this.getBaseUrl()}/users/${this.username}/projects` : `${this.getBaseUrl()}/groups/${this.owner}/projects`

    return get(url)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => res.body.map(repo => repo.http_url_to_repo)) as Promise<string[]>
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

  async getRepoInfo(): Promise<GitRepo> {
    return get(this.getRepoUrl())
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json')
      .then(res => {
        const gitRepo: GitRepo = {
          id: res.body.id,
          slug: res.body.path_with_namespace,
          http_url: res.body.http_url_to_repo,
          name: res.body.path,
          description: res.body.description,
          is_private: res.body.visibility === 'private',
          default_branch: res.body.default_branch
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

const mapPullRequestStatus = (pr: {state: 'opened' | 'closed', merge_status: string, merged_at?: string}): PullRequestStatus => {
  switch (pr.state) {
    case 'opened':
      if (pr.merge_status === 'cannot_be_merged') {
        return PullRequestStatus.Conflicts
      } else {
        return PullRequestStatus.Active
      }
    case 'closed':
      if (pr.merged_at) {
        return PullRequestStatus.Completed
      } else {
        return PullRequestStatus.Abandoned
      }
    default:
      return PullRequestStatus.NotSet
  }
  return PullRequestStatus.Completed
}
