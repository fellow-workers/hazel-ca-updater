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
  app.get('*', (req, res) => {
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

const fetch = require('node-fetch')
const jsYaml = require('js-yaml')

app.get('/latest.yml', async (req, res) => {
  try {
    const owner = process.env.REPO?.split('/')[0] || process.env.ACCOUNT
    const repo = process.env.REPO?.split('/')[1] || process.env.REPOSITORY
    const token = process.env.TOKEN || process.env.GITHUB_TOKEN

    if (!owner || !repo) return res.status(500).type('text').send('Repo misconfigured')

    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: Object.assign({ 'User-Agent': 'hazel-latest-yml' }, token ? { Authorization: `token ${token}` } : {})
    })
    if (!resp.ok) return res.status(404).send('Not found')

    const rel = await resp.json()
    const version = String(rel.tag_name || '').replace(/^v/, '')
    const published = rel.published_at || rel.created_at || new Date().toISOString()
    // Pick platform assets or fallback to the first asset
    const exe = rel.assets.find(a => /\.exe$/.test(a.name))
    const dmg = rel.assets.find(a => /\.dmg$/.test(a.name))
    const appImage = rel.assets.find(a => /\.AppImage$/.test(a.name))

    // Minimal latest.yml structure - electron-updater accepts version and path
    const latest = {
      version: version,
      releaseDate: published,
      // include files for each platform if present
      files: [
        exe ? { url: exe.browser_download_url, name: exe.name } : undefined,
        dmg ? { url: dmg.browser_download_url, name: dmg.name } : undefined,
        appImage ? { url: appImage.browser_download_url, name: appImage.name } : undefined
      ].filter(Boolean)
    }

    res.type('text/yaml').send(jsYaml.dump(latest))
  } catch (err) {
    res.status(500).send('Error generating latest.yml')
  }
})

app.get('/update/:platform/:version/latest.yml', async (req, res) => {
  try {
    const repo = (process.env.REPO || `${process.env.ACCOUNT}/${process.env.REPOSITORY}`) || ''
    if (!repo) return res.status(500).type('text').send('REPO not configured')

    const [owner, name] = repo.split('/')
    const token = process.env.TOKEN || process.env.GITHUB_TOKEN

    const ghResp = await fetch(`https://api.github.com/repos/${owner}/${name}/releases/latest`, {
      headers: Object.assign({ 'User-Agent': 'hazel-latest-yml' }, token ? { Authorization: `token ${token}` } : {})
    })
    if (!ghResp.ok) return res.status(404).send('Latest release not found')

    const rel = await ghResp.json()
    const version = String(rel.tag_name || '').replace(/^v/, '')
    // choose platform-appropriate asset:
    const platform = req.params.platform
    const pick = (assets, platform) => {
      if (platform === 'win32') return assets.find(a => /\.exe$|\.zip$|setup/i.test(a.name))
      if (platform === 'darwin') return assets.find(a => /\.dmg$|\.zip$|\.pkg/i.test(a.name))
      if (platform === 'linux') return assets.find(a => /\.AppImage$|\.deb$|\.rpm/i.test(a.name))
      return assets[0]
    }
    const asset = pick(rel.assets || [], platform)
    if (!asset) return res.status(404).send('No asset for platform')

    const latest = {
      version: version,
      path: asset.browser_download_url,
      releaseDate: rel.published_at || rel.created_at || new Date().toISOString()
    }
    res.type('text/yaml').send(jsYaml.dump(latest))
  } catch (err) {
    console.error('latest.yml generation error', err)
    res.status(500).send('Error generating latest.yml')
  }
})