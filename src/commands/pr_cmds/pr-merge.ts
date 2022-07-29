import {Arguments, Argv} from 'yargs';
import {Container} from 'typescript-ioc';
import {dump} from 'js-yaml';

import {
  apiFromUrl,
  GitApi,
  GitRepo,
  isGitError,
  MergeMethod,
  MergePullRequestOptions,
  unionMergeResolver
} from '../../lib';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostOrgProjectAndBranchFromUrl,
  repoNameToGitUrl
} from '../support/middleware';
import {forAzureDevOpsProject, forCredentials} from '../support/checks';
import {Logger, verboseLoggerFactory} from '../../util/logger';
import {SSLConfig} from '../support/model';
import {defaultBuilder} from '../support/builder';

export const command = 'merge [gitUrl]'
export const aliases = []
export const desc = 'Merges a pull request';
export const builder = (yargs: Argv<any>) => defaultBuilder(yargs)
  .positional('gitUrl', {
    type: 'string',
    description: 'The url of the repo with the pull request. The pullNumber can be specified after the hash - e.g. https://github.com/org/repo#pullNumber',
    demandOption: true
  })
  .option('pullNumber', {
    type: 'number',
    description: 'The pull number for the pull request that will be merged'
  })
  .option('method', {
    type: 'string',
    description: 'The method for merging the pull request',
    options: ['squash', 'merge', 'rebase'],
    default: 'squash'
  })
  .option('title', {
    type: 'string',
    description: 'The title for the merged pull request'
  })
  .option('message', {
    type: 'string',
    description: 'The message for the merged pull request'
  })
  .option('deleteBranch', {
    type: 'boolean',
    description: 'Flag indicating the branch should be deleted after merge'
  })
  .option('host', {
    type: 'string',
    alias: ['h'],
    description: 'The host of the git server for the repo. The value can be provided as a `GIT_HOST` environment variable.'
  })
  .option('owner', {
    type: 'string',
    alias: ['o'],
    description: 'The owner/org for the git repo on the git server. If not provided the value will default to the `username` value.'
  })
  .option('project', {
    type: 'string',
    alias: ['p'],
    description: 'The project within the organization where the repository will be provisioned. The value can be provided as a `GIT_PROJECT` environment variable. (Primarily for Azure DevOps git repositories.)'
  })
  .option('username', {
    type: 'string',
    alias: ['u'],
    description: 'The username used to create the git repository. The value can also be provided via the `GIT_USERNAME` environment variable.'
  })
  .option('token', {
    type: 'string',
    description: 'The token/password used to authenticate the user to the git server. The value can also be provided via the GIT_TOKEN environment variable.',
  })
  .option('waitForBlocked', {
    type: 'string',
    description: 'The amount of time the merge command should wait for blocked PRs to be resolved before failing. The value should be in the format of "1h30m30s" or any combination. If not provided blocked PRs will fail immediately.'
  })
  .option('output', {
    type: 'string',
    choices: ['json', 'yaml', 'text'],
    description: 'Print the output in the specified format. If not provided the information is printed in human readable text.',
    default: 'text'
  })
  .options('debug', {
    type: 'boolean',
    description: 'Display debug information'
  })
  .middleware(parseHostOrgProjectAndBranchFromUrl(), true)
  .middleware(copySourceBranchToPullNumber(), true)
  .middleware(loadFromEnv('username', 'GIT_USERNAME'), true)
  .middleware(loadFromEnv('token', 'GIT_TOKEN'), true)
  .middleware(loadCredentialsFromFile(), true)
  .middleware(defaultOwnerToUsername(), true)
  .middleware(repoNameToGitUrl(), true)
  .check(forCredentials())
  .check(forAzureDevOpsProject())
export const handler =  async (argv: Arguments<MergePullRequestArgs & {debug: boolean, output: 'json' | 'yaml' | 'text'}>) => {

  Container.bind(Logger).factory(verboseLoggerFactory(argv.debug))

  const credentials = {username: argv.username, password: argv.token}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)

    if (argv.output === 'text') {
      console.log('Merging pull request: ', argv.pullNumber)
    }

    const options: MergePullRequestOptions = {
      pullNumber: argv.pullNumber,
      method: argv.method,
      title: argv.title || `Merge pr ${argv.pullNumber}`,
      message: argv.message || '',
      delete_branch_after_merge: argv.deleteBranch,
      rateLimit: false,
      waitForBlocked: argv.waitForBlocked,
      resolver: unionMergeResolver
    }
    const result: string = await repoApi.updateAndMergePullRequest(options)

    switch (argv.output) {
      case 'json':
        console.log(JSON.stringify({pullNumber: argv.pullNumber, result}, null, 2))
        break
      case 'yaml':
        console.log(dump({pullNumber: argv.pullNumber, result}))
        break
      default:
        console.log(`  Pull request successfully merged: ${argv.pullNumber}`)
    }
  } catch (err) {
    let message = ''
    let type;
    if (isGitError(err)) {
      message = err.message
      type = err.type
    } else if (/Authentication failed/.test(err.message)) {
      message = err.message.replace('fatal: ', '')
    } else {
      message = 'Error merging pull request'
    }

    const result = {
      message,
      pullNumber: argv.pullNumber,
      errorType: type
    }

    if (argv.output === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else if (argv.output === 'yaml') {
      console.log(dump(result))
    } else {
      console.log(message)

      if (argv.debug) {
        console.log('Error: ', err)
      }
    }

    process.exit(1)
  }
}

interface MergePullRequestArgs extends SSLConfig {
  pullNumber: number;
  gitUrl: string;
  method: MergeMethod;
  title?: string;
  message?: string;
  deleteBranch?: boolean;
  username: string;
  token: string;
  waitForBlocked?: string;
}

const copySourceBranchToPullNumber = () => {
  return (yargs) => {
    const result: {pullNumber?: string} = {}

    result.pullNumber = yargs.pullNumber || yargs.sourceBranch

    return result
  }
}

const getTargetBranch = async (repoApi: GitApi, targetBranch: string): Promise<string> => {
  if (targetBranch) {
    return targetBranch
  }

  const repoInfo: GitRepo = await repoApi.getRepoInfo()

  return repoInfo.default_branch
}
