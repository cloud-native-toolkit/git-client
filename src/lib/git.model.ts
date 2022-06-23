
export enum GitHost {
  github = 'Github',
  gitlab = 'Gitlab',
  ghe = 'GHE',
  gogs = 'Gogs',
  bitbucket = 'Bitbucket',
  gitea = 'Gitea',
  azure = 'Azure DevOps'
}

export interface GitLocalRepoConfig {
  repoDir: string;
  baseDir?: string;
}

export interface GitRepoConfig {
  protocol: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
  branch?: string;
  username?: string;
  password?: string;
}

export interface AuthGitRepoConfig extends GitRepoConfig {
  username: string;
  password: string;
}

export interface TypedGitRepoConfig extends AuthGitRepoConfig {
  type: GitHost;
}

export interface GitHookData {
  name: 'web';
  active: boolean;
  events: GitEvents[];
  config: GitHookConfig;
}

export interface GitHookConfig {
  url: string;
  content_type: GitHookContentType;
  secret?: string;
  insecure_ssl?: GitHookUrlVerification;
}

export enum GitHookContentType {
  json = 'json',
  form = 'form'
}

export enum GitHookUrlVerification {
  performed = '0',
  notPerformed = '1'
}

export enum GitEvents {
  push = 'push',
  pullRequest = 'pull_request'
}

export interface Webhook {
  id: string;
  name: string;
  active: boolean;
  events: string[];
  config: {
    content_type: string;
    url: string;
    insecure_ssl: number;
  }
}

export interface GitRepo {
  id: string;
  slug: string;
  http_url: string;
  name: string;
  description: string;
  is_private: boolean;
}

export enum ErrorType {
  insufficientPermissions = 'insufficientPermissions',
  badCredentials = 'badCredentials',
  userNotFound = 'userNotFound',
  invalidGitUrl = 'invalidGitUrl',
  repoNotFound = 'repoNotFound'
}

export class GitError extends Error {
  protected constructor(public readonly type: ErrorType, message: string, public readonly gitHost: GitHost, public readonly error?: Error) {
    super(message);
  }
}

export const isGitError = (err: any): err is GitError => {
  return !!err && !!(err as GitError).type
}

export class InsufficientPermissions extends GitError {
  constructor(operation: string, gitHost: GitHost, error?: Error) {
    super(ErrorType.insufficientPermissions, `Insufficient permissions for ${operation}`, gitHost, error);
  }
}

export class BadCredentials extends GitError {
  constructor(operation: string, gitHost: GitHost, error?: Error) {
    super(ErrorType.badCredentials, `Bad credentials for ${operation}`, gitHost, error);
  }
}

export class UserNotFound extends GitError {
  constructor(operation: string, gitHost: GitHost, error?: Error) {
    super(ErrorType.userNotFound, `User not found`, gitHost, error);
  }
}

export class InvalidGitUrl extends GitError {
  constructor(context: string, gitHost?: GitHost, error?: Error) {
    super(ErrorType.invalidGitUrl, `Invalid git url: ${context}`, gitHost, error);
  }
}

export class RepoNotFound extends GitError {
  constructor(context: string, gitHost?: GitHost, error?: Error) {
    super(ErrorType.repoNotFound, `Repository not found: ${context}`, gitHost, error);
  }
}
