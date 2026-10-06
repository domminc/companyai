import type { User } from "./auth";

/** One open event stream. */
export interface Connection {
  user?: User;
  /** Writes one SSE frame. */
  send(frame: string): void;
  /** Ends the stream and stops its subscription. */
  close(): void;
}

export interface OnlineUser {
  id: string;
  displayName: string;
  role: User["role"];
}

/**
 * Who is here: one entry per open event stream. With login on, everyone online is shown to
 * everyone (and walks around the 3D office as a visitor).
 */
export class Presence {
  private conns = new Set<Connection>();

  private online(): OnlineUser[] {
    const seen = new Map<string, User>();
    for (const { user } of this.conns) if (user) seen.set(user.id, user);
    return [...seen.values()].map(({ id, displayName, role }) => ({ id, displayName, role }));
  }

  private broadcast() {
    this.announce({ type: "presence", online: this.online() });
  }

  add(conn: Connection) {
    this.conns.add(conn);
    this.broadcast();
  }

  remove(conn: Connection) {
    if (this.conns.delete(conn)) this.broadcast();
  }

  /** A changed name or role shows up at once. */
  refresh(user: User) {
    for (const conn of this.conns) if (conn.user?.id === user.id) conn.user = user;
    this.broadcast();
  }

  /** A removed account (or changed password) loses its live streams. */
  close(userId: string) {
    for (const conn of [...this.conns]) if (conn.user?.id === userId) conn.close();
  }

  closeAll() {
    for (const conn of [...this.conns]) conn.close();
  }

  /** Something every open app should hear about that isn't company state. */
  announce(data: unknown) {
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    for (const conn of this.conns) conn.send(frame);
  }
}
