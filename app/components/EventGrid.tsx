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
