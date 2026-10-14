// Same algorithm and default precision as packages/geo-drop/src/geofence.ts
// encodeGeohash; nearby search matches drops by these prefixes.
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

export function encodeGeohash(lat: number, lon: number, precision = 7): string {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180
  let isLon = true, bits = 0, hashVal = 0
  let result = ''
  while (result.length < precision) {
    const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2
    if (isLon) {
      if (lon >= mid) { hashVal = hashVal * 2 + 1; minLon = mid } else { hashVal = hashVal * 2; maxLon = mid }
    } else {
      if (lat >= mid) { hashVal = hashVal * 2 + 1; minLat = mid } else { hashVal = hashVal * 2; maxLat = mid }
    }
    isLon = !isLon
    bits++
    if (bits === 5) {
      result += GEOHASH_BASE32[hashVal]
      bits = 0
      hashVal = 0
    }
  }
  return result
}
