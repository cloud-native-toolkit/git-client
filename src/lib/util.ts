import * as _ from 'lodash';
import {get, Response} from 'superagent';

import {AuthGitRepoConfig, GitHost, GitRepoConfig, InvalidGitUrl, TypedGitRepoConfig} from './git.model';
import {Github, GithubEnterprise} from './github';
import {Gitlab} from './gitlab';
import {Gogs} from './gogs';
import {Gitea} from './gitea';
import {Bitbucket} from './bitbucket';
import {GitApi} from './git.api';
import {AzureDevops} from './azure-devops';

const GIT_URL_PATTERNS = {
  'http': '(https{0,1})://([^/]*)/([^/]*)/{0,1}([^#]*)#{0,1}(.*)',
  'git@': '(git@)(.*):(.*)/([^#]*)#{0,1}(.*)'
};

const API_FACTORIES = [
  {key: GitHost.github, value: Github},
  {key: GitHost.ghe, value: GithubEnterprise},
  {key: GitHost.gitlab, value: Gitlab},
  {key: GitHost.gogs, value: Gogs},
  {key: GitHost.bitbucket, value: Bitbucket},
  {key: GitHost.gitea, value: Gitea},
  {key: GitHost.azure, value: AzureDevops}
].reduce((result: {[key: string]: any}, current: {key: GitHost, value: any}) => {
  result[current.key] = current.value;

  return result;
}, {})


export async function apiFromPartialConfig({host, org, repo, branch}: {host: string, org: string, repo?: string, branch?: string}, credentials: {username: string, password: string}): Promise<GitApi> {
  const url = repo ? `https://${host}/${org}/${repo}` : `https://${host}/${org}`

  return apiFromUrl(url, credentials, branch)
}

export async function apiFromUrl(repoUrl: string, credentials: {username: string, password: string}, branch?: string): Promise<GitApi> {
  const config: TypedGitRepoConfig = await gitRepoConfigFromUrl(repoUrl, credentials, branch);

  return apiFromConfig(config);
}

export function apiFromConfig(config: TypedGitRepoConfig): GitApi {
  return new API_FACTORIES[config.type](config);
}

export async function gitRepoConfigFromUrl(repoUrl: string, credentials: {username: string, password: string}, branch = 'master'): Promise<TypedGitRepoConfig> {
  const originalConfig: AuthGitRepoConfig = Object.assign({}, parseGitUrl(repoUrl), _.pick(credentials, ['username', 'password']), {branch}) as any;

  const {type, config} = await getGitRepoType(originalConfig);

  return Object.assign({}, config, {type}) as any;
}

type RepoTypeResultBuilderType = (gitHost: GitHost, config?: AuthGitRepoConfig) => RepoTypeResult

const repoTypeResultBuilder = (config: AuthGitRepoConfig): RepoTypeResultBuilderType => {
  return (type: GitHost, updatedConfig: AuthGitRepoConfig) => {
    return {config: updatedConfig || config, type}
  }
}

interface RepoTypeResult {
  type: GitHost;
  config: AuthGitRepoConfig;
}

const updateAzureRepoConfig = (config: AuthGitRepoConfig): AuthGitRepoConfig => {
  if (!config.repo) {
    return config
  }

  const azureRegex = new RegExp('([^/]+)/_git/(.*)')
  const result = azureRegex.exec(config.repo)
  if (result && result.length > 2) {
    const project: string = result[1]
    const repo: string = result[2]

    return Object.assign({}, config, {project, repo})
  } else {
    return Object.assign({}, config, {project: config.repo, repo: undefined})
  }
}

async function getGitRepoType(config: AuthGitRepoConfig): Promise<RepoTypeResult> {
  const builder: RepoTypeResultBuilderType = repoTypeResultBuilder(config)

  if (config.host === 'github.com') {
    return builder(GitHost.github);
  }

  if (config.host === 'bitbucket.org') {
    return builder(GitHost.bitbucket);
  }

  if (config.host === 'dev.azure.com') {
    return builder(GitHost.azure, updateAzureRepoConfig(config));
  }

  if (await hasHeader(`${config.protocol}://${config.host}/api/v3`, 'X-GitHub-Enterprise-Version', config)) {
    return builder(GitHost.ghe);
  }

  if (await hasBody(`${config.protocol}://${config.host}/api/v4/projects`, config)) {
    return builder(GitHost.gitlab);
  }

  if (await hasBody(`${config.protocol}://${config.host}/api/v1/settings/api`, config)) {
    return builder(GitHost.gitea);
  }

  if (await hasBody(`${config.protocol}://${config.host}/api/v1/users/${config.username}`, config)) {
    return builder(GitHost.gogs);
  }

  throw new Error('Unable to identify Git host type: ' + config.url);
}

async function hasHeader(url: string, header: string, {username, password}: {username: string, password: string}): Promise<boolean> {
  try {
    const response: Response = await get(url).auth(username, password);

    const value = response.header[header] || response.header[header.toLowerCase()];

    return !!value;
  } catch (err) {
    return false;
  }
}

async function hasBody(url: string, {username, password}: {username: string, password: string}): Promise<boolean> {
  try {
    const response: Response = await get(url).auth(username, password);

    const result = response.body;

    return !!result;
  } catch (err) {
    return false;
  }
}

export function parseGitUrl(url: string): GitRepoConfig {
  const pattern = GIT_URL_PATTERNS[url.substring(0, 4)];

  if (!pattern) {
    throw new InvalidGitUrl(url);
  }

  const results = new RegExp(pattern, 'gi').exec(url);

  if (!results || results.length < 4) {
    throw new InvalidGitUrl(url);
  }

  const protocol = results[1] === 'git@' ? 'https' : results[1];
  const {host, username, password} = parseRepoHost(results[2]);
  const owner = results[3];
  const repo = parseRepoName(results[4]);
  const branch = parseBranch(results[5]);

  return Object.assign({
      url: buildGitUrl(protocol, host, owner, repo),
      protocol,
      host,
      owner,
    },
    repo ? {repo} : {},
    branch ? {branch}: {},
    username ? {username} : {},
    password ? {password} : {},
  );
}

function buildGitUrl(protocol: string, host: string, owner: string, repo?: string): string {
  if (repo) {
    return `${protocol}://${host}/${owner}/${repo}.git`
  }

  return `${protocol}://${host}/${owner}`
}

function parseRepoHost(host: string): {host: string, username?: string, password?: string} {
  if (!/.*@.*/.test(host)) {
    return {host};
  }

  const results = host.split('@');
  host = results[1];
  const credentials = results[0].split(':');
  const username = credentials[0];
  const password = credentials.length > 1 ? credentials[1] : '';

  return {host, username, password};
}

function parseRepoName(repo: string): string {
  if (!repo.endsWith('.git')) {
    return repo;
  }

  return repo.replace(/[.]git$/, '');
}

function parseBranch(branch: string): string | undefined {
  if (branch) {
    return branch;
  }

  return undefined;
}
