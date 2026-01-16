const http = require('http')
const handler = require('../api/hazel')

const PORT = process.env.PORT || 5000

const server = http.createServer((req, res) => {
  // Pass through to the Vercel-like handler
  try {
    handler(req, res)
  } catch (err) {
    console.error('Handler error', err && err.message)
    res.statusCode = 500
    res.end('Handler error')
  }
})

server.listen(PORT, () => {
  console.log(`Local hazel test server running on http://localhost:${PORT}`)
})

process.on('SIGINT', () => {
  console.log('Shutting down')
  server.close(() => process.exit(0))
})
