const hazel = require('hazel-server')
const { resolveHazelConfig } = require('../lib/hazelConfig')

const config = resolveHazelConfig()

function stripPrefix(url, prefix) {
  if (!url) return '/'
  if (!url.startsWith(prefix)) return url
  const stripped = url.slice(prefix.length)
  return stripped.length === 0 ? '/' : stripped
}

function missingConfigMessage() {
  return [
    'Hazel configuration is missing.',
    '',
    'Set either:',
    '- ACCOUNT and REPOSITORY',
    '  or',
    '- REPO in the form owner/repo',
    '',
    'Optional:',
    '- TOKEN (or GITHUB_TOKEN) for private repos / higher rate limits',
    '- URL (or VERCEL_URL) when TOKEN is set'
  ].join('\n')
}

let handler = null
if (config.account && config.repository) {
  handler = hazel(config)
}

module.exports = (req, res) => {
  if (!handler) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(missingConfigMessage())
    return
  }

  req.url = stripPrefix(req.url, '/api/hazel')
  req.url = stripPrefix(req.url, '/api')

  return handler(req, res)
}
