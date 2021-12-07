import {apiFromUrl, MergeResolver, SimpleGitWithApi} from './lib';
import {SimpleGit} from 'simple-git';
import first from './util/first';
import {addKustomizeResource} from './kustomization.model';
import * as fs from 'fs';
import * as path from 'path';
import {isString} from 'lodash';
import {isError} from './util/error-util';

if (process.argv.length < 5) {
  throw new Error('Usage: GIT_USER={user} GIT_TOKEN={token} test-rebase {url} {sourceBranch} {targetBranch}');
}

if (!process.env.GIT_USER || !process.env.GIT_TOKEN) {
  throw new Error('Provide GIT_USER and GIT_TOKEN environment variables');
}

const input = {
  url: process.argv[2],
  sourceBranch: process.argv[3],
  targetBranch: process.argv[4],
}

const argocdResolver = (applicationPath: string): MergeResolver => {
  return async (git: SimpleGitWithApi, conflicts: string[]): Promise<{resolvedConflicts: string[], conflictErrors: Error[]}> => {
    const kustomizeYamls: string[] = conflicts.filter(f => /.*kustomization.yaml/.test(f));

    const promises: Array<Promise<string | Error>> = kustomizeYamls
      .map(async (kustomizeYaml: string) => {
        await git.raw(['checkout', '--ours', kustomizeYaml]);

        await addKustomizeResource(path.join(git.repoDir, kustomizeYaml), applicationPath);

        return kustomizeYaml;
      })
      .map(p => p.catch(error => error));

    const result: Array<string | Error> = await Promise.all(promises);

    const resolvedConflicts: string[] = result.filter(isString);
    const conflictErrors: Error[] = result.filter(isError);

    return {resolvedConflicts, conflictErrors};
  }
}

const testRebase = async ({url, sourceBranch, targetBranch}: {url: string, sourceBranch: string, targetBranch: string}) => {
  const api = await apiFromUrl(url, {username: process.env.GIT_USER, password: process.env.GIT_TOKEN});

  const result = await api.rebaseBranch({sourceBranch, targetBranch, resolver: argocdResolver('test')});

  return result;
}

testRebase(input)
  .then((result: boolean) => console.log('Branch changed: ' + result))
  .catch(err => console.error(err));
