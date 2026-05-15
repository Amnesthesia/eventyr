import { useState, useEffect } from 'react'
import type { DateRange } from './types'
import { useColorTheme } from './hooks/useColorTheme'
import { useCity } from './hooks/useCity'
import { useEvents } from './hooks/useEvents'
import Header from './components/Header'
import FilterBar from './components/FilterBar'
import EventGrid from './components/EventGrid'

export default function App() {
  const { theme, toggle: toggleTheme } = useColorTheme()
  const { cities, cityKey, setCity } = useCity()
  const { cityData, picks, rest, loading, error } = useEvents(cityKey)

  const [activeCat, setActiveCat] = useState<string>('All')
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [activeTags, setActiveTags] = useState<string[]>([])

  // Reset filters when city changes
  useEffect(() => {
    setActiveCat('All')
    setDateRange(null)
    setActiveTags([])
  }, [cityKey])

  function toggleTag(tag: string) {
    setActiveTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
  }

  const categories = [...new Set(rest.map(e => e.category).filter(Boolean))]

  return (
    <>
      <Header
        cities={cities}
        cityKey={cityKey}
        cityData={cityData}
        theme={theme}
        onCityChange={setCity}
        onThemeToggle={toggleTheme}
      />
      <main>
        {loading && (
          <div className="state">
            <h2>loading…</h2>
          </div>
        )}
        {error && (
          <div className="state">
            <h2>{error}</h2>
            <p>check back after the next monday run</p>
          </div>
        )}
        {!loading && !error && cityData && (
          <>
            <FilterBar
              categories={categories}
              activeCat={activeCat}
              dateRange={dateRange}
              activeTags={activeTags}
              weekStart={cityData.week_start}
              weekEnd={cityData.week_end}
              onCatChange={setActiveCat}
              onDateChange={setDateRange}
              onTagRemove={toggleTag}
            />
            {picks.length > 0 && (
              <div id="top-picks-section">
                <div className="section-label">picks</div>
                <EventGrid
                  events={picks}
                  isTopPick={true}
                  activeCat={activeCat}
                  dateRange={dateRange}
                  activeTags={activeTags}
                  onTagClick={toggleTag}
                />
              </div>
            )}
            <div className="section-label">all events</div>
            <div className="separator" />
            <EventGrid
              events={rest}
              isTopPick={false}
              activeCat={activeCat}
              dateRange={dateRange}
              activeTags={activeTags}
              onTagClick={toggleTag}
            />
          </>
        )}
      </main>
    </>
  )
}
