// An app's name as Alex sees it: its tab name where that differs from the apps list.
const TAB_NAMES = { warren_buffet: "Money" };

function humanize(id) {
  const words = String(id).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Money" for warren_buffet, else the apps list name, else the id in words. */
export function appDisplayName(id, appNames = {}) {
  return TAB_NAMES[id] || appNames[id] || humanize(id);
}
