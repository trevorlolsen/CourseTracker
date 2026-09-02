const INITIAL = ['rust-1', 'rust-2', 'rust-3']
const REFRESHED = ['rust-2', 'rust-1', 'rust-4']
const LARGE_PLAYLIST_SIZE = 40
const TITLES = {
  'rust-1': 'Introduction to Rust',
  'rust-2': 'Ownership and Borrowing',
  'rust-3': 'Enums and Pattern Matching',
  'rust-4': 'Traits and Generics',
}

/**
 * Test double for the YouTube IFrame Player API.
 *
 * IMPORTANT: this adapter deliberately models the *real* player's event
 * behaviour. The real API fires onStateChange only on transitions (play,
 * pause, buffer, end); it never ticks while a video plays. So `advanceTime`
 * moves the clock WITHOUT emitting anything, and only `setState` emits.
 *
 * An earlier version emitted a snapshot on demand, which let the app depend on
 * events the real player never sends and hid a bug where the saved resume
 * position never advanced during playback.
 */
export function installE2EAdapter() {
  const calls = new Map()
  let mountSeq = 0
  let playerState = null

  const requirePlayer = () => {
    if (!playerState) throw new Error('No E2E player is mounted')
    return playerState
  }

  const controls = {
    advanceTime(seconds) {
      const state = requirePlayer()
      state.currentTime = Math.max(0, state.currentTime + Number(seconds))
    },
    seekTo(seconds) {
      const state = requirePlayer()
      state.currentTime = Math.max(0, Number(seconds))
    },
    setDuration(seconds) { requirePlayer().duration = Number(seconds) },
    setState(nextState) {
      const state = requirePlayer()
      state.state = nextState
      state.onSnapshot?.({
        videoId: state.videoId,
        currentTime: state.currentTime,
        duration: state.duration,
        state: nextState,
      })
    },
    setEmbedStatus(status) { requirePlayer().onEmbedStatus?.(status) },
    currentPlayer() {
      if (!playerState) return null
      return {
        mountId: playerState.mountId,
        videoId: playerState.videoId,
        startSeconds: playerState.startSeconds,
        currentTime: playerState.currentTime,
        duration: playerState.duration,
        state: playerState.state,
      }
    },
    resetDiscovery() { calls.clear() },
  }

  window.__COURSETRACKER_E2E__ = controls
  window.__COURSETRACKER_TEST_ADAPTER__ = {
    async discoverPlaylist(playlistId) {
      if (playlistId === 'PL_LARGE') {
        return { playlistId, videoIds: Array.from({ length: LARGE_PLAYLIST_SIZE }, (_, i) => `big-${i + 1}`) }
      }
      if (playlistId === 'PL_TRUNCATED') {
        const count = (calls.get(playlistId) ?? 0) + 1
        calls.set(playlistId, count)
        const size = count === 1 ? LARGE_PLAYLIST_SIZE : 4
        return { playlistId, videoIds: Array.from({ length: size }, (_, i) => `big-${i + 1}`) }
      }
      if (playlistId !== 'PL_RUST') throw new Error('Unknown E2E playlist')
      const count = (calls.get(playlistId) ?? 0) + 1
      calls.set(playlistId, count)
      return { playlistId, videoIds: count === 1 ? [...INITIAL] : [...REFRESHED] }
    },
    async enrichPlaylist(playlistId) {
      if (playlistId === 'PL_LARGE' || playlistId === 'PL_TRUNCATED') {
        return { playlistId, title: 'Large Test Playlist', authorName: 'CourseTracker Test Channel' }
      }
      return { playlistId, title: 'Rust Programming Full Course', authorName: 'CourseTracker Test Channel' }
    },
    async enrichVideo(videoId) {
      return {
        videoId,
        title: TITLES[videoId] ?? `Lesson ${videoId}`,
        authorName: 'CourseTracker Test Channel',
        thumbnailUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#472a8c"/><text x="50%" y="50%" fill="white" font-size="28" text-anchor="middle" dominant-baseline="middle">${TITLES[videoId] ?? videoId}</text></svg>`)}`,
      }
    },
    async mountPlayer(host, { videoId, startSeconds = 0, onSnapshot, onEmbedStatus }) {
      mountSeq += 1
      const mountId = mountSeq
      playerState = {
        mountId, videoId, startSeconds, currentTime: startSeconds,
        duration: 100, state: 'cued', onSnapshot, onEmbedStatus,
      }
      host.replaceChildren()
      const panel = document.createElement('div')
      panel.className = 'player-placeholder'
      panel.dataset.testPlayer = 'true'
      panel.dataset.mountId = String(mountId)
      const paint = () => {
        panel.textContent = `Test player · ${TITLES[playerState.videoId] ?? playerState.videoId} · resume ${Math.round(playerState.startSeconds)}s`
      }
      paint()
      host.append(panel)
      onEmbedStatus?.('playable')
      return {
        load(nextVideoId, nextStart = 0) {
          playerState.videoId = nextVideoId
          playerState.startSeconds = nextStart
          playerState.currentTime = nextStart
          playerState.duration = 100
          playerState.state = 'cued'
          paint()
        },
        snapshot() {
          return {
            videoId: playerState.videoId,
            currentTime: playerState.currentTime,
            duration: playerState.duration,
            state: playerState.state,
          }
        },
        destroy() {
          if (playerState?.mountId === mountId) playerState = null
        },
      }
    },
  }
}
