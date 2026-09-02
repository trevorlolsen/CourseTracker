/** Player iframes embed from the no-cookie host. */
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com'
/**
 * The IFrame API bootstrap is only served from www.youtube.com; the no-cookie
 * host returns 404 for /iframe_api. Loading it from there broke discovery and
 * embedded playback everywhere while the stubbed browser tests kept passing.
 */
const IFRAME_API_URL = 'https://www.youtube.com/iframe_api'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])
const WEB_PROTOCOLS = new Set(['https:', 'http:'])

/**
 * YouTube identifiers are URL-safe base64. Real video IDs are 11 characters
 * and playlist IDs up to ~34; the caps leave room without admitting anything
 * that could mean something to a URL parser or the player.
 */
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isValidVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value)
}

export function isValidPlaylistId(value) {
  return typeof value === 'string' && PLAYLIST_ID_PATTERN.test(value)
}

/**
 * Only https thumbnails on YouTube's image CDNs survive; anything else becomes
 * `undefined`. Nothing renders a stored thumbnailUrl today, but an unvalidated
 * URL from a backup file or an oEmbed response is a trap for whoever adds that
 * <img> later.
 */
export function safeThumbnailUrl(value) {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return undefined
    if (!/(^|\.)(ytimg\.com|ggpht\.com)$/i.test(url.hostname)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

export function parsePlaylistId(raw) {
  try {
    const url = new URL(String(raw).trim())
    if (!WEB_PROTOCOLS.has(url.protocol)) return null
    if (!YOUTUBE_HOSTS.has(url.hostname.toLocaleLowerCase())) return null
    const id = url.searchParams.get('list')?.trim()
    return isValidPlaylistId(id) ? id : null
  } catch {
    return null
  }
}

export function canonicalPlaylistUrl(playlistId) {
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
}

export function canonicalWatchUrl(videoId, playlistId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(playlistId)}`
}

export function thumbnailUrl(videoId) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
}

let iframeApiPromise
export function loadYouTubeIframeApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('YouTube IFrame API requires a browser'))
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (iframeApiPromise) return iframeApiPromise
  const promise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    const script = document.createElement('script')
    let settled = false
    const finish = (callback, { removeScript = false } = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous
      if (removeScript) script.remove?.()
      callback()
    }
    const ready = () => {
      previous?.()
      if (window.YT?.Player) finish(() => resolve(window.YT))
      else finish(() => reject(new Error('YouTube IFrame API did not initialize')), { removeScript: true })
    }
    const timeout = setTimeout(() => finish(() => reject(new Error('YouTube IFrame API timed out')), { removeScript: true }), 10000)
    window.onYouTubeIframeAPIReady = ready
    script.src = IFRAME_API_URL
    script.async = true
    script.onerror = () => finish(() => reject(new Error('Unable to load YouTube IFrame API')), { removeScript: true })
    document.head.appendChild(script)
  })
  iframeApiPromise = promise.catch((error) => {
    iframeApiPromise = undefined
    throw error
  })
  return iframeApiPromise
}

function testAdapter() {
  return globalThis.window?.__COURSETRACKER_TEST_ADAPTER__
}

export async function discoverPlaylist(playlistId) {
  const adapter = testAdapter()
  if (adapter?.discoverPlaylist) return adapter.discoverPlaylist(playlistId)

  const YT = await loadYouTubeIframeApi()
  const host = document.createElement('div')
  Object.assign(host.style, {
    position: 'fixed', left: '-10000px', top: '-10000px', width: '200px', height: '200px', opacity: '0.01', pointerEvents: 'none',
  })
  document.body.appendChild(host)

  let player
  let pollTimer
  try {
    const videoIds = await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (pollTimer) clearTimeout(pollTimer)
        fn()
      }
      const timeout = setTimeout(() => finish(() => reject(new Error('Playlist discovery timed out'))), 15000)
      player = new YT.Player(host, {
        host: EMBED_ORIGIN,
        width: 200,
        height: 200,
        playerVars: {
          listType: 'playlist',
          list: playlistId,
          origin: window.location.origin,
          playsinline: 1,
        },
        events: {
          onReady: ({ target }) => {
            target.cuePlaylist({ listType: 'playlist', list: playlistId })
            const poll = () => {
              const ids = target.getPlaylist?.() ?? []
              if (ids.length > 0) return finish(() => resolve([...ids]))
              pollTimer = setTimeout(poll, 250)
            }
            poll()
          },
          onError: ({ data }) => finish(() => reject(new Error(`Playlist discovery failed with YouTube error ${data}`))),
        },
      })
    })
    return { playlistId, videoIds }
  } finally {
    if (pollTimer) clearTimeout(pollTimer)
    player?.destroy?.()
    host.remove()
  }
}

async function fetchOEmbed(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const endpoint = new URL('https://www.youtube.com/oembed')
    endpoint.searchParams.set('url', url)
    endpoint.searchParams.set('format', 'json')
    const response = await fetch(endpoint, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function enrichPlaylist(playlistId) {
  const adapter = testAdapter()
  if (adapter?.enrichPlaylist) return adapter.enrichPlaylist(playlistId)
  const body = await fetchOEmbed(canonicalPlaylistUrl(playlistId))
  return {
    playlistId,
    title: body?.title,
    authorName: body?.author_name,
  }
}

export async function enrichVideo(videoId) {
  const adapter = testAdapter()
  if (adapter?.enrichVideo) return adapter.enrichVideo(videoId)
  const fallback = { videoId, thumbnailUrl: thumbnailUrl(videoId) }
  const body = await fetchOEmbed(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`)
  if (!body) return fallback
  return {
    videoId,
    title: body.title,
    authorName: body.author_name,
    thumbnailUrl: safeThumbnailUrl(body.thumbnail_url) ?? fallback.thumbnailUrl,
  }
}

export async function mountPlayer(host, { videoId, startSeconds = 0, onSnapshot, onEmbedStatus }) {
  const adapter = testAdapter()
  if (adapter?.mountPlayer) return adapter.mountPlayer(host, { videoId, startSeconds, onSnapshot, onEmbedStatus })

  const YT = await loadYouTubeIframeApi()
  let currentVideoId = videoId
  let currentState = 'cued'
  const player = new YT.Player(host, {
    host: EMBED_ORIGIN,
    width: '100%',
    height: '100%',
    videoId,
    playerVars: { playsinline: 1, origin: window.location.origin, rel: 0 },
    events: {
      onReady: ({ target }) => {
        target.loadVideoById(videoId, Math.max(0, startSeconds || 0))
        onEmbedStatus?.('playable')
      },
      onStateChange: ({ target, data }) => {
        const state = data === YT.PlayerState.PLAYING ? 'playing'
          : data === YT.PlayerState.PAUSED ? 'paused'
            : data === YT.PlayerState.ENDED ? 'ended'
              : 'cued'
        const nextId = target.getVideoData?.().video_id || currentVideoId
        currentVideoId = nextId
        currentState = state
        onSnapshot?.({ videoId: nextId, currentTime: target.getCurrentTime?.() ?? 0, duration: target.getDuration?.() ?? 0, state })
        if (state === 'playing') onEmbedStatus?.('playable')
      },
      onError: ({ data }) => {
        onEmbedStatus?.(data === 101 || data === 150 ? 'restricted' : 'unavailable')
      },
    },
  })

  return {
    load(nextVideoId, nextStart = 0) {
      currentVideoId = nextVideoId
      currentState = 'cued'
      player.loadVideoById(nextVideoId, Math.max(0, nextStart || 0))
    },
    // Reads the live playhead. The autosave loop depends on this, because the
    // IFrame API never emits events during uninterrupted playback.
    snapshot() {
      return {
        videoId: currentVideoId,
        currentTime: player.getCurrentTime?.() ?? 0,
        duration: player.getDuration?.() ?? 0,
        state: currentState,
      }
    },
    destroy() { player.destroy?.() },
  }
}
