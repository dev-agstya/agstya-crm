import { beforeEach, describe, expect, it } from "vitest";
import {
  recordSessionNotification, useSessionNotifications,
} from "./sessionNotifications";

const reset = () => useSessionNotifications.setState({ items: [] });
const items = () => useSessionNotifications.getState().items;

describe("sessionNotifications", () => {
  beforeEach(reset);

  it("records a toast as a session notification", () => {
    recordSessionNotification("success", "Policy created.");
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      kind: "success", title: "Policy created.", is_read: false, local: true,
    });
  });

  it("skips trivial acknowledgements (Saved / Copied)", () => {
    recordSessionNotification("success", "Saved.");
    recordSessionNotification("info", "Copied");
    recordSessionNotification("success", "saved");
    expect(items()).toHaveLength(0);
  });

  it("newest first", () => {
    recordSessionNotification("info", "First");
    recordSessionNotification("info", "Second");
    expect(items().map((n) => n.title)).toEqual(["Second", "First"]);
  });

  it("markRead / markAllRead / remove work locally", () => {
    recordSessionNotification("error", "Boom one");
    recordSessionNotification("error", "Boom two");
    const [a, b] = items();
    useSessionNotifications.getState().markRead(a.id);
    expect(items().find((n) => n.id === a.id)?.is_read).toBe(true);
    expect(items().find((n) => n.id === b.id)?.is_read).toBe(false);
    useSessionNotifications.getState().markAllRead();
    expect(items().every((n) => n.is_read)).toBe(true);
    useSessionNotifications.getState().remove(a.id);
    expect(items().map((n) => n.id)).not.toContain(a.id);
  });
});
