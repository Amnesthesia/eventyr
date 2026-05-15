import type { Event, DateRange } from '../types'
import { parseEndDate } from '../utils/dates'
import EventCard from './EventCard'

interface Props {
  events: Event[]
  isTopPick: boolean
  activeCat: string
  dateRange: DateRange | null
  activeTags: string[]
  onTagClick: (tag: string) => void
}

export default function EventGrid({ events, isTopPick, activeCat, dateRange, activeTags, onTagClick }: Props) {
  const filtered = events.filter(event => {
    const catOk = activeCat === 'All' || event.category === activeCat

    const dateOk = (() => {
      if (!dateRange) return true
      if (!event.datetime_iso) return false
      const eventStart = event.datetime_iso.slice(0, 10)
      const eventEnd = parseEndDate(event.datetime || '', event.datetime_iso) || eventStart
      return eventStart <= dateRange.end && eventEnd >= dateRange.start
    })()

    const tagsOk = activeTags.length === 0 ||
      activeTags.every(tag => (event.tags || []).includes(tag))

    return catOk && dateOk && tagsOk
  })

  return (
    <div className="card-grid">
      {filtered.map(event => (
        <EventCard
          key={event.title + event.datetime_iso}
          event={event}
          isTopPick={isTopPick}
          activeTags={activeTags}
          onTagClick={onTagClick}
        />
      ))}
    </div>
  )
}
