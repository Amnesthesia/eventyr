export interface Event {
  title: string
  datetime: string
  location: string
  link: string
  category: string
  cost: string
  source: string
  description: string
  tags: string[]
  score: number
  datetime_iso: string
  datetime_end_iso: string
  image: string
}

export interface City {
  key: string
  name: string
  week_start: string
  week_end: string
  event_count: number
  top_pick_count: number
}

export interface CityIndex {
  generated_at: string
  cities: City[]
}

export interface DateRange {
  start: string
  end: string
}

export interface CityData {
  city: string
  city_key: string
  week_start: string
  week_end: string
  generated_at: string
  events: Event[]
}
