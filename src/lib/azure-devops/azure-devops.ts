import {getPersonalAccessTokenHandler, WebApi} from 'azure-devops-node-api';
import {IGitApi} from 'azure-devops-node-api/GitApi';
import {
  GitPullRequestMergeStrategy,
  ItemContentType,
  PullRequestAsyncStatus,
  PullRequestStatus,
  VersionControlChangeType
} from 'azure-devops-node-api/interfaces/GitInterfaces';
import {get, post} from 'superagent';

import {GitBase} from '../git.base';
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
  MergeMethod,
  MergePullRequestOptions,
  PullRequest,
  PullRequestStatus as CommonPullRequestStatus,
  UpdatePullRequestBranchOptions
} from '../git.api';
import {GitHookUrlVerification, GitRepo, TypedGitRepoConfig, Webhook} from '../git.model';
import {EvaluateErrorForRetry} from '../../util/retry-with-delay';
import first from '../../util/first';
import sleep from '../../util/sleep';

interface AzureTypedGitRepoConfig extends TypedGitRepoConfig {
  project?: string;
}

const mapMergeStatus = (status: PullRequestAsyncStatus): string => {
  switch (status) {
    case PullRequestAsyncStatus.Conflicts:
      return 'conflicts'
    case PullRequestAsyncStatus.Failure:
      return 'failure'
    case PullRequestAsyncStatus.NotSet:
      return 'notSet'
    case PullRequestAsyncStatus.Queued:
      return 'queued'
    case PullRequestAsyncStatus.RejectedByPolicy:
      return 'rejectedByPolicy'
    case PullRequestAsyncStatus.Succeeded:
      return 'succeeded'
  }
}

const mapMergeMethod = (method: MergeMethod): GitPullRequestMergeStrategy => {
  switch (method) {
    case 'merge':
      return GitPullRequestMergeStrategy.RebaseMerge
    case 'rebase':
      return GitPullRequestMergeStrategy.Rebase
    case 'squash':
      return GitPullRequestMergeStrategy.Squash
    default:
      throw new Error(`Unknown merge method: ${method}`)
  }
}

export class AzureDevops extends GitBase<AzureTypedGitRepoConfig> implements GitApi<AzureTypedGitRepoConfig> {
  constructor(config: AzureTypedGitRepoConfig) {
    super(config);
  }

  get project() {
    return this.config.project
  }

  async getGitApi(): Promise<IGitApi> {
    const orgUrl = `https://${this.host}/${this.owner}`;

    const authHandler = getPersonalAccessTokenHandler(this.password);
    const connection = new WebApi(orgUrl, authHandler);

    return connection.getGitApi(orgUrl);
  }

  async createRepo(options: CreateRepoOptions): Promise<GitApi> {
    const name = options.name
    const privateRepo = options.privateRepo || false
    const autoInit = options.autoInit || true

    const api = await this.getGitApi()

    const gitApi: AzureDevops = await api
      .createRepository({name}, this.project)
      .then(result => this.getRepoApi({repo: name, url: result.remoteUrl}) as AzureDevops)

    if (autoInit) {
      this.logger.debug('Initializing repo')
      await gitApi.createFile('README.md', `# ${name}`, 'Initial commit').catch(err => this.logger.debug('Error:', err))
    }

    return gitApi
  }

  async listRepos(): Promise<string[]> {
    const api = await this.getGitApi()

    return api
      .getRepositories(this.project)
      .then(result => result.map(repo => repo.remoteUrl))
  }

  async createFile(path: string, content: string, comment?: string, branch?: string): Promise<GitApi> {
    const api = await this.getGitApi()

    if (!branch) {
      branch = await api
        .getRepository(this.repo, this.project)
        .then(res => res.defaultBranch || 'main')
    }

    if (!comment) {
      comment = `Adds file: ${path}`
    }

    const oldObjectId = await api
      .getCommits(
        this.repo,
        {
          itemVersion: {
            version: branch
          },
          showOldestCommitsFirst: false,
          $top: 1
        },
        this.project
      )
      .then(res => first(res)
        .map(commit => commit.commitId)
        .valueOr('0000000000000000000000000000000000000000')
      )
      .catch(err => '0000000000000000000000000000000000000000')

    await api.createPush(
      {
        refUpdates: [{
          name: `refs/heads/${branch}`,
          oldObjectId
        }],
        commits: [{
          comment,
          changes: [{
            changeType: VersionControlChangeType.Add,
            item: {
              path
            },
            newContent: {
              content,
              contentType: ItemContentType.RawText
            }
          }]
        }]
      },
      this.repo,
      this.project
    )

    return this
  }

  async deleteRepo(): Promise<GitApi> {
    const api = await this.getGitApi()

    const repoInfo: GitRepo = await this.getRepoInfo();

    return await api
      .deleteRepository(repoInfo.id, this.project)
      .then(() => {
        const url = this.url.replace(new RegExp('(.*)/.*', 'g'), '$1')

        return this.getRepoApi({url})
      })
  }

  async getRepoInfo(): Promise<GitRepo> {
    const api = await this.getGitApi()

    const extractSlug = (remoteUrl: string) => {
      return remoteUrl.replace(new RegExp(`https://.*${this.host}/`), '')
    }

    const extractUrl = (remoteUrl: string) => {
      return `https://${this.host}/${extractSlug(remoteUrl)}`
    }

    return await api
      .getRepository(this.repo, this.project)
      .then(result => ({
        id: result.id,
        slug: extractSlug(result.remoteUrl),
        http_url: extractUrl(result.remoteUrl),
        name: result.name,
        description: '',
        is_private: false,
        default_branch: result.defaultBranch.replace('refs/heads/', '')
      }))
  }

  async createPullRequest(options: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {
    const api = await this.getGitApi()

    return api
      .createPullRequest(
        {
          isDraft: options.draft,
          sourceRefName: `refs/heads/${options.sourceBranch}`,
          targetRefName: `refs/heads/${options.targetBranch}`,
          title: options.title,
        },
        this.repo,
        this.project
      )
      .then(res => {
        const pr: PullRequest = {
          pullNumber: res.pullRequestId,
          status: this.mapPullRequestStatus(res.status, res.mergeStatus),
          sourceBranch: options.sourceBranch,
          targetBranch: options.targetBranch,
          mergeStatus: mapMergeStatus(res.mergeStatus),
          hasConflicts: false,
        }
        return pr
      })
  }

  async deleteBranch(options: DeleteBranchOptions): Promise<string> {
    throw new Error('Not implemented: deleteBranch')
  }

  async getBranches(): Promise<GitBranch[]> {
    const api = await this.getGitApi()

    return api
      .getBranches(this.repo, this.project)
      .then(result => result.map(ref => ({
        name: ref.name
      })))
  }

  async getDefaultBranch(): Promise<string> {
    const api = await this.getGitApi()

    return await api
      .getRepository(this.repo, this.project)
      .then(result => result.defaultBranch)
  }

  mapPullRequestStatus(status: PullRequestStatus, mergeStatus: PullRequestAsyncStatus): CommonPullRequestStatus {
    switch (status) {
      case PullRequestStatus.NotSet:
        return CommonPullRequestStatus.NotSet
      case PullRequestStatus.Active:
        switch (mergeStatus) {
          case PullRequestAsyncStatus.RejectedByPolicy:
            return CommonPullRequestStatus.Blocked
          case PullRequestAsyncStatus.Conflicts:
            return CommonPullRequestStatus.Conflicts
          default:
            return CommonPullRequestStatus.Active
        }
      case PullRequestStatus.Abandoned:
        return CommonPullRequestStatus.Abandoned
      case PullRequestStatus.Completed:
        return CommonPullRequestStatus.Completed
      default:
        return CommonPullRequestStatus.NotSet
    }
  }

  async getPullRequest(options: GetPullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {
    const pullNumber = options.pullNumber

    const api = await this.getGitApi()

    return api
      .getPullRequest(this.repo, pullNumber, this.project)
      .then(result => {
        const pr: PullRequest = {
          pullNumber,
          status: this.mapPullRequestStatus(result.status, result.mergeStatus),
          sourceBranch: result.sourceRefName.replace('refs/heads/', ''),
          targetBranch: result.targetRefName.replace('refs/heads/', ''),
          mergeStatus: mapMergeStatus(result.mergeStatus),
          hasConflicts: result.mergeStatus === PullRequestAsyncStatus.Conflicts
        }
        return pr
      })
  }

  async mergePullRequestInternal(options: MergePullRequestOptions): Promise<string> {
    const api = await this.getGitApi()

    const lastMergeSourceCommit = await api
      .getPullRequest(this.repo, options.pullNumber, this.project)
      .then(result => result.lastMergeSourceCommit.commitId)

    return api
      .updatePullRequest(
        {
          lastMergeSourceCommit: {
            commitId: lastMergeSourceCommit
          },
          completionOptions: {
            bypassPolicy: true,
            mergeStrategy: mapMergeMethod(options.method),
            deleteSourceBranch: options.delete_branch_after_merge,
          },
          status: PullRequestStatus.Completed
        },
        this.repo,
        options.pullNumber,
        this.project
      )
      .then(async result => {
        // sleep here to prevent a timing issue between the pull request and pull request conflict apis
        await sleep(500)

        const conflicts = await api.getPullRequestConflicts(this.repo, options.pullNumber, this.project)

        if (conflicts.length > 0) {
          throw new MergeConflict(options.pullNumber)
        }

        return result.mergeId
      })
      .catch(err => {
        this.logger.debug('Error merging pull request: ', err)
        throw err
      }) as Promise<string>
  }

  async updatePullRequestBranch(options: UpdatePullRequestBranchOptions, retryHandler?: EvaluateErrorForRetry): Promise<string> {
    const {sourceBranch, targetBranch} = await this.getPullRequest(options)

    return this
      .rebaseBranch({sourceBranch, targetBranch})
      .then(() => 'Updated')
  }

  async getWebhooks(): Promise<Webhook[]> {
    const api = await this.getGitApi()

    const {repository} =  await api
      .getRepository(this.repo, this.project)
      .then(result => ({
        repository: result.id
      }))

    const matchRepository = (repo: string) => {
      return (hook): boolean => hook.publisherInputs?.repository === repo
    }

    const azureSubscriptionToWebhook = (hook): Webhook => {
      const webhook: Webhook = {
        id: hook.id,
        name: hook.eventDescription,
        active: hook.status === 'enabled',
        events: [hook.eventType],
        config: {
          content_type: 'json',
          url: hook.consumerInputs.url,
          insecure_ssl: (hook.consumerInputs.acceptUntrustedCerts == 'true' ? GitHookUrlVerification.performed : GitHookUrlVerification.notPerformed) as any
        }
      }

      return webhook
    }

    return get(`https://${this.host}/${this.owner}/_apis/hooks/subscriptions?api-version=6.0`)
      .auth(this.username, this.password)
      .then(res => res.body.value
        .filter(matchRepository(repository))
        .map(azureSubscriptionToWebhook)
      ) as Promise<Webhook[]>
  }

  async createWebhook(options: CreateWebhook): Promise<string> {
    const api = await this.getGitApi()

    const {projectId, repository} =  await api
      .getRepository(this.repo, this.project)
      .then(result => ({
        projectId: result.project.id,
        repository: result.id
      }))

    return post(`https://${this.host}/${this.owner}/_apis/hooks/subscriptions?api-version=6.0`)
      .auth(this.username, this.password)
      .send({
        publisherId: 'tfs',
        resourceVersion: '1.0',
        eventType: 'git.push',
        eventDescription: `Push to ${this.repo}`,
        consumerId: 'webHooks',
        consumerActionId: 'httpRequest',
        actionDescription: `To url ${options.webhookUrl}`,
        publisherInputs: {
          branch: '',
          pushedBy: '',
          projectId,
          repository
        },
        consumerInputs: {
          url: options.webhookUrl
        }
      })
      .then(res => res.body.id) as Promise<string>
  }

  getEventName(eventId: GitEvent): string {
    switch (eventId) {
      case GitEvent.PUSH:
        return 'git.push'
      default:
        throw new Error('Unknown event type: ' + eventId)
    }
  }

  async getFileContents(fileDescriptor: { path: string; url?: string }): Promise<string | Buffer> {
    throw new Error('method not implemented: getFileContents')
  }

  getHeader(headerId: GitHeader): string {
    return '';
  }

  getRef(): string {
    return '';
  }

  getRefPath(): string {
    return '';
  }

  getRepositoryNamePath(): string {
    return '';
  }

  getRepositoryUrlPath(): string {
    return '';
  }

  getRevisionPath(): string {
    return '';
  }

  async listFiles(): Promise<Array<{ path: string; url?: string }>> {
    throw new Error('method not implemented: listFiles')
  }
}
