import {delete as httpDelete, get, post, Response} from 'superagent';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as StreamZip from 'node-stream-zip';

import {
  CreatePullRequestOptions, CreateRepoOptions,
  CreateWebhook, DeleteBranchOptions, GetPullRequestOptions,
  GitApi, GitBranch,
  GitEvent,
  GitHeader, MergeConflict, MergePullRequestOptions, PullRequest,
  UnknownWebhookError, UpdatePullRequestBranchOptions,
  WebhookAlreadyExists
} from '../git.api';
import {GitBase} from '../git.base';
import {BadCredentials, GitRepo, RepoNotFound, TypedGitRepoConfig, Webhook} from '../git.model';
import {isResponseError} from '../../util/superagent-support';
import first from '../../util/first';
import {apiFromConfig} from '../util';


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

  async deleteBranch({branch}: DeleteBranchOptions): Promise<string> {
    return httpDelete(`${this.getRepoUrl()}/branches/${branch}`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then(() => 'success')
  }

  async getPullRequest({pullNumber}: GetPullRequestOptions): Promise<PullRequest> {
    return get(`${this.getRepoUrl()}/pulls/${pullNumber}`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then(res => ({
        pullNumber: res.body.number,
        sourceBranch: res.body.head.ref,
        targetBranch: res.body.base.ref,
      }))
  }

  async createPullRequest({title, sourceBranch, targetBranch}: CreatePullRequestOptions): Promise<PullRequest> {
    return post(`${this.getRepoUrl()}/pulls`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send({
        title,
        head: sourceBranch,
        base: targetBranch,
      })
      .then(res => ({
        pullNumber: res.body.number,
        sourceBranch,
        targetBranch
      }))
  }

  async mergePullRequestInternal({pullNumber, method, resolver, title, message, delete_branch_after_merge = false}: MergePullRequestOptions): Promise<string> {
    return post(`${this.getRepoUrl()}/pulls/${pullNumber}/merge`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send({
        Do: method,
        MergeTitleField: title,
        MergeMessageField: message,
        delete_branch_after_merge
      })
      .then(() => 'success')
      .catch(err => {
        if (err.response.status === 405) {
          console.log('Merge conflict: ', err)
          throw new MergeConflict(pullNumber)
        } else {
          throw err
        }
      })
  }

  async updatePullRequestBranch({pullNumber}: UpdatePullRequestBranchOptions): Promise<string> {
    return post(`${this.getRepoUrl()}/pulls/${pullNumber}/update?style=rebase`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then(() => 'success')
  }

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    try {
     // const token: string = await this.getToken();

      const url: string = `${this.config.protocol}://${this.config.host}/api/v1/repos/${this.config.owner}/${this.config.repo}/archive/${this.config.branch}.zip`;
      const response: Response = await get(url)
        .auth(this.config.username, this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/octet-stream')
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
      const response: Response = await get(url)
        .auth(this.config.username, this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('text/plain');

      return response.text;
    } catch (err) {
      console.log('Error getting file contents', err);
      throw err;
    }
  }

  async getDefaultBranch(): Promise<string> {
    try {
      // const token: string = await this.getToken();

      const response: Response = await get(this.getRepoUrl())
        .auth(this.config.username, this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json');

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
    return get(`${this.getRepoUrl()}/hooks`)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then(res => res.body.map(hook => ({
        id: hook.id,
        name: hook.id,
        active: hook.active,
        events: hook.events,
        config: {
          content_type: hook.config?.content_type,
          url: hook.config?.url,
          insecure_ssl: 0
        }
      })))
  }

  async createRepo({name, privateRepo = false, autoInit = true}: CreateRepoOptions): Promise<GitApi> {
    const url: string = this.personalOrg ? `${this.getBaseUrl()}/user/repos` : `${this.getBaseUrl()}/orgs/${this.config.owner}/repos`

    return post(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send({
        name: name,
        private: privateRepo,
        auto_init: autoInit
      })
      .then((res: Response) => this.getRepoApi({repo: name, url: res.body.html_url}))
      .catch((err: Error) => {
        if (/Unauthorized/.test(err.message)) {
          throw new BadCredentials('createRepo', this.config.type, err)
        }

        throw err
      })
  }

  async listRepos(): Promise<string[]> {
    const url: string = this.personalOrg ? `${this.getBaseUrl()}/user/repos` : `${this.getBaseUrl()}/orgs/${this.config.owner}/repos`

    return get(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then((res: Response) => res.body.map(repo => repo.html_url))
  }

  async deleteRepo(): Promise<GitApi> {
    return httpDelete(this.getRepoUrl())
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then((res: Response) => {
        const url = this.config.url.replace(new RegExp('(.*)/.*', 'g'), '$1')

        return this.getRepoApi({url})
      });
  }

  async getRepoInfo(): Promise<GitRepo> {
    return get(this.getRepoUrl())
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .then(res => ({
        id: res.body.id,
        slug: res.body.full_name,
        http_url: res.body.html_url,
        name: res.body.name,
        description: res.body.description,
        is_private: res.body.private
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
