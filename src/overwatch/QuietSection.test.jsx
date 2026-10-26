import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import QuietSection from "./QuietSection";
import { noteLastUse, quietApps } from "./quietModel";
import { APP_ICONS } from "../apps/AppIcon";

const TODAY = "2026-10-26";
const toDay = (iso) => iso.slice(0, 10);
const APPS = [
  { id: "warren_buffet", name: "Warren Buffet", icon: "Wallet", path: "/money" },
  { id: "jobs", name: "Jobs", icon: "Briefcase", path: null },
  { id: "sam", name: "Sam", icon: "Music", path: "/sam" },
  { id: "ken", name: "Ken", icon: "GraduationCap", path: null },
];
const PROFILES = [
  { app_id: "warren_buffet", rhythm_days: 7 }, { app_id: "jobs", rhythm_days: 7 },
  { app_id: "sam", rhythm_days: 3 }, { app_id: "ken", rhythm_days: 7 }, { app_id: "timer", rhythm_days: null },
];
const NOTE = { for_date: "2026-10-25", flags: { quiet_apps: [
  { app: "jobs", days_since: 10, rhythm_days: 7 }, { app: "ken", days_since: "none", rhythm_days: 7 },
  { app: "warren_buffet", last_used_on: "2026-10-23", rhythm_days: 7 },
] } };

const rows = (over = {}) => quietApps({ profiles: PROFILES, lastActivity: [{ app_id: "sam", last_occurred_at: "2026-10-12T15:00:00Z" }],
  note: NOTE, watch: [], today: TODAY, toDay, ...over });

test("the note's flag gives a last-use date: a day count, or last_used_on", () => {
  expect(noteLastUse({ days_since: 10 }, "2026-10-25")).toBe("2026-10-15");
  expect(noteLastUse({ last_used_on: "2026-10-23" }, "2026-10-25")).toBe("2026-10-23");
  expect(noteLastUse({ days_since: "none" }, "2026-10-25")).toBeNull();
});

test("past rhythm only, quietest first; no rhythm, on rhythm and eased-off apps are left out", () => {
  expect(rows().map((r) => [r.appId, r.days, r.red])).toEqual([
    ["ken", null, false], ["sam", 14, true], ["jobs", 11, false],
  ]);
  const eased = rows({ watch: [{ kind: "ease_off", app_id: "sam", starts_on: "2026-10-20", ends_on: null }] });
  expect(eased.map((r) => r.appId)).toEqual(["ken", "jobs"]);
});

test("the newer of the view and the note wins", () => {
  const r = rows({ lastActivity: [{ app_id: "jobs", last_occurred_at: "2026-10-24T10:00:00Z" }] });
  expect(r.find((x) => x.appId === "jobs")).toBeUndefined();
});

const renderSection = (r = rows()) => render(<MemoryRouter><QuietSection rows={r} apps={APPS} /></MemoryRouter>);

test("rows: 'Jobs (11 days)', red at twice the rhythm, a real link when the app has a screen", () => {
  renderSection();
  expect(screen.getByRole("heading", { name: "Ken" })).toBeInTheDocument();
  expect(screen.getByText("No activity yet · rhythm 7 days")).toBeInTheDocument();
  expect(screen.getByText("Jobs (11 days)")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Jobs (11 days)" })).not.toBeInTheDocument();
  const sam = screen.getByRole("link", { name: "Sam (14 days)" });
  expect(sam).toHaveAttribute("href", "/sam");
  expect(sam.className).toContain("after:inset-0");
  expect(sam.className).toContain("text-destructive");
  expect(screen.getByText("Last used Oct 12 · rhythm 3 days")).toBeInTheDocument();
});

test("warren_buffet shows as Money and links to /money", () => {
  renderSection(quietApps({ profiles: [{ app_id: "warren_buffet", rhythm_days: 1 }], note: NOTE, today: TODAY, toDay }));
  expect(screen.getByRole("link", { name: "Money (3 days)" })).toHaveAttribute("href", "/money");
});

test("the copy: app id, link, last use, rhythm, the question", async () => {
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue() } });
  renderSection(rows().filter((r) => r.appId === "sam"));
  fireEvent.click(screen.getByRole("button", { name: "Copy quiet app for an Overwatch chat" }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe([
    "Overwatch: quiet app — Sam", "Last used Oct 12", "Rhythm: every 3 days", "Days since: 14",
    "app_id: sam", "https://alfredv5vibe.vercel.app/sam", "", "Is Sam still something I want to keep up with?",
  ].join("\n"));
});

test("every app's icon is bundled, the three new ones included", () => {
  for (const name of ["Cable", "Sprout", "Trophy", "TowerControl", "Wallet", "Music"]) expect(APP_ICONS[name]).toBeTruthy();
});

test("empty", () => {
  renderSection([]);
  expect(screen.getByText("Every app is on rhythm.")).toBeInTheDocument();
});
