import { useState, useEffect } from 'react'
import type { CityData } from '../types'
import { TOP_PICK_THRESHOLD } from '../constants'
import { cacheBust } from '../utils/dates'

export function useEvents(cityKey: string) {
  const [cityData, setCityData] = useState<CityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cityKey) return
    setLoading(true)
    setError(null)
    setCityData(null)

    fetch(`data/${cityKey}.json?v=${cacheBust()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: CityData) => {
        data.events.sort((a, b) => (b.score || 0) - (a.score || 0))
        setCityData(data)
        document.title = `${data.city} — do things`
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(`could not load events for "${cityKey}": ${err.message}`)
        setLoading(false)
      })
  }, [cityKey])

  const picks = cityData
    ? cityData.events.filter((e, i) => (e.score || 0) >= TOP_PICK_THRESHOLD && i < 9)
    : []
  const rest = cityData
    ? cityData.events.filter((e, i) => (e.score || 0) < TOP_PICK_THRESHOLD || i >= 9)
    : []

  return { cityData, picks, rest, loading, error }
}
