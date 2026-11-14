import { db, type GroupTakeRow, type GroupTakeStatus, type SessionRow, type StudentRow, type TopicRow } from "./db.js";
import { newId, newToken } from "./ids.js";
import { newPin } from "./roster.js";
import { broadcast, connectedParticipantIds, disconnect } from "./rooms.js";
import { TOPIC_GUIDE_COLUMNS, withGuide, type TopicGuide, type TopicGuideColumns } from "./topic-guide.js";

/** Two-person podcasts: the student who creates the group and one partner. */
export const GROUP_SIZE = 2;

/** Takes the group is still working on; at most one exists at a time. */
const OPEN_TAKE_STATUSES: readonly GroupTakeStatus[] = ["recording", "mixing", "listening", "failed"];

export type GroupMember = {
  participantId: string;
  name: string;
  emoji: string | null;
  photo: string | null;
  online: boolean;
};

export type GroupSnapshot = {
  id: string;
  pin: string;
  topic: { id: string; title: string; guide: TopicGuide } | null;
  members: GroupMember[];
  take: {
    id: string;
    status: GroupTakeStatus;
    /** Who may Stop, Send or Try Again right now (see takeControllerId). */
    controllerId: string;
    startedAtMs: number;
    durationMs: number | null;
  } | null;
  sent: { takeId: string; version: number; durationMs: number | null; sentAt: number } | null;
};

export type GroupAccess = { groupId: string; token: string };

export type JoinResult =
  | { ok: true; access: GroupAccess; replacedGroupId: string | null }
  | { ok: false; status: number; error: string };

const OPEN_TAKE_SQL = `status IN (${OPEN_TAKE_STATUSES.map((status) => `'${status}'`).join(", ")})`;

export function getTake(takeId: string): GroupTakeRow | undefined {
  return db.prepare("SELECT * FROM group_takes WHERE id = ?").get(takeId) as GroupTakeRow | undefined;
}

export function openTake(sessionId: string): GroupTakeRow | null {
  const row = db
    .prepare(`SELECT * FROM group_takes WHERE session_id = ? AND ${OPEN_TAKE_SQL} ORDER BY created_at DESC LIMIT 1`)
    .get(sessionId) as GroupTakeRow | undefined;
  return row ?? null;
}

export function groupMembers(sessionId: string): GroupMember[] {
  const online = connectedParticipantIds(sessionId);
  const rows = db
    .prepare(
      `SELECT p.id AS participantId, COALESCE(stu.name, p.name) AS name, stu.emoji AS emoji, stu.photo AS photo
       FROM participants p
       LEFT JOIN students stu ON stu.id = p.student_id
       WHERE p.session_id = ?
       ORDER BY p.created_at, p.id`
    )
    .all(sessionId) as Omit<GroupMember, "online">[];
  return rows.map((row) => ({ ...row, online: online.has(row.participantId) }));
}

/** The student who started the take controls it; once they leave the call, their partner takes over so it can't get stuck. */
export function takeControllerId(take: GroupTakeRow, members: readonly GroupMember[]): string {
  const starter = members.find((member) => member.participantId === take.controller_id);
  if (starter?.online) {
    return take.controller_id;
  }
  return members.find((member) => member.participantId !== take.controller_id)?.participantId ?? take.controller_id;
}

export function groupSnapshot(sessionId: string): GroupSnapshot | null {
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND kind = 'group'")
    .get(sessionId) as SessionRow | undefined;
  if (!session) {
    return null;
  }
  const topic = db.prepare(`SELECT id, title, ${TOPIC_GUIDE_COLUMNS} FROM topics WHERE id = ?`).get(session.topic_id ?? "") as
    | (Pick<TopicRow, "id" | "title"> & TopicGuideColumns)
    | undefined;
  const members = groupMembers(session.id);
  const take = openTake(session.id);
  const sent = session.current_take_id ? getTake(session.current_take_id) : undefined;
  return {
    id: session.id,
    pin: session.group_pin ?? "",
    topic: topic ? withGuide(topic) : null,
    members,
    take: take
      ? {
          id: take.id,
          status: take.status,
          controllerId: takeControllerId(take, members),
          startedAtMs: take.created_at,
          durationMs: take.duration_ms,
        }
      : null,
    sent:
      sent && sent.version !== null && sent.sent_at !== null
        ? { takeId: sent.id, version: sent.version, durationMs: sent.duration_ms, sentAt: sent.sent_at }
        : null,
  };
}

/** Pushes the group's current state to both members' open connections. */
export function broadcastGroup(sessionId: string): void {
  const group = groupSnapshot(sessionId);
  if (group) {
    broadcast(sessionId, { t: "group", group });
  }
}

function membership(studentId: string, topicId: string): (GroupAccess & { members: number }) | null {
  const row = db
    .prepare(
      `SELECT s.id AS groupId, p.token AS token,
         (SELECT COUNT(*) FROM participants WHERE session_id = s.id) AS members
       FROM sessions s
       INNER JOIN participants p ON p.session_id = s.id AND p.student_id = ?
       WHERE s.kind = 'group' AND s.topic_id = ?`
    )
    .get(studentId, topicId) as (GroupAccess & { members: number }) | undefined;
  return row ?? null;
}

function addMember(sessionId: string, student: StudentRow): string {
  const token = newToken();
  db.prepare(
    "INSERT INTO participants (id, session_id, student_id, name, role, token, created_at) VALUES (?, ?, ?, ?, 'guest', ?, ?)"
  ).run(newId(), sessionId, student.id, student.name, token, Date.now());
  return token;
}

/** The student's group for the topic, created with them as its first member if they have none. */
export const getOrCreateGroup = db.transaction(
  (studioId: string, student: StudentRow, topic: TopicRow): GroupAccess & { created: boolean } => {
    const existing = membership(student.id, topic.id);
    if (existing) {
      return { groupId: existing.groupId, token: existing.token, created: false };
    }
    const pins = db
      .prepare("SELECT group_pin FROM sessions WHERE studio_id = ? AND group_pin IS NOT NULL")
      .all(studioId) as { group_pin: string }[];
    const groupId = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id, studio_id, title, status, invite_token, created_at, kind, topic_id, group_pin)
       VALUES (?, ?, ?, 'live', ?, ?, 'group', ?, ?)`
    ).run(
      groupId,
      studioId,
      `${topic.title} (group)`,
      newToken(),
      now,
      topic.id,
      newPin(new Set(pins.map((row) => row.group_pin)))
    );
    return { groupId, token: addMember(groupId, student), created: true };
  }
);

/**
 * Adds the student as the second member of the class group with this PIN. A full group refuses everyone else.
 * A group the student started for the same topic that nobody joined yet is dropped, so they can join a friend's instead.
 */
const joinTransaction = db.transaction((studioId: string, student: StudentRow, pin: string): JoinResult => {
  const group = db
    .prepare(
      `SELECT s.* FROM sessions s
       INNER JOIN topics t ON t.id = s.topic_id AND t.active = 1
       WHERE s.studio_id = ? AND s.kind = 'group' AND s.group_pin = ?`
    )
    .get(studioId, pin) as SessionRow | undefined;
  if (!group?.topic_id) {
    return { ok: false, status: 404, error: "No group has that PIN. Check it with your partner." };
  }
  const mine = db
    .prepare("SELECT token FROM participants WHERE session_id = ? AND student_id = ?")
    .get(group.id, student.id) as { token: string } | undefined;
  if (mine) {
    return { ok: true, access: { groupId: group.id, token: mine.token }, replacedGroupId: null };
  }
  const members = (db.prepare("SELECT COUNT(*) AS n FROM participants WHERE session_id = ?").get(group.id) as { n: number }).n;
  if (members >= GROUP_SIZE) {
    return { ok: false, status: 409, error: "This group is full. Only two people can record together." };
  }
  const other = membership(student.id, group.topic_id);
  if (other && other.members > 1) {
    return { ok: false, status: 409, error: "You already have a partner for this topic." };
  }
  if (other) {
    // Nobody joined it, and recording needs both members, so it has no takes or files.
    db.prepare("DELETE FROM sessions WHERE id = ?").run(other.groupId);
  }
  return { ok: true, access: { groupId: group.id, token: addMember(group.id, student) }, replacedGroupId: other?.groupId ?? null };
});

export function joinGroup(studioId: string, student: StudentRow, pin: string): JoinResult {
  const result = joinTransaction(studioId, student, pin);
  if (result.ok) {
    if (result.replacedGroupId) {
      disconnect(result.replacedGroupId);
    }
    broadcastGroup(result.access.groupId);
  }
  return result;
}
