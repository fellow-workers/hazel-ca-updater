require('dotenv').config()

const express = require('express')
const hazel = require('hazel-server')
const { resolveHazelConfig } = require('./lib/hazelConfig')

const app = express()

const PORT = Number(process.env.PORT) || 4000

const config = resolveHazelConfig({ port: PORT })

console.log('ACCOUNT:', config.account || '(missing)')
console.log('REPOSITORY:', config.repository || '(missing)')
console.log('TOKEN:', config.token ? '✅ Loaded' : '❌ Missing')
console.log('URL:', config.url || '(not set)')

if (!config.account || !config.repository) {
  app.use((req, res) => {
    res.status(500).type('text').send(
      [
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
    )
  })
} else {
  app.use('/', hazel(config))
}

app.listen(PORT, () => {
  console.log(`Hazel server running on http://localhost:${PORT}`)
})
