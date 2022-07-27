import * as superagent from 'superagent';
import {Request, Response} from 'superagent';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as StreamZip from 'node-stream-zip';

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
import {BadCredentials, GitRepo, RepoNotFound, TypedGitRepoConfig, Webhook} from '../git.model';
import {isResponseError} from '../../util/superagent-support';


enum GiteaEvent {
  create = 'create',
  'delete' = 'delete',
  fork = 'fork',
  push = 'push',
  issues = 'issues',
  issue_comment = 'issue_comment',
  pull_request = 'pull_request',
  release = 'release',
}

interface GiteaHookData {
  type: 'gitea' | 'slack';
  config: {
    url: string;
    content_type: 'json' | 'form';
    secret?: string;
  }
  events: GiteaEvent[];
  active: boolean;
}

enum GiteaHeader {
  event = 'X-Gitea-Event'
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

interface Branch {
  name: string;
}

interface Token {
  name: string;
  sha1: string;
}

const delay = (): number => {
  return 3000 + Math.random() * 2000
}

const defaultRetryCallback = (err: any, res: Response): boolean => {

  const errorCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'EADDRINUSE',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN'
  ]

  if (err && err.code && ~errorCodes.indexOf(err.code)) {
    return true;
  }

  const statuses = [
    405,
    408,
    413,
    429,
    500,
    502,
    503,
    504,
    521,
    522,
    524
  ]

  if (res && res.status && ~statuses.indexOf(res.status)) {
    return true;
  }

  if (err && "timeout" in err && err.code === "ECONNABORTED") {
    return true;
  }

  return err && "crossDomain" in err;
}

export class Gitea extends GitBase implements GitApi {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v1`;
  }

  getRepoUrl(): string {
    return `${this.getBaseUrl()}/repos/${this.config.owner}/${this.config.repo}`;
  }

  // Gittea does not return the token with the GET
  // async getToken(): Promise<string> {
  //   const response: Response = await get(`${this.config.protocol}://${this.config.host}/api/v1/users/${this.config.username}/tokens`)
  //     .auth(this.config.username, this.config.password)
  //     .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
  //     .accept('application/json');

  //   const tokens: Token[] = response.body;

  //   if (!tokens || tokens.length === 0) {
  //     return this.createToken();
  //   }

  //   return first(tokens.map(token => token.sha1));
  // }

  // async createToken(): Promise<string> {
  //   const response: Response = await post(`${this.config.protocol}://${this.config.host}/api/v1/users/${this.config.username}/tokens`)
  //     .auth(this.config.username, this.config.password)
  //     .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
  //     .accept('application/json')
  //     .send({name: 'gitea'});

  //   return response.body.sha1;
  // }

  delete(url: string, retryCallback: (err: Error, res: Response) => boolean = defaultRetryCallback): Request {
    return superagent
      .delete(url)
      .auth(this.username, this.password)
      .set('User-Agent', `${this.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .retry(10, retryCallback)
  }

  get(url: string, retryCallback: (err: Error, res: Response) => boolean = defaultRetryCallback): Request {
    return superagent
      .get(url)
      .auth(this.username, this.password)
      .set('User-Agent', `${this.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .retry(10, retryCallback)
  }

  post(url: string, retryCallback: (err: Error, res: Response) => boolean = defaultRetryCallback): Request {
    return superagent.post(url)
      .auth(this.username, this.password)
      .set('User-Agent', `${this.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .retry(10, retryCallback)
  }

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    return this.delete(`${this.getRepoUrl()}/branches/${branch}`)
      .then(() => 'success')
  }

  async getPullRequest({pullNumber}: GetPullRequestOptions): Promise<PullRequest> {
    return this.get(`${this.getRepoUrl()}/pulls/${pullNumber}`)
      .then(res => {
        return {
          pullNumber: res.body.number,
          status: mapPullRequestStatus(res.body),
          sourceBranch: res.body.head.ref,
          targetBranch: res.body.base.ref,
        }
      })
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {

    return this.post(`${this.getRepoUrl()}/pulls`)
      .send({
        title: options.title,
        head: options.sourceBranch,
        base: options.targetBranch,
      })
      .then(res => ({
        pullNumber: res.body.number,
        status: mapPullRequestStatus(res.body),
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch
      }))
  }

  async mergePullRequestInternal(options: MergePullRequestOptions): Promise<string> {
    return this
      .post(
        `${this.getRepoUrl()}/pulls/${options.pullNumber}/merge`,
        (err: Error, res: Response) => res.status === 500 ? false : defaultRetryCallback(err, res)
      )
      .send({
        Do: options.method,
        MergeTitleField: options.title,
        MergeMessageField: options.message,
        delete_branch_after_merge: options.delete_branch_after_merge || false
      })
      .then(res => {
        console.log('Merge result: ', JSON.stringify(res, null, 2))
        if (res.status === 500 && /Automatic merge failed.*fix conflicts and then commit the result/.test(res.body.message)) {
          console.log('Merge conflict!!')
          throw new MergeConflict(options.pullNumber)
        }

        return 'success'
      })
      .catch(err => {
        if (err.response.status === 405) {
          console.log('Merge conflict: ', err)
          throw new MergeConflict(options.pullNumber)
        } else if (err.response.status === 500 && /Automatic merge failed.*fix conflicts and then commit the result/.test(err.response.body.text)) {
          throw new MergeConflict(options.pullNumber)
        } else {
          throw err
        }
      }) as Promise<string>
  }

  async updatePullRequestBranch({pullNumber}: UpdatePullRequestBranchOptions): Promise<string> {
    return this.post(`${this.getRepoUrl()}/pulls/${pullNumber}/update?style=rebase`)
      .then(() => 'success')
  }

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    try {
     // const token: string = await this.getToken();

      const url: string = `${this.config.protocol}://${this.config.host}/api/v1/repos/${this.config.owner}/${this.config.repo}/archive/${this.config.branch}.zip`;
      const response: Response = await this.get(url)
        .buffer(true);

      const tmpFile = `${this.config.branch}-tmp.zip`;
      await fs.promises.writeFile(tmpFile, response.body);

      const zip = new StreamZip({
        file: tmpFile,
        storeEntries: true,
      });

      return new Promise<Array<{path: string, url?: string, contents?: string}>>((resolve) => {
        zip.on('ready', () => {
          const files = Object.values(zip.entries())
            .filter(entry => !entry.isDirectory)
            .map(entry => ({path: entry.name.replace(new RegExp('^' + this.config.repo + '/'), '')}));

          // Do not forget to close the file once you're done
          zip.close(() => {
            fs.promises.unlink(tmpFile);
          });

          resolve(files);
        });
      });
    } catch (err) {
      console.log('Error listing files', err);
      throw err;
    }
  }

  async getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer> {
    try {
      // const token: string = await this.getToken();

      const url: string = `${this.config.protocol}://${this.config.host}/api/v1/repos/${this.config.owner}/${this.config.repo}/raw/${this.config.branch}/${fileDescriptor.path}`;
      const response: Response = await this.get(url)

      return response.text;
    } catch (err) {
      console.log('Error getting file contents', err);
      throw err;
    }
  }

  async getDefaultBranch(): Promise<string> {
    try {
      // const token: string = await this.getToken();

      const response: Response = await this.get(this.getRepoUrl())

      const repoResponse: RepoResponse = response.body;

      return _.get(repoResponse, 'default_branch');
    } catch (err) {
      return undefined;
    }
  }

  async createWebhook(options: CreateWebhook): Promise<string> {
    try {
      // const token: string = await this.getToken();

      if( "http" === this.config.protocol.toLowerCase()){
        console.log("***** Warning! Creating webhooks for repo where urls start with http may not work.  If possible use https.");
      }
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

  buildWebhookData({webhookUrl}: {webhookUrl?: string}): GiteaHookData {
    return {
      type: 'gitea',
      config: {
        url: webhookUrl,
        content_type: 'json'
      },
      events: [GiteaEvent.push],
      active: true,
    };
  }

  getRefPath(): string {
    return 'body.ref';
  }

  getRef(): string {
    return `refs/heads/${this.config.branch}`;
  }

  getRevisionPath(): string {
    return 'body.after';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.clone_url';
  }

  getRepositoryNamePath(): string {
    return 'body.repository.full_name';
  }

  getHeader(headerId: GitHeader): string {
    return GiteaHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return GiteaEvent[eventId];
  }

  async getWebhooks(): Promise<Webhook[]> {
    return this.get(`${this.getRepoUrl()}/hooks`)
      .then(res => res.body.map(hook => {
        const webhook: Webhook = {
          id: hook.id,
          name: hook.id,
          active: hook.active,
          events: hook.events,
          config: {
            content_type: hook.config?.content_type,
            url: hook.config?.url,
            insecure_ssl: 0
          }
        }

        return webhook
      })) as Promise<Webhook[]>
  }

  async createRepo(options: CreateRepoOptions): Promise<GitApi> {
    const url: string = this.personalOrg ? `${this.getBaseUrl()}/user/repos` : `${this.getBaseUrl()}/orgs/${this.config.owner}/repos`

    // {name, privateRepo = false, autoInit = true}
    return this.post(url)
      .send({
        name: options.name,
        private: options.privateRepo || false,
        auto_init: options.autoInit || true
      })
      .then((res: Response) => this.getRepoApi({repo: options.name, url: res.body.html_url}))
      .catch((err: Error) => {
        if (/Unauthorized/.test(err.message)) {
          throw new BadCredentials('createRepo', this.config.type, err)
        }

        throw err
      }) as Promise<any>
  }

  async listRepos(): Promise<string[]> {
    const url: string = this.personalOrg ? `${this.getBaseUrl()}/user/repos` : `${this.getBaseUrl()}/orgs/${this.config.owner}/repos`

    return this.get(url)
      .then((res: Response) => res.body.map(repo => repo.html_url)) as Promise<string[]>
  }

  async deleteRepo(): Promise<GitApi> {
    return this.delete(this.getRepoUrl())
      .then((res: Response) => {
        const url = this.config.url.replace(new RegExp('(.*)/.*', 'g'), '$1')

        return this.getRepoApi({url})
      });
  }

  async getRepoInfo(): Promise<GitRepo> {
    return this.get(this.getRepoUrl())
      .then(res => {
        const gitRepo: GitRepo = {
          id: res.body.id,
          slug: res.body.full_name,
          http_url: res.body.html_url,
          name: res.body.name,
          description: res.body.description,
          is_private: res.body.private,
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

const mapPullRequestStatus = (pullRequest: {state: 'open' | 'closed', merged: boolean, mergeable: boolean}): PullRequestStatus => {
  switch (pullRequest.state) {
    case 'open':
      if (pullRequest.mergeable) {
        return PullRequestStatus.Active
      } else {
        return PullRequestStatus.Conflicts
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
