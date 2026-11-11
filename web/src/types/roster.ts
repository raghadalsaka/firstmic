/** A student as everyone on the class page sees them. */
export interface PublicStudent {
  id: string
  name: string
  emoji: string
  photo: string | null
}

/** The teacher's view adds the PIN they hand out. */
export interface RosterStudent extends PublicStudent {
  pin: string
}

export interface NewStudent {
  name: string
  emoji: string
  // Left out, the server makes a random unused PIN.
  pin?: string
  photo?: string | null
}
