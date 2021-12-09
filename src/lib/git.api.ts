import {SimpleGit, SimpleGitOptions} from 'simple-git';

import {GitHost} from './git.model';
import {EvaluateErrorForRetry} from '../util/retry-with-delay';

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

export interface MergePullRequestOptions extends BaseOptions {
  pullNumber: number;
  method: 'merge' | 'squash' | 'rebase';
  resolver?: MergeResolver;
  title?: string;
  message?: string;
}

export interface UpdateAndMergePullRequestOptions extends MergePullRequestOptions, BaseOptions {
  retryCount?: number;
  userConfig?: GitUserConfig;
}

export interface GetPullRequestOptions extends BaseOptions {
  pullNumber?: number;
}

export interface UpdatePullRequestBranchOptions extends BaseOptions {
  pullNumber?: number;
}

export interface PullRequest {
  pullNumber: number;
  sourceBranch: string;
  targetBranch: string;
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

export interface SimpleGitWithApi extends SimpleGit {
  gitApi: GitApi;
  repoDir: string;
}

export abstract class LocalGitApi {
  abstract listFiles(): Promise<Array<{path: string, url?: string}>>;

  abstract getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer>;

  abstract getDefaultBranch(): Promise<string>;
}

export abstract class GitApi extends LocalGitApi {
  abstract getType(): GitHost;

  abstract createWebhook(request: CreateWebhook): Promise<string>;

  abstract buildWebhookParams(eventId: GitEvent): WebhookParams;

  abstract rebaseBranch(config: {sourceBranch: string, targetBranch: string, resolver?: MergeResolver}, options?: {userConfig?: GitUserConfig}): Promise<boolean>;

  abstract getPullRequest(options: GetPullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest>;

  abstract createPullRequest(options: CreatePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<PullRequest>;

  abstract mergePullRequest(options: MergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string>;

  abstract updateAndMergePullRequest(options: UpdateAndMergePullRequestOptions, retryHandler?: EvaluateErrorForRetry): Promise<string>;

  abstract updatePullRequestBranch(options: UpdatePullRequestBranchOptions, retryHandler?: EvaluateErrorForRetry): Promise<string>;

  abstract clone(repoDir: string, config: LocalGitConfig): Promise<SimpleGitWithApi>;
}
