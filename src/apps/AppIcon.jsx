import React from "react";
import {
  Briefcase,
  Cable,
  Car,
  Disc3,
  Dumbbell,
  Gamepad2,
  GraduationCap,
  House,
  LayoutGrid,
  Music,
  Sprout,
  Timer,
  TowerControl,
  Trophy,
  Wallet,
  Wrench,
} from "lucide-react";

// apps.icon holds a lucide name; only the names the apps rows use are bundled (116, Overwatch's,
// and Switchboard, Monty Don and Sports from 2026-10-26).
export const APP_ICONS = {
  Briefcase,
  Cable,
  Car,
  Disc3,
  Dumbbell,
  Gamepad2,
  GraduationCap,
  House,
  Music,
  // Overwatch's row said Radar until migration 178; Alex chose TowerControl.
  Radar: TowerControl,
  Sprout,
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
