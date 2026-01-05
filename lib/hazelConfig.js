function normalizeBaseUrl(rawUrl) {
  if (!rawUrl) return undefined
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl
  return `https://${rawUrl}`
}

function resolveAccountAndRepository(env) {
  const account = env.ACCOUNT
  const repository = env.REPOSITORY

  if (account && repository) return { account, repository }

  const repo = env.REPO
  if (repo && repo.includes('/')) {
    const [accountFromRepo, repositoryFromRepo] = repo.split('/', 2)
    if (accountFromRepo && repositoryFromRepo) {
      return { account: accountFromRepo, repository: repositoryFromRepo }
    }
  }

  return { account, repository }
}

function resolveHazelConfig({ env = process.env, port } = {}) {
  const { account, repository } = resolveAccountAndRepository(env)
  const token = env.TOKEN || env.GITHUB_TOKEN

  const url = token
    ? (normalizeBaseUrl(env.URL) ||
        normalizeBaseUrl(env.VERCEL_URL) ||
        (port ? `http://localhost:${port}` : undefined))
    : undefined

  return {
    interval: env.INTERVAL,
    account,
    repository,
    pre: env.PRE,
    token,
    url
  }
}

module.exports = {
  resolveHazelConfig
}
