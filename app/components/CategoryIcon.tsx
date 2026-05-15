import { BookOpen, Wrench, Music, Users, Palette, Compass } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'

const ICON_RULES: Array<[RegExp, ComponentType<LucideProps>]> = [
  [/lecture|talk|seminar|forum|public/i, BookOpen],
  [/workshop|class|course|training|learn/i, Wrench],
  [/concert|music|band|gig|live/i, Music],
  [/social|meetup|networking/i, Users],
  [/art|exhibition|gallery|film|cinema|theatre|festival/i, Palette],
]

export function getIcon(name: string): ComponentType<LucideProps> {
  for (const [pattern, icon] of ICON_RULES) {
    if (pattern.test(name)) return icon
  }
  return Compass
}

export function CategoryIcon({ name, ...props }: { name: string } & LucideProps) {
  const Icon = getIcon(name)
  return <Icon {...props} />
}
