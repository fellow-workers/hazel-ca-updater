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

// --- serve latest.yml for electron-updater compatibility ---
const fetch = require('node-fetch') // v2 for CommonJS
const jsYaml = require('js-yaml')

async function serveLatestYmlIfRequested (req, res) {
  // strip query string (electron-updater appends ?noCache=...)
  const path = (req.url || '/').split('?')[0]

  // match /latest.yml OR /update/:platform/:version/latest.yml
  const isLatestRoot = path === '/latest.yml'
  const m = path.match(/^\/update\/([^\/]+)\/([^\/]+)\/latest\.yml$/)
  if (!isLatestRoot && !m) return false

  const platform = m ? m[1] : null

  // get repo config (REPO or ACCOUNT/REPOSITORY)
  const repo = process.env.REPO || (process.env.ACCOUNT && process.env.REPOSITORY ? `${process.env.ACCOUNT}/${process.env.REPOSITORY}` : '')
  if (!repo) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('REPO not configured')
    return true
  }

  try {
    const [owner, name] = repo.split('/')
    const token = process.env.TOKEN || process.env.GITHUB_TOKEN
    const ghResp = await fetch(`https://api.github.com/repos/${owner}/${name}/releases/latest`, {
      headers: Object.assign({ 'User-Agent': 'hazel-latest-yml' }, token ? { Authorization: `token ${token}` } : {})
    })
    if (!ghResp.ok) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Latest release not found')
      return true
    }

    const rel = await ghResp.json()
    const version = String(rel.tag_name || '').replace(/^v/, '')

    const pick = (assets, platform) => {
      if (platform === 'win32') return assets.find(a => /\.(exe|zip)$/i.test(a.name))
      if (platform === 'darwin') return assets.find(a => /\.(dmg|zip|pkg)$/i.test(a.name))
      if (platform === 'linux') return assets.find(a => /\.(AppImage|deb|rpm)$/i.test(a.name))
      return assets[0]
    }

    const asset = pick(rel.assets || [], platform)
    if (!asset) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('No asset for platform')
      return true
    }

    const latest = {
      version,
      path: asset.browser_download_url,
      files: [{ url: asset.browser_download_url, name: asset.name }],
      releaseDate: rel.published_at || rel.created_at || new Date().toISOString()
    }

  // Try to include a .sha512 checksum file (if present)
  try {
    const checksumName = `${asset.name}.sha512`
    let checksumAsset = (rel.assets || []).find(a => a.name === checksumName)
    if (!checksumAsset) {
      checksumAsset = (rel.assets || []).find(a => a.name && a.name.toLowerCase().endsWith('.sha512'))
    }

    if (checksumAsset) {
      console.log(`Attempting to fetch checksum asset id=${checksumAsset.id} name=${checksumAsset.name}`)
      const csRes = await fetch(
        `https://api.github.com/repos/${owner}/${name}/releases/assets/${checksumAsset.id}`,
        {
          headers: Object.assign(
            { 'User-Agent': 'hazel-latest-yml', Accept: 'application/octet-stream' },
            token ? { Authorization: `token ${token}` } : {}
          )
        }
      )

      if (!csRes.ok) {
        console.warn('Checksum fetch failed', checksumAsset.id, csRes.status)
      } else {
        let sha512 = (await csRes.text())
        // sanitize: remove whitespace/newlines, then validate base64 and correct length
        sha512 = sha512.replace(/\s+/g, '').trim()
        if (/^[A-Za-z0-9+/=]+$/.test(sha512) && sha512.length === 88) {
          latest.files[0].sha512 = sha512
          console.log('Included sha512 for', asset.name)
        } else {
          console.warn('Checksum not valid base64/length for', checksumAsset.name, 'len=' + sha512.length, 'sample=' + sha512.slice(0,16))
        }
      }
    } else {
      console.debug('No .sha512 asset found for', asset.name)
    }
  } catch (err) {
    console.error('Error fetching checksum asset', err && err.message)
  }

      res.setHeader('Content-Type', 'text/yaml; charset=utf-8')
      res.end(jsYaml.dump(latest))
      return true
    } catch (err) {
      console.error('latest.yml generation error', err)
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Error generating latest.yml')
      return true
    }
  }

  // Try to serve latest.yml; otherwise fall back to hazel handler
  serveLatestYmlIfRequested(req, res).then(served => {
    if (served) return
    return handler(req, res)
  }).catch(err => {
    console.error('serveLatestYmlIfRequested error', err)
    res.statusCode = 500
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Internal error')
  })
  // --- serve latest.yml for electron-updater compatibility ---
}