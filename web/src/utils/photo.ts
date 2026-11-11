// Copied from QuestRush (src/utils/photo.ts).
import { MAX_PHOTO_LENGTH, PHOTO_QUALITIES, PHOTO_SIZE_PX } from '../config'

// Only small inline pictures: never a link to elsewhere, and never SVG, which can carry script.
const PHOTO_URL_PATTERN: RegExp = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export function isPhotoUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PHOTO_LENGTH && PHOTO_URL_PATTERN.test(value)
}

// Photos come from the sheet and the public script unchecked, so only a valid one is ever drawn.
export function shownPhoto(value: unknown): string | null {
  return isPhotoUrl(value) ? value : null
}

// Keeps the middle square of the picture, on white so a transparent PNG doesn't turn black as a JPEG.
export async function photoFromFile(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = PHOTO_SIZE_PX
    canvas.height = PHOTO_SIZE_PX
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('canvas 2d drawing is not available')
    }
    const side = Math.min(bitmap.width, bitmap.height)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, PHOTO_SIZE_PX, PHOTO_SIZE_PX)
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE_PX, PHOTO_SIZE_PX)
    for (const quality of PHOTO_QUALITIES) {
      const url = canvas.toDataURL('image/jpeg', quality)
      if (isPhotoUrl(url)) {
        return url
      }
    }
  } finally {
    bitmap.close()
  }
  throw new Error(`the photo is still over ${MAX_PHOTO_LENGTH} characters after shrinking`)
}
