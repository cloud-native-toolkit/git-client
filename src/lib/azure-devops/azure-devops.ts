import {getPersonalAccessTokenHandler, WebApi} from 'azure-devops-node-api';
import {IGitApi} from 'azure-devops-node-api/GitApi';
import {
  GitCommitRef,
  GitPullRequestMergeStrategy, GitQueryCommitsCriteria,
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
  GitHeader, MergeConflict,
  MergeMethod,
  MergePullRequestOptions,
  PullRequest,
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

  async createRepo({name, privateRepo = false, autoInit = true}: CreateRepoOptions): Promise<GitApi> {
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
      return remoteUrl.replace(`https://${this.host}/`, '')
    }

    return await api
      .getRepository(this.repo, this.project)
      .then(result => ({
        id: result.id,
        slug: extractSlug(result.remoteUrl),
        name: result.name,
        description: '',
        is_private: false
      }))
  }

  async createPullRequest({title, sourceBranch, targetBranch, draft, issue, maintainer_can_modify}: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {
    const api = await this.getGitApi()

    return api
      .createPullRequest(
        {
          isDraft: draft,
          sourceRefName: `refs/heads/${sourceBranch}`,
          targetRefName: `refs/heads/${targetBranch}`,
          title,
        },
        this.repo,
        this.project
      )
      .then(res => ({
        pullNumber: res.pullRequestId,
        sourceBranch,
        targetBranch,
        mergeStatus: mapMergeStatus(res.mergeStatus),
        hasConflicts: false,
      }))
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

  async getPullRequest({pullNumber}: GetPullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest> {
    const api = await this.getGitApi()

    return api
      .getPullRequest(this.repo, pullNumber, this.project)
      .then(result => ({
        pullNumber,
        sourceBranch: result.sourceRefName.replace('refs/heads/', ''),
        targetBranch: result.targetRefName.replace('refs/heads/', ''),
        mergeStatus: mapMergeStatus(result.mergeStatus),
        hasConflicts: result.mergeStatus === PullRequestAsyncStatus.Conflicts
      }))
  }

  async mergePullRequestInternal({pullNumber, method, title, message, delete_branch_after_merge}: MergePullRequestOptions): Promise<string> {
    const api = await this.getGitApi()

    const lastMergeSourceCommit = await api
      .getPullRequest(this.repo, pullNumber, this.project)
      .then(result => result.lastMergeSourceCommit.commitId)

    return api
      .updatePullRequest(
        {
          lastMergeSourceCommit: {
            commitId: lastMergeSourceCommit
          },
          completionOptions: {
            bypassPolicy: true,
            mergeStrategy: mapMergeMethod(method),
            deleteSourceBranch: delete_branch_after_merge,
          },
          status: PullRequestStatus.Completed
        },
        this.repo,
        pullNumber,
        this.project
      )
      .then(async result => {
        // sleep here to prevent a timing issue between the pull request and pull request conflict apis
        await sleep(500)

        const conflicts = await api.getPullRequestConflicts(this.repo, pullNumber, this.project)

        if (conflicts.length > 0) {
          throw new MergeConflict(pullNumber)
        }

        return result.mergeId
      })
      .catch(err => {
        this.logger.debug('Error merging pull request: ', err)
        throw err
      })
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
      return {
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
    }

    return get(`https://${this.host}/${this.owner}/_apis/hooks/subscriptions?api-version=6.0`)
      .auth(this.username, this.password)
      .then(res => res.body.value
        .filter(matchRepository(repository))
        .map(azureSubscriptionToWebhook)
      )
  }

  async createWebhook({webhookUrl}: CreateWebhook): Promise<string> {
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
        actionDescription: `To url ${webhookUrl}`,
        publisherInputs: {
          branch: '',
          pushedBy: '',
          projectId,
          repository
        },
        consumerInputs: {
          url: webhookUrl
        }
      })
      .then(res => res.body.id)
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
    return Promise.resolve(undefined);
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
    return Promise.resolve(undefined);
  }
}
