import { CalendarDays, MapPin } from 'lucide-react'
import type { Event } from '../types'
import { CategoryIcon } from './CategoryIcon'

interface Props {
  event: Event
  isTopPick: boolean
  activeTags: string[]
  onTagClick: (tag: string) => void
}

export default function EventCard({ event, isTopPick, activeTags, onTagClick }: Props) {
  const free = (event.cost || '').toLowerCase() === 'free'

  const classes = [
    'card',
    isTopPick ? 'top-pick' : '',
    event.image ? 'has-image' : '',
  ].filter(Boolean).join(' ')

  const style = event.image
    ? ({ '--event-image': `url('${event.image}')` } as React.CSSProperties)
    : undefined

  return (
    <article className={classes} style={style}>
      <div className="card-top">
        <span className="card-cat">
          <CategoryIcon name={event.category} size={11} strokeWidth={2.2} />
          {event.category}
        </span>
        <span className={`card-cost${free ? ' free' : ''}`}>
          {free ? 'free' : (event.cost || '—')}
        </span>
      </div>
      <h3 className="card-title">
        {isTopPick && <em className="top-mark">✦</em>}
        {event.link
          ? <a href={event.link} target="_blank" rel="noopener">{event.title}</a>
          : event.title
        }
      </h3>
      <div className="card-meta">
        <span className="meta-row">
          <CalendarDays size={11} strokeWidth={2.2} />
          {event.datetime || '—'}
        </span>
        <span className="meta-row">
          <MapPin size={11} strokeWidth={2.2} />
          {event.location || '—'}
        </span>
      </div>
      {event.description && <p className="card-desc">{event.description}</p>}
      {event.tags && event.tags.length > 0 && (
        <div className="card-tags">
          {event.tags.slice(0, 5).map(tag => (
            <button
              key={tag}
              className={`tag tag-btn${activeTags.includes(tag) ? ' active' : ''}`}
              onClick={() => onTagClick(tag)}
              aria-pressed={activeTags.includes(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}
