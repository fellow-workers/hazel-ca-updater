const assert = require('assert')

function pickAsset(assets, platform) {
  if (!assets || assets.length === 0) return null
  if (platform === 'win32') return assets.find(a => /\.exe$/i.test(a.name)) || assets.find(a => /\.zip$/i.test(a.name)) || assets[0]
  if (platform === 'darwin') {
    return assets.find(a => /\.zip$/i.test(a.name)) || assets.find(a => /\.dmg$/i.test(a.name)) || assets.find(a => /\.pkg$/i.test(a.name)) || assets[0]
  }
  if (platform === 'linux') return assets.find(a => /\.(AppImage|deb|rpm)$/i.test(a.name)) || assets[0]
  return assets[0]
}

// Test 1: both dmg and zip present (dmg listed first) -> should pick zip
const assets1 = [ { name: 'App-1.0.0.dmg' }, { name: 'App-1.0.0.zip' } ]
const picked1 = pickAsset(assets1, 'darwin')
console.log('picked1:', picked1.name)
assert.strictEqual(picked1.name, 'App-1.0.0.zip')

// Test 2: only dmg present -> pick dmg
const assets2 = [ { name: 'App-1.0.0.dmg' } ]
const picked2 = pickAsset(assets2, 'darwin')
console.log('picked2:', picked2.name)
assert.strictEqual(picked2.name, 'App-1.0.0.dmg')

// Test 3: zip present among others -> pick zip
const assets3 = [ { name: 'something.pkg' }, { name: 'App-1.0.0.zip' }, { name: 'App-1.0.0.dmg' } ]
const picked3 = pickAsset(assets3, 'darwin')
console.log('picked3:', picked3.name)
assert.strictEqual(picked3.name, 'App-1.0.0.zip')

console.log('All pick-asset tests passed')
