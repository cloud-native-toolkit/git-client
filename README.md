# Git client

SDK to interact with different git servers using a consistent api.

## Usage

The SDK will determine the type of repo given the url to the server and return a `GitApi` instance that implements the apis for that server. The url can point to a specific repository or to an organization.

The api can be loaded using the `apiFromUrl` helper function:

```javascript
import {apiFromUrl} from 'git-client'

const api: GitApi = apiFromUrl('https://github.com/org/repo', {username, password})
```

From there, any of the implemented apis can be called. For example:

```javascript
api.createWebhook({webhookUrl: 'https://webhook'})
```

### Provided CLI commands

#### create

Creates a git repo from the provided information

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu create my-repo -h github.com
```

To create the repo in a different org, include the `-o` flag

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu create my-repo -h github.com -o myorg
```

#### exists

Checks if a given repo exists and return some information about it.

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu exists https://github.com/myuser/my-repo
```

or you can check for the repo using the parts of the url

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu exists my-repo -h github.com
```

#### delete

Deletes the provided repo

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu delete https://github.com/myuser/my-repo
```

or you can delete the repo using the parts of the url

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu delete my-repo -h github.com
```

#### clone

Clones the repository, handling the credentials and the name and email config

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu clone https://github.com/myuser/my-repo
```

or you can clone the repo using the parts of the url

```shell
export GIT_USERNAME="myuser"
export GIT_TOKEN="xxx"
gitu clone my-repo -h github.com
```

### Provided APIs

The exposed APIs are defined in `lib/git.api.ts` in the `GitApi` abstract class. The available API functions are:

- `createRepo()` - creates a repository in the org
- `deleteRepo()` - deletes the repository
- `getWebhooks()` - list the defined webhooks
- `createWebhook()` - create a webhook on the repository
- `deleteBranch()` - deletes a branch in the repository
- `rebaseBranch()` - rebases a branch on top of another one in the repository
- `getPullRequest()` - retrieves a pull request from the repository
- `createPullRequest()` - creates a pull request in the repository for a given branch
- `mergePullRequest()` - merges the given pull request
- `updateAndMergePullRequest()` - updates the pull request with the latest from the target branch and merges it
- `updatePullRequestBranch()` - updates the pull request with the latest from the target branch
- `clone()` - clones the repository to the local file system

### Command-line

The library can also be accessed from the command-line as a series of commands. The cli can either be accessed by installing the module globally or by downloading the appropriate binary for your environment. Currently, two commands are available:

#### create repo

`gitu create [repo] -h host -o org -u username`

#### delete repo

`gitu delete repoUrl`

## Testing

The repository provides unit tests and integration tests. The unit tests can be run independently of any Git hosts. The integration tests require configuration, including credentials, in order to run.

### Unit tests

To execute the unit tests, run the following:

```shell
npm test
```

### Integration tests

The integration test runner will execute any files that match the pattern `*.ispec.ts`. To run the integration tests:

1. Copy `.env.template` to `.env` and provide values for the environment variables for the repositories you want to test. If environment variables are missing for a type of repository then it will be skipped (or you can skip testing a type of repository by setting XXX_SKIP="true")
2. Run the following command:

    ```shell
    npm run test:integration
    ```
   
**Note:** The integration tests will create a repository, execute some APIs, then delete the repository. The Personal Access Token provided for the `XXX_PASSWORD` environment variable needs to have enough permission to delete the repo.

## Notes

- clone {url} [{path}] (include name and email config)
- pr create
- pr merge
- pr get
