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

    // create a proxy download URL so clients don't need GH auth
    const baseUrl = process.env.URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://hazel-ca-updater.vercel.app')
    const downloadUrl = platform
      ? `${baseUrl}/download/${platform}?asset=${encodeURIComponent(asset.name)}&tag=${encodeURIComponent(rel.tag_name)}&update=true`
      : asset.browser_download_url

    const latest = {
      version,
      path: downloadUrl,
      files: [{ url: downloadUrl, name: asset.name }],
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

  // Add above serveLatestYmlIfRequested or near top of file:
  async function serveDownloadIfRequested (req, res) {
    const parsed = (req.url || '/').split('?')
    const path = parsed[0]
    if (!path.startsWith('/download')) return false

    try {
      const q = new URL(req.url, 'http://localhost')
      const assetName = q.searchParams.get('asset')
      const tag = q.searchParams.get('tag') // optional
      if (!assetName) {
        res.statusCode = 400
        res.end('Missing asset query param')
        return true
      }

      const repo = process.env.REPO || (process.env.ACCOUNT && process.env.REPOSITORY ? `${process.env.ACCOUNT}/${process.env.REPOSITORY}` : '')
      if (!repo) {
        res.statusCode = 500
        res.end('REPO not configured')
        return true
      }

      const [owner, name] = repo.split('/')
      const token = process.env.TOKEN || process.env.GITHUB_TOKEN

      // get the release (by tag if provided, otherwise latest)
      const releaseUrl = tag
        ? `https://api.github.com/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag)}`
        : `https://api.github.com/repos/${owner}/${name}/releases/latest`

      const relResp = await fetch(releaseUrl, {
        headers: Object.assign({'User-Agent':'hazel-download-proxy'}, token ? { Authorization: `token ${token}` } : {})
      })
      if (!relResp.ok) {
        res.statusCode = relResp.status
        res.end('Release not found')
        return true
      }
      const rel = await relResp.json()
      const asset = (rel.assets || []).find(a => a.name === assetName)
      if (!asset) {
        res.statusCode = 404
        res.end('Asset not found')
        return true
      }

      console.log('Proxying download for', asset.name, 'assetId=', asset.id, 'method=', req.method)

      // Forward method and important headers (Range, User-Agent, If-None-Match)
      const forwardHeaders = {
        'User-Agent': req.headers['user-agent'] || 'hazel-download-proxy',
        Accept: 'application/octet-stream'
      }
      if (req.headers.range) forwardHeaders.Range = req.headers.range
      if (req.headers['if-none-match']) forwardHeaders['If-None-Match'] = req.headers['if-none-match']

      const assetRes = await fetch(
        `https://api.github.com/repos/${owner}/${name}/releases/assets/${asset.id}`,
        {
          method: req.method || 'GET',
          headers: Object.assign(forwardHeaders, token ? { Authorization: `token ${token}` } : {}),
          redirect: 'follow'
        }
      )

      if (!assetRes.ok && assetRes.status !== 206 && assetRes.status !== 200) {
        console.warn('Asset fetch failed', asset.id, assetRes.status, [...assetRes.headers.entries()])
        res.statusCode = assetRes.status
        const bodyText = await assetRes.text().catch(()=>'<no-body>')
        console.warn('Asset fetch body (first 200 chars):', bodyText.slice(0,200))
        res.end(bodyText || `Asset fetch failed ${assetRes.status}`)
        return true
      }

      // copy relevant headers to response
      assetRes.headers.forEach((v,k) => {
        // some headers are safe to forward
        if (['content-type','content-length','content-disposition','accept-ranges','etag','last-modified','content-range'].includes(k.toLowerCase())) {
          res.setHeader(k, v)
        }
      })
      res.statusCode = assetRes.status

      if (req.method === 'HEAD') {
        res.end()
        return true
      }

      const body = assetRes.body

      body.on('error', err => {
        console.error('Error streaming asset body', err && err.message)
        try { res.destroy(err) } catch (e) {}
      })

      res.on('close', () => {
        try { body.destroy() } catch (e) {}
      })

      res.on('error', err => {
        console.error('Client response error', err && err.message)
        try { body.destroy() } catch (e) {}
      })

      // Stream body to client
      body.pipe(res)
      return true} catch (err) {
      console.error('download proxy error', err && err.message)
      res.statusCode = 500
      res.end('Error proxying download')
      return true
    }
  }

  serveDownloadIfRequested(req, res).then(served => {
    if (served) return
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
  })
}
