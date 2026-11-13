import type { StudioRow } from "./db.js";

/** Students can submit or change their submission until the class deadline, if it has one. */
export function submissionsOpen(studio: Pick<StudioRow, "submission_deadline">): boolean {
  return studio.submission_deadline == null || Date.now() <= studio.submission_deadline;
}
