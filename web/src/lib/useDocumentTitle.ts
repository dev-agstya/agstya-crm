import { useEffect } from "react";

export const APP_NAME = "Agastya";

/**
 * Sets the browser-tab title while the calling component is mounted.
 *
 * ONE owner for document.title. It used to be derived in AppLayout from the nav
 * config, which meant any page not in the nav — a detail view, 404, onboarding —
 * inherited whatever the last matched page was, and a page could not name its
 * own tab. Now the page that draws the heading also names the tab, and the
 * layout stays out of it (two effects both writing document.title race on every
 * navigation, and the parent's runs last, so the layout always won).
 *
 * Pass an empty string to leave the title alone (e.g. while data is loading and
 * the real name is not known yet).
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} | ${APP_NAME}`;
    return () => { document.title = previous; };
  }, [title]);
}
