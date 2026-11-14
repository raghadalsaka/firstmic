import { z } from "zod";

// One list drives the API keys and the topics columns (guide_<key>), so the two can't fall out of order.
const GUIDE_KEYS = ["prompt", "solo", "partner", "language"] as const;
type GuideKey = (typeof GUIDE_KEYS)[number];

/** The teacher's optional Podcast Guide for a topic; null where a section has no text. */
export type TopicGuide = Record<GuideKey, string | null>;

export type TopicGuideColumns = { [K in GuideKey as `guide_${K}`]: string | null };

export const TOPIC_GUIDE_COLUMNS: string = GUIDE_KEYS.map((key) => `guide_${key}`).join(", ");

export const TOPIC_GUIDE_ASSIGNMENTS: string = GUIDE_KEYS.map((key) => `guide_${key} = ?`).join(", ");

const MAX_GUIDE_SECTION_LENGTH = 2000;

// Line breaks are kept (questions and examples sit on their own lines); blank or missing text clears the section.
const guideSection = z
  .string()
  .max(MAX_GUIDE_SECTION_LENGTH)
  .nullish()
  .transform((value) => value?.replace(/\r\n?/g, "\n").trim() || null);

export const topicGuideSchema = z.object({
  prompt: guideSection,
  solo: guideSection,
  partner: guideSection,
  language: guideSection,
});

/** The values for TOPIC_GUIDE_COLUMNS or TOPIC_GUIDE_ASSIGNMENTS, in the same order. */
export function guideColumnValues(guide: TopicGuide): (string | null)[] {
  return GUIDE_KEYS.map((key) => guide[key]);
}

/** A topic row as the API sends it: the four guide columns folded into one guide object. */
export function withGuide<T extends TopicGuideColumns>(row: T): Omit<T, keyof TopicGuideColumns> & { guide: TopicGuide } {
  const { guide_prompt, guide_solo, guide_partner, guide_language, ...rest } = row;
  return { ...rest, guide: { prompt: guide_prompt, solo: guide_solo, partner: guide_partner, language: guide_language } };
}
