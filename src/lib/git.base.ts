import {Container} from 'typescript-ioc';

import {LocalGitConfig, GitApi, GitEvent, GitHeader, WebhookParams} from './git.api';
import {GitHost, TypedGitRepoConfig} from './git.model';
import {Logger} from '../util/logger';
import simpleGit, {SimpleGit, SimpleGitOptions} from 'simple-git';

export abstract class GitBase extends GitApi {
  logger: Logger;

  protected constructor(public config: TypedGitRepoConfig) {
    super();

    this.logger = Container.get(Logger);
  }

  async clone(repoDir: string, input: LocalGitConfig): Promise<SimpleGit & {gitApi: GitApi}> {
    const gitOptions: Partial<SimpleGitOptions> = Object
      .keys(input)
      .reduce((result: Partial<SimpleGitOptions>, currentKey: string) => {

        if (currentKey === 'config') {
          result.config = Object.keys(input.config).map(key => `${key}=${input.config[key]}`);
        } else {
          result[currentKey] = input[currentKey];
        }

        return result;
      }, {});

    const git: SimpleGit & {gitApi?: GitApi} = simpleGit(gitOptions);

    // clone into repo dir
    await git.clone(`https://${this.credentials()}@${this.config.repo}`, repoDir);

    await git.cwd({path: repoDir, root: true});

    git.gitApi = this;

    return git as (SimpleGit & {gitApi: GitApi});
  }

  credentials(): string {
    if (this.config.username) {
      return `${this.config.username}:${this.config.password}`;
    }

    return this.config.password;
  }

  getType(): GitHost {
    return this.config.type;
  }

  buildWebhookParams(eventId: GitEvent): WebhookParams {
    return {
      revisionPath: this.getRevisionPath(),
      repositoryUrlPath: this.getRepositoryUrlPath(),
      headerName: this.getHeader(GitHeader.EVENT),
      eventName: this.getEventName(eventId),
      branchName: this.config.branch,
      repositoryNamePath: 'body.repository.full_name',
      repositoryName: `${this.config.owner}/${this.config.repo}`,
      refPath: this.getRefPath(),
      ref: this.getRef(),
    }
  }

  abstract getRefPath(): string;

  abstract getRef(): string;

  abstract getRevisionPath(): string;

  abstract getRepositoryUrlPath(): string;

  abstract getRepositoryNamePath(): string;

  abstract getHeader(headerId: GitHeader): string;

  abstract getEventName(eventId: GitEvent): string;
}

