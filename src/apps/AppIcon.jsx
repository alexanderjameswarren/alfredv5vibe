import React from "react";
import {
  BookOpen,
  Briefcase,
  Cable,
  Car,
  Disc3,
  Dumbbell,
  Gamepad2,
  GraduationCap,
  Hammer,
  House,
  LayoutGrid,
  Music,
  Sprout,
  Ticket,
  Timer,
  TowerControl,
  Trophy,
  Wallet,
  Wrench,
} from "lucide-react";

// apps.icon holds a lucide name; only the names the apps rows use are bundled (116, Overwatch's,
// Switchboard, Monty Don and Sports from 2026-10-26, and Homer, Guy and Wall-E from 181).
export const APP_ICONS = {
  BookOpen,
  Briefcase,
  Cable,
  Car,
  Disc3,
  Dumbbell,
  Gamepad2,
  GraduationCap,
  Hammer,
  House,
  Music,
  // Overwatch's row said Radar until migration 178; Alex chose TowerControl.
  Radar: TowerControl,
  Sprout,
  Ticket,
  TowerControl,
  Timer,
  Trophy,
  Wallet,
  Wrench,
};

/** An app's glyph by its apps.icon name; an unknown name falls back to a grid. */
export default function AppIcon({ icon, className = "w-4 h-4" }) {
  const Glyph = APP_ICONS[icon] || LayoutGrid;
  return <Glyph className={className} aria-hidden="true" />;
}
