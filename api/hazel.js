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

function getRequestBaseUrl(req) {
  const explicit = process.env.URL
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) return explicit
    return `https://${explicit}`
  }

  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const proto = forwardedProto || 'https'
  const forwardedHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || req.headers.host || process.env.VERCEL_URL || 'hazel-ca-updater.vercel.app'
  return `${proto}://${host}`
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || ''))
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
const crypto = require('crypto')

// simple in-memory cache for computed sha512s to avoid re-downloading large assets repeatedly
const sha512Cache = new Map()
const SHA512_CACHE_TTL_MS = 1000 * 60 * 60 // 1 hour

async function serveLatestYmlIfRequested (req, res) {
  // strip query string (electron-updater appends ?noCache=...)
  const path = (req.url || '/').split('?')[0]

  // match /latest.yml OR /latest-*.yml OR /update/:platform/:version/latest(-variant).yml
  const isLatestRoot = /^\/latest(?:-[^\/]+)?\.yml$/.test(path)
  // accept latest.yml or latest-*.yml (e.g. latest-mac.yml, latest-linux.yml)
  const m = path.match(/^\/update\/([^\/]+)\/([^\/]+)\/latest(?:-[^\/]+)?\.yml$/)
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

    // decide whether to proxy downloads through Vercel or point clients
    // directly at the GitHub CDN (browser_download_url). When running on
    // serverless platforms the proxy can cause extra cold starts and FOT
    // traffic; set `DISABLE_DOWNLOAD_PROXY=true` in the environment to
    // have latest.yml point directly to the release asset.
    const disableProxy = String(process.env.DISABLE_DOWNLOAD_PROXY || process.env.NO_PROXY_DOWNLOAD || '').toLowerCase() === 'true'
    const baseUrl = getRequestBaseUrl(req)
    const downloadUrl = disableProxy
      ? asset.browser_download_url
      : (platform
        ? `${baseUrl}/download/${encodePathSegment(platform)}/${encodePathSegment(asset.name)}?tag=${encodeURIComponent(rel.tag_name)}&update=true`
        : asset.browser_download_url)

    const latest = {
      version,
      path: downloadUrl,
      files: [{ url: downloadUrl, name: asset.name }],
      releaseDate: rel.published_at || rel.created_at || new Date().toISOString()
    }

  // Try to include a .sha512 checksum file (if present) and verify against the actual asset
  try {
    const checksumName = `${asset.name}.sha512`
    let checksumAsset = (rel.assets || []).find(a => a.name === checksumName)
    if (!checksumAsset) {
      checksumAsset = (rel.assets || []).find(a => a.name && a.name.toLowerCase().endsWith('.sha512'))
    }

    // helper to compute sha512 of an asset (cached)
    async function computeAssetSha512(asset) {
      if (!asset || !asset.id) return null
      const cacheEntry = sha512Cache.get(asset.id)
      if (cacheEntry && (Date.now() - cacheEntry.ts) < SHA512_CACHE_TTL_MS) return cacheEntry.sha

      const assetApiUrl = `https://api.github.com/repos/${owner}/${name}/releases/assets/${asset.id}`

      const MAX_ATTEMPTS = 3
      const TIMEOUT_MS = 120000 // 2 minutes

      const sleep = ms => new Promise(r => setTimeout(r, ms))

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          console.log(`computeAssetSha512: attempt ${attempt} for asset ${asset.id}`)

          // Ask for redirect location (signed URL) first
          const redirectResp = await fetch(assetApiUrl, {
            method: 'GET',
            headers: Object.assign({ 'User-Agent': 'hazel-sha512-check', Accept: 'application/octet-stream' }, token ? { Authorization: `token ${token}` } : {}),
            redirect: 'manual',
            timeout: TIMEOUT_MS
          })

          const location = redirectResp.headers.get('location')
          if (!location) {
            // fallback: follow redirects and stream
            console.log('computeAssetSha512: no redirect; following redirects')
            const fullResp = await fetch(assetApiUrl, {
              method: 'GET',
              headers: Object.assign({ 'User-Agent': 'hazel-sha512-check', Accept: 'application/octet-stream' }, token ? { Authorization: `token ${token}` } : {}),
              redirect: 'follow',
              timeout: TIMEOUT_MS
            })
            if (!fullResp.ok) throw new Error('Failed to fetch asset for sha512 computation (no redirect)')

            const contentLength = fullResp.headers.get('content-length')
            const h = crypto.createHash('sha512')
            let bytes = 0
            for await (const chunk of fullResp.body) { h.update(chunk); bytes += chunk.length }

            if (contentLength && Number(contentLength) !== bytes) {
              console.warn('computeAssetSha512: truncated download detected (no-redirect)', asset.id, 'content-length=', contentLength, 'bytes=', bytes)
            }

            const sha = h.digest('base64')
            sha512Cache.set(asset.id, { sha, ts: Date.now() })
            return sha
          }

          // fetch the signed URL and stream to compute hash
          console.log('computeAssetSha512: got signed URL', location)
          const signedResp = await fetch(location, { method: 'GET', headers: { Accept: 'application/octet-stream' }, redirect: 'follow', timeout: TIMEOUT_MS })
          if (!signedResp.ok) throw new Error('Failed to fetch signed asset URL for sha512 computation')

          const cl = signedResp.headers.get('content-length')
          const h2 = crypto.createHash('sha512')
          let bytes = 0
          for await (const chunk of signedResp.body) { h2.update(chunk); bytes += chunk.length }

          if (cl && Number(cl) !== bytes) {
            console.warn('computeAssetSha512: truncated download detected (signed URL)', asset.id, 'content-length=', cl, 'bytes=', bytes)
          }

          const sha2 = h2.digest('base64')
          sha512Cache.set(asset.id, { sha: sha2, ts: Date.now() })
          return sha2
        } catch (err) {
          console.warn('Failed to compute sha512 for asset', asset.id, 'attempt', attempt, 'error:', err && err.message)
          if (attempt < MAX_ATTEMPTS) {
            const backoff = Math.pow(2, attempt) * 500
            console.log('Retrying computeAssetSha512 after', backoff, 'ms')
            await sleep(backoff)
            continue
          }
          return null
        }
      }
    }

    let checksumValue = null
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
        checksumValue = (await csRes.text()).replace(/\s+/g, '').trim()
        if (!(/^[A-Za-z0-9+/=]+$/.test(checksumValue) && checksumValue.length === 88)) {
          console.warn('Checksum asset content not valid base64/length for', checksumAsset.name, 'len=' + checksumValue.length)
          checksumValue = null
        }
      }
    } else {
      console.debug('No .sha512 asset found for', asset.name)
    }

    // If a checksum asset is provided, include it immediately and verify in background.
    // If no checksum asset exists, compute synchronously (blocking) so latest.yml contains a sha512.
    if (checksumValue) {
      latest.files[0].sha512 = checksumValue
      console.log('Included provided sha512 for', asset.name)

      // background verification (non-blocking)
      computeAssetSha512(asset).then(c => {
        if (c && c !== checksumValue) {
          console.warn('Checksum mismatch between .sha512 asset and computed value for', asset.name)
          console.warn('  .sha512 asset:', checksumValue)
          console.warn('  computed    :', c)
          // update cache with computed value so future calls will include it
          sha512Cache.set(asset.id, { sha: c, ts: Date.now() })
        }
      }).catch(err => {
        console.warn('Background sha512 verification failed for', asset.id, err && err.message)
      })
    } else {
      const computed = await computeAssetSha512(asset)
      if (computed) {
        latest.files[0].sha512 = computed
        console.log('Included computed sha512 for', asset.name)
      }
    }
  } catch (err) {
    console.error('Error fetching/checking checksum asset', err && err.message)
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

    // Supports:
    // - /download/:platform/:assetName?tag=...
    // - /download/:platform?asset=:assetName&tag=... (legacy)
    const m = path.match(/^\/download\/([^\/]+)(?:\/([^\/]+))?$/)
    const platform = m ? m[1] : null

    try {
      const q = new URL(req.url, 'http://localhost')
      let assetName = null
      if (m && m[2]) {
        try {
          assetName = decodeURIComponent(m[2])
        } catch (e) {
          assetName = m[2]
        }
      } else {
        assetName = q.searchParams.get('asset')
      }
      const tag = q.searchParams.get('tag') // optional
      if (assetName && assetName.includes('/')) {
        // tolerate passing full URLs by taking the basename
        assetName = assetName.split('/').pop()
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

      const pick = (assets, platform) => {
        if (!assets || assets.length === 0) return null
        if (platform === 'win32') return assets.find(a => /\.exe$/i.test(a.name)) || assets.find(a => /\.zip$/i.test(a.name)) || assets[0]
        if (platform === 'darwin') return assets.find(a => /\.(dmg|pkg)$/i.test(a.name)) || assets.find(a => /\.zip$/i.test(a.name)) || assets[0]
        if (platform === 'linux') return assets.find(a => /\.(AppImage|deb|rpm)$/i.test(a.name)) || assets[0]
        return assets[0]
      }

      const assets = rel.assets || []
      let asset = null
      if (assetName) {
        asset = assets.find(a => a.name === assetName)
        if (!asset) {
          const lowered = String(assetName).toLowerCase()
          asset = assets.find(a => String(a.name || '').toLowerCase() === lowered)
        }
      }

      if (!asset) {
        asset = pick(assets, platform)
      }

      if (!asset) {
        res.statusCode = 404
        res.end('Asset not found')
        return true
      }

      console.log(
        `[download] platform=${platform || 'unknown'} requested=${assetName || '(none)'} selected=${asset.name} tag=${rel.tag_name || '(unknown)'}`
      )

      console.log('Proxying download for', asset.name, 'assetId=', asset.id, 'method=', req.method)

      // Forward method and important headers (Range, User-Agent, If-None-Match)
      const forwardHeaders = {
        'User-Agent': req.headers['user-agent'] || 'hazel-download-proxy',
        Accept: 'application/octet-stream'
      }
      if (req.headers.range) forwardHeaders.Range = req.headers.range
      if (req.headers['if-none-match']) forwardHeaders['If-None-Match'] = req.headers['if-none-match']

      // Resolve the actual asset response. If client requested Range or HEAD we
      // first call the GitHub assets API WITHOUT Range and with redirect: 'manual'
      // to get the signed CDN URL, then call that URL with the client's Range/HEAD.
      let assetRes;
      const assetApiUrl = `https://api.github.com/repos/${owner}/${name}/releases/assets/${asset.id}`;

      try {
        // Ask GitHub Assets API for the signed redirect URL (manual redirect)
        const redirectResp = await fetch(assetApiUrl, {
          method: 'GET',
          headers: Object.assign({ 'User-Agent': 'hazel-download-proxy', Accept: 'application/octet-stream' }, token ? { Authorization: `token ${token}` } : {}),
          redirect: 'manual'
        })

        const location = redirectResp.headers.get('location')
        if (location) {
          // Prefer redirecting the client to the signed CDN URL instead of proxying the binary.
          // This prevents Vercel from streaming large files and lets clients download directly.
          console.log('Got signed asset URL, redirecting client to', location)
          res.statusCode = 307
          res.setHeader('Location', location)
          res.end()
          return true
        }

        // No signed Location header — fall back to fetching the asset (follow redirects)
        assetRes = await fetch(assetApiUrl, {
          method: req.method || 'GET',
          headers: Object.assign({ 'User-Agent': req.headers['user-agent'] || 'hazel-download-proxy', Accept: 'application/octet-stream' }, token ? { Authorization: `token ${token}` } : {}),
          redirect: 'follow'
        })
      } catch (err) {
        console.error('Error fetching asset (network):', err && err.message);
        res.statusCode = 502;
        res.end('Error fetching asset');
        return true;
      }

      if (!assetRes.ok && assetRes.status !== 206 && assetRes.status !== 200) {
        console.warn('Asset fetch failed', asset.id, assetRes.status, [...assetRes.headers.entries()]);
        res.statusCode = assetRes.status;
        const bodyText = await assetRes.text().catch(()=>'<no-body>');
        console.warn('Asset fetch body (first 200 chars):', bodyText.slice(0,200));
        res.end(bodyText || `Asset fetch failed ${assetRes.status}`);
        return true;
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

      // track bytes streamed to help diagnose truncated downloads
      let bytes = 0
      body.on('data', chunk => { try { bytes += chunk.length } catch (e) {} })

      body.on('error', err => {
        console.error('Error streaming asset body', err && err.message)
        try { res.destroy(err) } catch (e) {}
      })

      res.on('finish', () => {
        console.log('Download proxy stream finished for', asset.name, 'bytes=', bytes)
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
