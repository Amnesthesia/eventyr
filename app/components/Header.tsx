import { Sun, Moon, Calendar } from 'lucide-react'
import type { City, CityData } from '../types'
import { fmtRange } from '../utils/dates'

interface Props {
  cities: City[]
  cityKey: string
  cityData: CityData | null
  theme: 'light' | 'dark'
  onCityChange: (key: string) => void
  onThemeToggle: () => void
}

export default function Header({ cities, cityKey, cityData, theme, onCityChange, onThemeToggle }: Props) {
  const meta = cityData
    ? `${fmtRange(cityData.week_start, cityData.week_end)} · ${cityData.events.length} events`
    : 'loading…'

  return (
    <header>
      <span className="site-name">&gt;&nbsp;do things</span>
      <span className="header-meta">{meta}</span>
      <div className="header-controls">
        {cities.length > 1 && (
          <select
            className="city-select"
            value={cityKey}
            onChange={e => onCityChange(e.target.value)}
          >
            {cities.map(c => (
              <option key={c.key} value={c.key}>
                {c.name.split(',')[0]}
              </option>
            ))}
          </select>
        )}
        {cityKey && (
          <a
            className="theme-btn"
            href={`${cityKey}.ics`}
            download
            aria-label="Subscribe to calendar"
            title="Download calendar (.ics)"
          >
            <Calendar size={12} strokeWidth={2} />
          </a>
        )}
        <button className="theme-btn" aria-label="Toggle dark mode" onClick={onThemeToggle}>
          {theme === 'dark' ? <Sun size={12} strokeWidth={2} /> : <Moon size={12} strokeWidth={2} />}
        </button>
      </div>
    </header>
  )
}
