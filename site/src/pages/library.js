import { buildLibraryViewModel } from '../view-models.js'
import { button, createEmptyState, h, progressBar, reconcileList, setClass, setText, thumbnailImg } from '../dom.js'

/**
 * Built once, patched in place. The search box in particular must be a stable
 * node: rebuilding it on every keystroke destroys focus and the caret, which
 * made search accept only a single character.
 */
export async function renderLibraryPage(container, { store }) {
  const { courses, videosByCourseId } = await store.listCoursesWithVideos()
  const state = { query: '', selectedTags: [], status: 'all', sort: 'recent' }
  let destroyed = false

  if (courses.length === 0) {
    container.replaceChildren(h('main', { className: 'page' },
      header(),
      createEmptyState(
        'Add your first YouTube course',
        'Paste a public YouTube playlist. CourseTracker will keep your progress, tags, and resume position in this browser.',
        'Add a playlist', '#/add')))
    return { destroy() { destroyed = true } }
  }

  const search = h('input', {
    className: 'input', type: 'search', placeholder: 'Search courses, authors, or tags…',
    'aria-label': 'Search courses',
  })
  const status = h('select', { className: 'select', 'aria-label': 'Course status' },
    h('option', { value: 'all', text: 'All statuses' }),
    h('option', { value: 'in-progress', text: 'In progress' }),
    h('option', { value: 'completed', text: 'Completed' }))
  const sort = h('select', { className: 'select', 'aria-label': 'Sort courses' },
    h('option', { value: 'recent', text: 'Recently active' }),
    h('option', { value: 'title', text: 'Title' }),
    h('option', { value: 'progress', text: 'Progress' }))

  search.addEventListener('input', () => { state.query = search.value; update() })
  status.addEventListener('change', () => { state.status = status.value; update() })
  sort.addEventListener('change', () => { state.sort = sort.value; update() })

  const continueHeading = h('div', { className: 'heading-row' },
    h('h2', { text: 'Continue Learning' }),
    h('span', { className: 'small muted', text: 'Recent incomplete courses' }))
  const continueGrid = h('section', { className: 'continue-grid', 'aria-label': 'Continue Learning' })
  const shownCount = h('span', { className: 'small muted' })
  const filterTags = h('div', { className: 'filter-tags', 'aria-label': 'Filter by tags' })
  const courseList = h('section', { className: 'course-list', 'aria-label': 'All courses' })
  const noMatches = createEmptyState('No courses match', 'Try clearing a search term or tag filter.')

  const page = h('main', { className: 'page' },
    header(),
    continueHeading, continueGrid,
    h('div', { className: 'heading-row' }, h('h2', { text: 'All Courses' }), shownCount),
    h('section', { className: 'library-tools' }, h('div', { className: 'search-wrap' }, search), status, sort),
    filterTags, courseList, noMatches)

  container.replaceChildren(page)
  update()
  return { destroy() { destroyed = true } }

  function header() {
    return h('div', { className: 'page-header' },
      h('div', {},
        h('div', { className: 'eyebrow', text: 'Your learning dashboard' }),
        h('h1', { text: 'CourseTracker' }),
        h('p', { text: 'Jump between YouTube courses and pick up exactly where you left off.' })),
      h('a', { className: 'button button--primary', href: '#/add', text: '+ Add course' }))
  }

  function update() {
    if (destroyed) return
    const model = buildLibraryViewModel(courses, videosByCourseId, state)

    const hasContinue = model.continueCourses.length > 0
    continueHeading.hidden = !hasContinue
    continueGrid.hidden = !hasContinue
    reconcileList(continueGrid, model.continueCourses, (card) => card.course.id, createContinueCard, updateContinueCard)

    setText(shownCount, `${model.allCourses.length} shown`)

    filterTags.hidden = model.allTags.length === 0
    reconcileList(filterTags, model.allTags, (tag) => tag.toLocaleLowerCase(),
      (tag) => {
        const chip = button(tag, { className: 'tag' })
        chip.addEventListener('click', () => {
          const key = chip.dataset.key
          const selected = state.selectedTags.some((value) => value.toLocaleLowerCase() === key)
          state.selectedTags = selected
            ? state.selectedTags.filter((value) => value.toLocaleLowerCase() !== key)
            : [...state.selectedTags, chip.textContent]
          update()
        })
        return chip
      },
      (chip, tag) => {
        const selected = state.selectedTags.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())
        setText(chip, tag)
        setClass(chip, `tag ${selected ? 'tag--selected' : ''}`)
        chip.setAttribute('aria-pressed', String(selected))
      })

    const hasResults = model.allCourses.length > 0
    courseList.hidden = !hasResults
    noMatches.hidden = hasResults
    reconcileList(courseList, model.allCourses, (card) => card.course.id, createCourseRow, updateCourseRow)
  }
}

function createContinueCard() {
  const media = h('div', { className: 'course-card__media' })
  const title = h('div', { className: 'course-card__title' })
  const tags = h('div', { className: 'tags' })
  const lesson = h('div', { className: 'course-card__lesson' })
  const bar = progressBar(0)
  const counts = h('div', { className: 'course-card__progress' }, h('span'), h('strong'))
  const link = h('a', { className: 'button button--primary', text: '▶ Continue' })
  const card = h('article', { className: 'card course-card' }, media,
    h('div', { className: 'course-card__body' }, title, tags, lesson, bar, counts, link))
  card._parts = { media, title, tags, lesson, bar, counts, link }
  return card
}

function updateContinueCard(card, { course, progress, current }) {
  const p = card._parts
  syncThumb(p.media, course)
  setText(p.title, course.title)
  reconcileList(p.tags, (course.tags ?? []).slice(0, 4), (tag) => tag,
    () => h('span', { className: 'tag' }), (node, tag) => setText(node, tag))
  setText(p.lesson, current?.title ?? (current ? `Video ${current.videoId.slice(0, 8)}` : 'No active lesson'))
  p.bar.update(progress.percent, `${course.title}: ${progress.percent}% complete`)
  setText(p.counts.children[0], `${progress.watched} / ${progress.active} watched`)
  setText(p.counts.children[1], `${progress.percent}%`)
  p.link.href = `#/course/${encodeURIComponent(course.id)}${current ? `?video=${encodeURIComponent(current.videoId)}` : ''}`
}

function createCourseRow() {
  const thumb = h('div', { className: 'course-row__thumb' })
  const title = h('div', { className: 'course-row__title' })
  const meta = h('div', { className: 'course-row__meta' })
  const bar = progressBar(0)
  const caption = h('span', { className: 'small muted' })
  const open = h('a', { className: 'button button--secondary button--small' })
  const row = h('article', { className: 'card course-row' }, thumb,
    h('div', { className: 'course-row__main' }, title, meta),
    h('div', { className: 'course-row__progress' }, bar, caption),
    h('div', { className: 'course-row__actions' }, open))
  row._parts = { thumb, title, meta, bar, caption, open }
  return row
}

function updateCourseRow(row, { course, progress }) {
  const p = row._parts
  syncThumb(p.thumb, course, false)
  setText(p.title, course.title)
  const metaItems = [...(course.tags ?? []).slice(0, 4).map((tag) => ({ kind: 'tag', text: tag }))]
  if (course.authorName) metaItems.push({ kind: 'author', text: course.authorName })
  reconcileList(p.meta, metaItems, (item) => `${item.kind}:${item.text}`,
    (item) => h('span', { className: item.kind === 'tag' ? 'tag' : '' }),
    (node, item) => setText(node, item.text))
  p.bar.update(progress.percent, `${course.title}: ${progress.percent}% complete`)
  setText(p.caption, `${progress.watched} / ${progress.active} · ${progress.percent}%`)
  p.open.href = `#/course/${encodeURIComponent(course.id)}`
  setText(p.open, progress.percent === 100 ? 'Review' : 'Open')
}

function syncThumb(host, course, placeholder = true) {
  const wanted = course.thumbnailVideoId ?? ''
  if (host.dataset.thumb === wanted) return
  host.dataset.thumb = wanted
  host.replaceChildren()
  if (wanted) host.append(thumbnailImg(wanted, ''))
  else if (placeholder) host.append(h('div', { className: 'player-placeholder', text: 'YouTube course' }))
}
