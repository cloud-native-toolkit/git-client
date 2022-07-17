import {SimpleGit} from 'simple-git';

import {GitHost, GitRepo, TypedGitRepoConfig, Webhook} from './git.model';
import {EvaluateErrorForRetry} from '../util/retry-with-delay';
import {promises} from 'fs';
import {join} from 'path';
import {isString} from '../util/string-util';
import {isError} from '../util/error-util';
import {Logger} from '../util/logger';
import {Container} from 'typescript-ioc';

export class CreateWebhook {
  jenkinsUrl?: string;
  jenkinsUser?: string;
  jenkinsPassword?: string;
  jobName?: string;
  webhookUrl?: string;
}

export enum CreateWebhookErrorTypes {
  alreadyExists = 'alreadyExists',
  unknown = 'unknown'
}

export class CreateWebhookError extends Error {
  constructor(public readonly errorType: CreateWebhookErrorTypes, message: string, public readonly causedBy?: Error) {
    super(message);
  }
}

export class WebhookAlreadyExists extends CreateWebhookError {
  constructor(message: string, causedBy?: Error) {
    super(CreateWebhookErrorTypes.alreadyExists, message, causedBy);
  }
}

export class UnknownWebhookError extends CreateWebhookError {
  constructor(message: string, causedBy?: Error) {
    super(CreateWebhookErrorTypes.unknown, message, causedBy);
  }
}

export function isCreateWebhookError(error: Error): error is CreateWebhookError {
  return error && !!(error as CreateWebhookError).errorType;
}

export interface WebhookMatchers {
  gitrevision: string;
  gitrepositoryurl: string;
  headerEvent: string;
}

export interface WebhookParams {
  revisionPath: string;
  repositoryUrlPath: string;
  headerName: string;
  eventName: string;
  branchName: string;
  repositoryNamePath: string;
  repositoryName: string;
  refPath: string;
  ref: string;
}

export enum GitHeader {
  EVENT = 'event'
}

export enum GitEvent {
  PUSH = 'push'
}

export interface BaseOptions {
  rateLimit?: boolean;
}

export interface CreatePullRequestOptions extends BaseOptions {
  title: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
  issue?: number;
  maintainer_can_modify?: boolean;
}

export const isConflictErrors = (value: any): value is ConflictErrors => {
  return !!value && !!(value as ConflictErrors).errors;
}

export class ConflictErrors extends Error {
  constructor(public readonly errors: Error[]) {
    super(`Errors resolving conflicts: ${errors.length}`);
  }
}

export const isUnresolvedConflictsError = (value: any): value is UnresolvedConflictsError => {
  return !!value && !!(value as UnresolvedConflictsError).unresolvedConflicts;
}

export class UnresolvedConflictsError extends Error {
  constructor(public readonly unresolvedConflicts: string[]) {
    super('Unable to resolve conflicts: ' + unresolvedConflicts);
  }
}

export type MergeResolver = (git: SimpleGitWithApi, conflicts: string[]) => Promise<{resolvedConflicts: string[], conflictErrors?: Error[]}>;

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergePullRequestOptions extends BaseOptions {
  pullNumber: number;
  method: MergeMethod;
  resolver?: MergeResolver;
  title?: string;
  message?: string;
  userConfig?: GitUserConfig;
  delete_branch_after_merge?: boolean;
  waitForBlocked?: string;
}

export interface UpdateAndMergePullRequestOptions extends MergePullRequestOptions, BaseOptions {
  retryCount?: number;
}

export interface GetPullRequestOptions extends BaseOptions {
  pullNumber?: number;
}

export interface UpdatePullRequestBranchOptions extends BaseOptions {
  pullNumber?: number;
}

export enum PullRequestStatus {
  NotSet = 'notset',
  Active = 'active',
  Abandoned = 'abandoned',
  Completed = 'completed',
  Conflicts = 'conflicts',
  Blocked = 'blocked'
}

export interface PullRequest {
  pullNumber: number;
  sourceBranch: string;
  targetBranch: string;
  status: PullRequestStatus;
  mergeStatus?: string;
  hasConflicts?: boolean;
}

export interface GitBranch {
  name: string;
}

export interface LocalGitConfig {
  baseDir?: string;
  config?: object;
  binary?: string;
  userConfig?: GitUserConfig;
}

export interface GitUserConfig {
  email: string;
  name: string;
}

export class MergeConflict extends Error {
  constructor(public readonly pullNumber: number) {
    super(`Merge conflict for pull request: ${pullNumber}`);
  }
}

export const isMergeConflict = (err: Error): err is MergeConflict => {
  return !!err && !!(err as MergeConflict).pullNumber
}

export interface SimpleGitWithApi extends SimpleGit {
  gitApi: GitApi;
  repoDir: string;
}

export abstract class LocalGitApi {
  abstract listFiles(): Promise<Array<{path: string, url?: string}>>;

  abstract getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer>;

  abstract getDefaultBranch(): Promise<string>;
}

export interface DeleteBranchOptions {
  branch: string;
}

export interface CreateRepoOptions {
  name: string;
  autoInit?: boolean;
  privateRepo?: boolean;
}

export abstract class GitApi<T extends TypedGitRepoConfig = TypedGitRepoConfig> extends LocalGitApi {
  abstract getType(): GitHost;

  abstract getConfig(): T;

  abstract getWebhooks(): Promise<Webhook[]>;

  abstract createWebhook(request: CreateWebhook): Promise<string>;

  abstract buildWebhookParams(eventId: GitEvent): WebhookParams;

  abstract getBranches(): Promise<GitBranch[]>;

  abstract deleteBranch(options: DeleteBranchOptions): Promise<string>;

  abstract rebaseBranch(config: {sourceBranch: string, targetBranch: string, resolver?: MergeResolver}, options?: {userConfig?: GitUserConfig}): Promise<boolean>;

  abstract getPullRequest(options: GetPullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest>;

  abstract createPullRequest(options: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest>;

  abstract mergePullRequest(options: MergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string>;

  abstract updateAndMergePullRequest(options: UpdateAndMergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string>;

  abstract updatePullRequestBranch(options: UpdatePullRequestBranchOptions, retryHandler?: EvaluateErrorForRetry): Promise<string>;

  abstract clone(repoDir: string, config: LocalGitConfig): Promise<SimpleGitWithApi>;

  abstract createRepo(options: CreateRepoOptions): Promise<GitApi>;

  abstract deleteRepo(): Promise<GitApi>;

  abstract listRepos(): Promise<string[]>;

  abstract getRepoInfo(): Promise<GitRepo>;
}

export const unionMergeResolver: MergeResolver = async (git: SimpleGitWithApi, conflicts: string[]): Promise<{resolvedConflicts: string[], conflictErrors?: Error[]}> => {
  const logger: Logger = Container.get(Logger)

  const processConflictFile = async (conflictFile: string): Promise<string> => {
    logger.debug('Processing conflict: ', conflictFile)

    const commonResult: string = await (git.raw(['show', `:1:${conflictFile}`]) as Promise<string>)
    const oursResult: string = await (git.raw(['show', `:2:${conflictFile}`]) as Promise<string>)
    const theirsResult: string = await (git.raw(['show', `:3:${conflictFile}`]) as Promise<string>)

    logger.debug(`Common result: ${commonResult.toString()}`)
    logger.debug(`Ours result: ${oursResult.toString()}`)
    logger.debug(`Theirs result: ${theirsResult.toString()}`)

    const commonFile = 'tmp.common'
    const oursFile = 'tmp.ours';
    const theirsFile = 'tmp.theirs';

    await promises.writeFile(join(git.repoDir, commonFile), commonResult.toString())
    await promises.writeFile(join(git.repoDir, oursFile), oursResult.toString())
    await promises.writeFile(join(git.repoDir, theirsFile), theirsResult.toString())

    const mergeResult: string = await (git.raw([`merge-file`, '--union', '-p', `./${oursFile}`, `./${commonFile}`, `./${theirsFile}`]) as Promise<string>)

    logger.debug(`Merge result: ${mergeResult.toString()}`)
    await promises.writeFile(join(git.repoDir, conflictFile), mergeResult.toString())

    await promises.unlink(join(git.repoDir, commonFile))
    await promises.unlink(join(git.repoDir, oursFile))
    await promises.unlink(join(git.repoDir, theirsFile))

    return conflictFile;
  }

  const result: Array<string | Error> = []
  for (let i = 0; i < conflicts.length; i++) {
    result.push(await processConflictFile(conflicts[i]).catch(err => err))
  }

  const resolvedConflicts: string[] = result.filter(isString);
  const conflictErrors: Error[] = result.filter(isError);

  return {resolvedConflicts, conflictErrors};
}
